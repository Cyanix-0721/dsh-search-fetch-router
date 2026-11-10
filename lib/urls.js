/**
 * URL 工具：校验与 glob 匹配。
 *
 * 白名单用 glob 而不是正则，理由是排查成本：正则写错了只会「不匹配」，用户看到
 * 的是「白名单没生效」，而不是一条语法错误；glob 的语义三行讲得完，且没有 ReDoS
 * 面。`*` 匹配不含 `/` 的一段，`**` 匹配任意字符（含 `/`）。
 *
 * @module dsh-search-fetch-router/urls
 */

/** URL 长度上限，与官方抓取提供方保持一致。 */
export const MAX_URL_LENGTH = 2048;

/**
 * 把 glob 编译成 `RegExp`。转义除 `*` 以外的所有正则元字符。
 * @param glob - glob 模式。
 * @returns 锚定的正则。
 */
export function globToRegExp(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/**
 * 判断 URL 是否命中任一 glob。匹配面是 `host + pathname`（不含协议、端口、查询串）。
 * 裸 host 模式同时匹配它的任意路径，因此 `example.com` 等价于 `example.com/**`。
 * @param url - 完整 URL 字符串。
 * @param patterns - glob 数组。
 * @returns 是否命中；空数组恒 false。
 */
export function matchesAnyPattern(url, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const target = `${parsed.host}${parsed.pathname}`;
  return patterns.some((pattern) => {
    const normalized = String(pattern).trim();
    if (normalized.length === 0) return false;
    if (globToRegExp(normalized).test(target)) return true;
    // 裸 host：`example.com` 命中 `example.com/anything`
    return !normalized.includes('/') && globToRegExp(`${normalized}/**`).test(target);
  });
}

/**
 * 校验一个待抓取的 URL，非法时抛错。错误码与官方抓取提供方一致，便于上层统一处理。
 * @param url - 待校验的 URL。
 * @param makeError - `(message, code) => Error`，用于构造错误。
 * @param maxLength - 长度上限。
 * @returns 解析后的 URL 对象。
 */
export function assertFetchableUrl(url, makeError, maxLength = MAX_URL_LENGTH) {
  if (typeof url !== 'string' || url.length === 0) {
    throw makeError('web fetch needs a non-empty url', 'WEB_INVALID_URL');
  }
  if (url.length > maxLength) {
    throw makeError(`URL exceeds the ${maxLength}-character limit`, 'WEB_INVALID_URL');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw makeError(`web fetch received an invalid URL: ${url}`, 'WEB_INVALID_URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw makeError(`web fetch only supports http and https, got ${parsed.protocol}`, 'WEB_INVALID_URL');
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw makeError('web fetch refuses a URL carrying embedded credentials', 'WEB_INVALID_URL');
  }
  return parsed;
}
