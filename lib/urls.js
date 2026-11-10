/**
 * URL 工具：抓取前的 URL 校验。
 *
 * @module dsh-search-fetch-router/urls
 */

/** URL 长度上限，与官方抓取提供方保持一致。 */
export const MAX_URL_LENGTH = 2048;

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
