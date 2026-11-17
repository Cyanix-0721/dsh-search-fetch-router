/**
 * 结果缓存：带 TTL 与 LRU 淘汰的内存缓存。
 *
 * **只在进程内**：存在 `createRouter` 的闭包里，DSH 重启即清空。这就是为什么不需要
 * 持久化、也不担心「永不过期」把磁盘撑爆——但反过来说，长期不重启的会话必须有 TTL，
 * 否则新闻/价格这类结果会一直返回旧的（见 config 的 cacheTtlMs 说明）。
 *
 * LRU 用 `Map` 的插入顺序实现：命中时删掉再插回末尾，于是 `keys().next()` 永远是最久
 * 未用的那条。淘汰按「条数」与「字节数」两个上限谁先触发算谁。
 *
 * @module dsh-search-fetch-router/cache
 */

/**
 * 估算一条值占多少字节（UTF-8）。JSON 序列化后用 `Buffer.byteLength` 取真实字节数——
 * 不能用 `text.length`，那是 UTF-16 码元数，中文一字约 3 字节，会把预算低估成三分之一。
 * 本文件只在 host（Node）侧被 `execute.js` 引用，`Buffer` 必然存在；浏览器里无 Buffer 时
 * 退回字符数，仅为防御。
 */
function estimateBytes(value) {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return 0;
    return typeof Buffer !== 'undefined' ? Buffer.byteLength(text, 'utf8') : text.length;
  } catch {
    // 循环引用等异常：当 0 处理，交给条数上限兜底。
    return 0;
  }
}

export class ResultCache {
  /** @type {Map<string, {value: unknown, expiresAt: number, bytes: number}>} */
  #map = new Map();

  #bytes = 0;

  /** 当前缓存的条数。 */
  get size() {
    return this.#map.size;
  }

  /** 当前缓存内容的估算总字节数。 */
  get bytes() {
    return this.#bytes;
  }

  #remove(key) {
    const entry = this.#map.get(key);
    if (entry === undefined) return;
    this.#map.delete(key);
    this.#bytes -= entry.bytes;
  }

  /**
   * 取一条。过期即删并返回 `undefined`；命中则移到 LRU 末尾。
   * @param key - 缓存键。
   * @param now - 当前时间戳（毫秒），便于测试注入。
   * @returns 命中的值，或 `undefined`。
   */
  get(key, now = Date.now()) {
    const entry = this.#map.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== 0 && entry.expiresAt <= now) {
      this.#remove(key);
      return undefined;
    }
    // LRU：删了再插回末尾，保持「最久未用在前」。
    this.#map.delete(key);
    this.#map.set(key, entry);
    return entry.value;
  }

  /**
   * 存一条，并按条数/字节上限淘汰。
   * @param key - 缓存键。
   * @param value - 要缓存的值（存引用，不做深拷贝；调用方自己决定是否 clone）。
   * @param options - `{ttlMs, maxEntries, maxBytes}`。
   *   `maxEntries <= 0` 直接不存（禁用）；`ttlMs <= 0` 视为永久（内部约定的哨兵 0）；
   *   `maxBytes <= 0` 表示不限字节。
   * @param now - 当前时间戳（毫秒）。
   */
  set(key, value, options = {}, now = Date.now()) {
    const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : 100;
    if (maxEntries <= 0) return;
    const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : 0;
    const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 0;
    const bytes = estimateBytes(value);

    // 同键旧值先删，避免重复计数。
    this.#remove(key);
    this.#map.set(key, { value, expiresAt: ttlMs > 0 ? now + ttlMs : 0, bytes });
    this.#bytes += bytes;

    while (this.#map.size > maxEntries || (maxBytes > 0 && this.#bytes > maxBytes)) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      this.#remove(oldest);
    }
  }

  /** 清空所有条目。 */
  clear() {
    this.#map.clear();
    this.#bytes = 0;
  }
}

/** 递归稳定序列化：对象键排序，保证同样的内容得到同样的字符串（缓存键要用）。 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',');
    return `{${body}}`;
  }
  const primitive = JSON.stringify(value);
  return primitive === undefined ? 'null' : primitive;
}

/**
 * 把一组影响结果的参数拼成稳定的缓存键。
 * @param parts - 任意可序列化的对象/数组。
 * @returns 稳定的字符串键。
 */
export function cacheSignature(parts) {
  return stableStringify(parts);
}

/**
 * 搜索的缓存键（纯函数，便于单测「改了任一相关配置，键必变」）。
 *
 * 务必把**所有影响结果内容**的参数都塞进来：漏一个，用户改了那项配置却仍命中旧结果。
 * 新增影响搜索结果的配置字段时，这里要同步加，`test/cache.test.js` 有逐字段守护。
 * @param params - `{ query, order, maxResults, maxResultsMode, maxSearchResults, exaSearchType, tavilySearchDepth, tavilyTopic, generation }`。
 */
export function buildSearchCacheKey(params = {}) {
  return cacheSignature({
    kind: 'search',
    query: typeof params.query === 'string' ? params.query.trim() : '',
    order: params.order,
    maxResults: params.maxResults,
    maxResultsMode: params.maxResultsMode,
    maxSearchResults: params.maxSearchResults,
    exaSearchType: params.exaSearchType,
    tavilySearchDepth: params.tavilySearchDepth,
    tavilyTopic: params.tavilyTopic,
    generation: params.generation,
  });
}

/**
 * 抓取的缓存键（纯函数）。同样要覆盖所有影响正文内容的配置字段。
 * @param params - `{ url, order, maxBodyChars, tavilyExtractDepth, minContentChars, firecrawlOnlyMainContent, firecrawlMaxAgeMs, generation }`。
 */
export function buildFetchCacheKey(params = {}) {
  return cacheSignature({
    kind: 'fetch',
    url: typeof params.url === 'string' ? params.url : '',
    order: params.order,
    maxBodyChars: params.maxBodyChars,
    tavilyExtractDepth: params.tavilyExtractDepth,
    minContentChars: params.minContentChars,
    firecrawlOnlyMainContent: params.firecrawlOnlyMainContent,
    firecrawlMaxAgeMs: params.firecrawlMaxAgeMs,
    generation: params.generation,
  });
}
