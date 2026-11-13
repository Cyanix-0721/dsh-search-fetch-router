/**
 * 错误包装。
 *
 * seam 只要求抛出的错误带一个 `code` 字段（`WebError extends HarnessError`），
 * 上层工具会把 code 放进结构化错误元数据。本插件所有自定义失败都从这里产生，
 * 保证 code 稳定、可路由。
 *
 * @module dsh-search-fetch-router/errors
 */

import { WebError } from '@deepseek-ai/dsh-web';

/** 本插件的错误码。加新码可以，改旧码不行：它们进结构化错误元数据，是外部契约。 */
export const CODES = Object.freeze({
  SEARCH_ALL_FAILED: 'WEB_SEARCH_ALL_PROVIDERS_FAILED',
  SEARCH_BUDGET_EXHAUSTED: 'WEB_SEARCH_BUDGET_EXHAUSTED',
  FETCH_ALL_FAILED: 'WEB_FETCH_ALL_PROVIDERS_FAILED',
  BUDGET_EXHAUSTED: 'WEB_FETCH_BUDGET_EXHAUSTED',
  INVALID_URL: 'WEB_INVALID_URL',
  INVALID_QUERY: 'WEB_INVALID_QUERY',
  ABORTED: 'WEB_ABORTED',
});

/**
 * 构造一个带 code 的错误。
 * @param message - 人类可读信息。
 * @param code - 稳定错误码。
 * @param cause - 被包装的原始错误。
 * @returns `WebError` 实例。
 */
export function webError(message, code, cause) {
  return new WebError(message, code, cause === undefined ? undefined : { cause });
}

/**
 * 把任意错误规整成 `WebError`。已经有 code 的原样返回，避免套娃。
 * @param error - 原始错误。
 * @param fallbackCode - 没有 code 时用的码。
 * @returns `WebError` 实例。
 */
export function asWebError(error, fallbackCode) {
  if (error instanceof WebError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return webError(message, fallbackCode, error instanceof Error ? error : undefined);
}

/**
 * 判断一个错误是不是「调用方取消」。
 * @param error - 待判断的错误。
 * @returns 是否为取消。
 */
export function isAbortError(error) {
  if (error === undefined || error === null) return false;
  if (typeof error === 'object' && error.code === CODES.ABORTED) return true;
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}
