/**
 * 官方回落：`deepseek-official` 搜索与本地 `http` 抓取。
 *
 * 这两条路的共同点是「宿主本来就有」，本插件不重新注册它们的命名空间，只构造实例
 * 直接用。**不得**重新 `installSection('web-search-deepseek')`——命名空间不可重复
 * 注册，它由内置包拥有。
 *
 * 配置读取方式：`settings.describe()` 找 `ns === 'web-search-deepseek'` 的条目
 * （settings 服务**没有** `get(ns)`）。读不到就退回环境变量与官方默认值，与官方包
 * 自己的 `resolveOptions` 同一套优先级。
 *
 * @module dsh-search-fetch-router/official
 */

import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import {
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DeepSeekSearchProvider,
  WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE,
} from '@deepseek-ai/dsh-web-search-deepseek';
import { DEFAULT_USER_AGENT, HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http';

/** 官方抓取限值，与 `dsh-tavily-pool` 采用的值一致（即官方包的默认值）。 */
export const OFFICIAL_FETCH_LIMITS = Object.freeze({
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 30_000,
  maxRedirects: 5,
  userAgent: DEFAULT_USER_AGENT,
});

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY';

/**
 * 读 `web-search-deepseek` 的当前配置。
 *
 * 经 `ctx.get('settings')` 取服务，而不是 `ctx.settings`：后者需要 `inject` 声明，
 * 未声明时 context 代理会抛「cannot get property without inject」，被下面的 catch
 * 吞掉之后这里恒返回 `{}`，于是官方回落永远用默认端点，读不到用户配的 magpie 网关。
 * @param ctx - 插件上下文。
 * @returns 配置对象，读不到时返回 `{}`。
 */
function readDeepSeekSection(ctx) {
  try {
    const settings = ctx.get?.('settings');
    const entries = settings?.describe?.() ?? [];
    const entry = entries.find((item) => item.ns === WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE);
    const value = entry?.value;
    return value !== null && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/**
 * 构造官方的凭据解析器。
 *
 * 优先级：字面量 `apiKey` > credentials 服务 > 环境层。引用名不合语法时跳过
 * credentials（不合法的 ref 会让 `resolve` 抛 TypeError），直接查环境。
 * @param ctx - 插件上下文。
 * @param section - `web-search-deepseek` 配置。
 * @returns 一个返回 `string | undefined` 的异步函数。
 */
export function makeApiKeyResolver(ctx, section) {
  const literal = typeof section.apiKey === 'string' ? section.apiKey : '';
  const refName = typeof section.apiKeyEnv === 'string' && section.apiKeyEnv.length > 0
    ? section.apiKeyEnv
    : DEFAULT_API_KEY_ENV;

  return async () => {
    if (literal.length > 0) return literal;
    if (isCredentialRefName(refName)) {
      try {
        // `ctx.get` 而不是 `ctx.credentials`：credentials 是可选服务，没进 `inject`
        // 声明，直接属性访问会一直是 undefined，于是凭据存储被静默跳过、只剩环境层。
        const resolved = await ctx.get?.('credentials')?.resolve?.(credentialRef(refName));
        if (typeof resolved?.value === 'string' && resolved.value.length > 0) return resolved.value;
      } catch {
        // 凭据服务不可用：继续查环境层
      }
    }
    const fromEnv = launchEnvironmentOf(ctx)?.get?.(refName)?.value;
    return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined;
  };
}

/**
 * 构造一个官方搜索提供方实例。
 * @param ctx - 插件上下文。
 * @returns `DeepSeekSearchProvider`。
 */
export function createOfficialSearchProvider(ctx) {
  return new DeepSeekSearchProvider(() => {
    const section = readDeepSeekSection(ctx);
    const resolveApiKey = makeApiKeyResolver(ctx, section);
    const options = {
      baseURL: typeof section.baseURL === 'string' && section.baseURL.length > 0
        ? section.baseURL
        : DEEPSEEK_DEFAULT_BASE_URL,
      model: typeof section.model === 'string' && section.model.length > 0 ? section.model : DEEPSEEK_DEFAULT_MODEL,
      apiVersion: typeof section.apiVersion === 'string' && section.apiVersion.length > 0
        ? section.apiVersion
        : DEEPSEEK_DEFAULT_API_VERSION,
      maxTokens: Number.isInteger(section.maxTokens) ? section.maxTokens : DEEPSEEK_DEFAULT_MAX_TOKENS,
      maxUses: Number.isInteger(section.maxUses) ? section.maxUses : DEEPSEEK_DEFAULT_MAX_USES,
      resolveApiKey,
    };
    if (typeof section.apiKey === 'string' && section.apiKey.length > 0) options.apiKey = section.apiKey;
    return options;
  });
}

/**
 * 构造一个本地 HTTP 抓取提供方实例。
 * @returns `HttpFetchProvider`。
 */
export function createOfficialFetchProvider() {
  return new HttpFetchProvider({ ...OFFICIAL_FETCH_LIMITS });
}
