/**
 * 轻量 key 池：refs 数组 + 轮转 + 冷却 + 失效跳过。
 *
 * **为什么是 refs 而不是 records**：`credentials.listRecords()` 只枚举 records
 * （`<scope>/<id>`），不枚举 refs（环境变量名那半）。用「ref 命名约定」做池时插件
 * 无法知道有几把 key，所以**可枚举性来自配置里的数组**，而不是来自服务。
 * 好处是每把 key 仍能在设置页/环境变量里填，跨机手填自然成立。
 *
 * **不做的事**：不查 `/usage` 余额、不按余额排序、不存调用历史、不做跨月恢复探测。
 * 这些是 `dsh-tavily-pool` 那 3000 行的来源；本插件只要「一把不行换下一把」。
 *
 * @module dsh-search-fetch-router/keyring
 */

/**
 * 判断一个错误是否意味着这把 key 永久失效（而不是暂时性故障）。
 *
 * 401/403 单凭状态码不足以判定——同一个状态码也可能来自网关配置错误。所以还要求
 * 消息里出现明确的失效措辞，与 Tavily 自己的错误文案对齐。
 */
const PERMANENT_INVALID_PHRASES = Object.freeze([
  'invalid api key',
  'invalid api_key',
  'invalid key',
  'api key is invalid',
  'revoked',
  'deactivated',
  'suspended',
  'disabled',
  'expired',
  'deleted',
]);

/**
 * 从错误里读 HTTP 状态码。兼容 `status` / `statusCode` 两种挂法。
 * @param error - 待检查的错误。
 * @returns 状态码，读不到返回 `undefined`。
 */
export function statusOf(error) {
  const raw = error?.status ?? error?.statusCode;
  return Number.isInteger(raw) ? raw : undefined;
}

/** 限流时冷却放大倍数：429 是「先别来」，短冷却会让整条链在几百毫秒后又被同一把 key 撞上。 */
const RATE_LIMIT_COOLDOWN_FACTOR = 5;

/**
 * 额度耗尽时的冷却放大倍数。Tavily 用 432（key/套餐额度）与 433（PayGo 额度）表达
 * 「这把 key 这个周期用光了」。这不是限流也不是 key 失效：短冷却会让整条链每隔几分钟
 * 就去撞一次注定失败的请求，永久 dead 又太狠（额度可能当天恢复）。所以给一小时级别。
 */
const QUOTA_COOLDOWN_FACTOR = 60;

/** Retry-After 的信任上限：头部异常（或代理乱写）不该把一把 key 冻结几天。 */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** 超时类失败的冷却缩小倍数：只冷却一小段，别把「这次慢」当成「这把 key 坏了」。 */
export const TIMEOUT_COOLDOWN_DIVISOR = 5;

/** 超时冷却的下限毫秒数，避免除出一个等于没冷却的值。 */
const MIN_TIMEOUT_COOLDOWN_MS = 1_000;

/**
 * 判断错误是否来自限流（429 或明确措辞）。限流不是 key 坏了，只是这一刻太频繁，
 * 所以走更长的冷却而不是标记为永久失效。
 * @param error - 失败原因。
 * @returns 是否限流。
 */
export function isRateLimited(error) {
  if (statusOf(error) === 429) return true;
  const message = String(error?.message ?? '').toLowerCase();
  return message.includes('rate limit') || message.includes('too many requests');
}

/**
 * 判断错误是否表示「额度用光」而不是「key 坏了」。
 *
 * Tavily 专用：432 = key 限额或套餐限额超限，433 = PayGo 限额超限。两者都说明这把
 * key 本身有效，只是这个周期没钱了，所以既不进 `dead`，也不该按限流那么短的冷却重试。
 * @param error - 失败原因。
 * @returns 是否额度耗尽。
 */
export function isQuotaExhausted(error) {
  const status = statusOf(error);
  if (status === 432 || status === 433) return true;
  const message = String(error?.message ?? '').toLowerCase();
  return message.includes('exceeds your plan') || message.includes('pay-as-you-go limit');
}

/**
 * 判断失败是不是「这次慢」而不是「这把 key 坏了」。
 *
 * 本地 `AbortSignal.timeout` 触发时抛 `TimeoutError`；`postJson` 会把它包成普通 Error，
 * 所以那里同时打了 `timeout` 标记。上游自己的超时（408/504）走状态码。
 * 这类失败按默认冷却整把 key 不成比例——单 key 用户会因一次慢请求让唯一一把 key 停摆。
 * @param error - 失败原因。
 * @returns 是否超时类失败。
 */
export function isTimeout(error) {
  if (error === undefined || error === null) return false;
  if (error.timeout === true) return true;
  if (error.name === 'TimeoutError') return true;
  const status = statusOf(error);
  if (status === 408 || status === 504) return true;
  const message = String(error?.message ?? '').toLowerCase();
  return message.includes('timed out') || message.includes('timeout');
}

/**
 * 判断这把 key 是否已经废了。
 * @param error - 失败原因。
 * @returns 是否永久失效。
 */
export function isPermanentInvalid(error) {
  const status = statusOf(error);
  if (status !== 401 && status !== 403) return false;
  const message = String(error?.message ?? '').toLowerCase();
  return PERMANENT_INVALID_PHRASES.some((phrase) => message.includes(phrase));
}

/**
 * 一个按配置顺序轮转、失败即冷却的 key 池。
 *
 * 状态只活在内存里：进程重启后所有 key 重新可用。这是有意的——冷却是为了不在同一次
 * 会话里反复撞同一把失效 key，不是持久化的健康档案。
 */
