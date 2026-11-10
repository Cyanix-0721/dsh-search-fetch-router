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
   * 按当前游标顺序列出可用的引用名：跳过永久失效、跳过仍在冷却的。
   * @param now - 当前时间戳（毫秒），测试可注入。
   * @returns 引用名数组，可能为空。
   */
  candidates(now = Date.now()) {
    const live = this.refs.filter((ref) => !this.dead.has(ref) && (this.cooldowns.get(ref) ?? 0) <= now);
    if (live.length === 0) return [];
    // 从游标处开始，绕一圈，保持配置顺序作为相对次序
    const start = this.cursor % this.refs.length;
    const ordered = [...this.refs.slice(start), ...this.refs.slice(0, start)];
    return ordered.filter((ref) => live.includes(ref));
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
   * @param ref - 失败的引用名。
   * @param error - 失败原因。
   * @param now - 当前时间戳（毫秒）。
   * @returns `'dead'` 或 `'cooldown'`。
   */
  penalize(ref, error, now = Date.now()) {
    if (isPermanentInvalid(error)) {
      this.dead.add(ref);
      return 'dead';
    }
    this.cooldowns.set(ref, now + this.cooldownMs);
    return 'cooldown';
  }

  /**
   * 逐个解析出「引用名 + 值」，跳过解析不到的（未配置的引用名不该被当成失败，
   * 它只是没填）。
   * @param now - 当前时间戳（毫秒）。
   * @returns `{ref, value}` 数组。
   */
  async resolvedCandidates(now = Date.now()) {
    const out = [];
    for (const ref of this.candidates(now)) {
      let value;
      try {
        value = await this.resolve(ref);
      } catch {
        // 引用名语法不合法等：当作没配，不惩罚
        continue;
      }
      if (typeof value === 'string' && value.length > 0) out.push({ ref, value });
    }
    return out;
  }

  /** 池里是否有任何一把可能可用（不解析值，不发网络）。 */
  hasAnyConfigured() {
    return this.refs.some((ref) => !this.dead.has(ref));
  }
}