export class KeyRing {
  /** 引用名列表，保持配置顺序。 */
  refs;
  /** 引用名 → 冷却截止时间戳（毫秒）。 */
  cooldowns = new Map();
  /** 永久失效的引用名。 */
  dead = new Set();
  /** 下次从哪个下标开始试。 */
  cursor = 0;
  /** 冷却时长（毫秒）。 */
  cooldownMs;
  /** 解析一个引用名 → 值（或 undefined）。 */
  resolve;

  /**
   * @param options - `{refs, resolve, cooldownMs}`。
   */
  constructor({ refs, resolve, cooldownMs }) {
    this.refs = Array.isArray(refs) ? refs.filter((ref) => typeof ref === 'string' && ref.length > 0) : [];
    this.resolve = resolve;
    this.cooldownMs = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : 60_000;
  }

  /**
   * 按给定起点列出可用的引用名：跳过永久失效、跳过仍在冷却的。
   * @param now - 当前时间戳（毫秒），测试可注入。
   * @param from - 起始下标；省略时用共享游标。
   * @returns 引用名数组，可能为空。
   */
  candidates(now = Date.now(), from = this.cursor) {
    const live = this.refs.filter((ref) => !this.dead.has(ref) && (this.cooldowns.get(ref) ?? 0) <= now);
    if (live.length === 0) return [];
    // 从起点绕一圈，保持配置顺序作为相对次序
    const start = this.refs.length === 0 ? 0 : from % this.refs.length;
    const ordered = [...this.refs.slice(start), ...this.refs.slice(0, start)];
    return ordered.filter((ref) => live.includes(ref));
  }

  /**
   * 领取一个「本次请求专用」的起始下标，并原子推进共享游标。
   *
   * **为什么需要**：`resolvedCandidates()` 原来直接读共享的 `this.cursor`。两个并发
   * 请求在同一把 `KeyRing` 上先后取快照，都从同一处开始，于是都打第一把 key——多 key
   * 池在并发下退化成单 key，其余 key 形同虚设，还更容易撞上供应商限流。
   * 每个请求领一个不同的起点，池才真的在分摊。
   * @returns 起始下标。
   */
  claim() {
    const length = this.refs.length;
    if (length === 0) return 0;
    const start = this.cursor % length;
    this.cursor = (start + 1) % length;
    return start;
  }

  /**
   * 把游标移到下一把，让下次从它之后开始——这样连续两次调用不会总撞同一把。
   * @param ref - 刚成功用掉的那把。
   */
  advance(ref) {
    const index = this.refs.indexOf(ref);
    if (index >= 0) this.cursor = (index + 1) % this.refs.length;
  }

  /**
   * 记录一次失败。永久失效进 `dead`，其余进冷却。
   *
   * 冷却时长优先级：上游给的 `Retry-After` > 额度耗尽（60×）> 限流（5×）> 默认。
   * 有 `Retry-After` 时以它为准，因为那是服务端自己说的、最准的等待时间。
   * @param ref - 失败的引用名。
   * @param error - 失败原因。
   * @param now - 当前时间戳（毫秒）。
   * @returns `'dead'`、`'quota'` 或 `'cooldown'`。
   */
  penalize(ref, error, now = Date.now()) {
    if (isPermanentInvalid(error)) {
      this.dead.add(ref);
      return 'dead';
    }
    const hinted = Number(error?.retryAfterMs);
    const hint = Number.isFinite(hinted) && hinted > 0 ? Math.min(hinted, MAX_RETRY_AFTER_MS) : 0;
    // 超时是「这次慢」，不是「这把 key 坏了」：给短冷却，别让一次慢请求冻结一把健康的 key。
    const base = isQuotaExhausted(error)
      ? this.cooldownMs * QUOTA_COOLDOWN_FACTOR
      : isRateLimited(error)
        ? this.cooldownMs * RATE_LIMIT_COOLDOWN_FACTOR
        : isTimeout(error)
          ? Math.max(Math.round(this.cooldownMs / TIMEOUT_COOLDOWN_DIVISOR), MIN_TIMEOUT_COOLDOWN_MS)
          : 0;
    // 上游明说等多久时以它为准；但「慢」不该被放大成一整轮冷却，所以超时类只取不超 base 的部分。
    const cooldown = Math.max(base, isTimeout(error) ? Math.min(hint, base) : hint) || this.cooldownMs;
    this.cooldowns.set(ref, now + cooldown);
    if (isQuotaExhausted(error)) return 'quota';
    return 'cooldown';
  }

  /**
   * 逐个解析出「引用名 + 值」，跳过解析不到的（未配置的引用名不该被当成失败，
   * 它只是没填）。
   * @param now - 当前时间戳（毫秒）。
   * @returns `{ref, value}` 数组。
   */
  async resolvedCandidates(now = Date.now(), from = this.cursor) {
    // 并行解析：凭据可能来自磁盘/远端服务，逐个 await 会把 N 把 key 的延迟叠加成 N 倍。
    // 结果按 `candidates()` 的原始顺序回填（Promise.all 保序），轮转次序不受影响。
    const resolved = await Promise.all(
      this.candidates(now, from).map(async (ref) => {
        try {
          const value = await this.resolve(ref);
          return typeof value === 'string' && value.length > 0 ? { ref, value } : undefined;
        } catch {
          // 引用名语法不合法等：当作没配，不惩罚
          return undefined;
        }
      }),
    );
    return resolved.filter((item) => item !== undefined);
  }

  /** 池里是否有任何一把可能可用（不解析值，不发网络）。 */
  hasAnyConfigured() {
    return this.refs.some((ref) => !this.dead.has(ref));
  }
}
