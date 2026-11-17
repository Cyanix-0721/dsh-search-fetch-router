/**
 * Shared helpers for the `lib/execute.js` router tests.
 *
 * 这些工厂只做最小造假：`fakeCtx` 暴露插件真正读的服务；`fakeSettings` 回放
 * `web-search-deepseek` 段；`fakeCredentials` 从字面量 map 解析；`stubFetch`
 * 接管全局 fetch；`configWith` 生成一份默认关掉兜底的配置。
 */

import { Config } from '../../lib/config.js';

/**
 * 造一个最小 ctx。只提供插件真正读的四样：`credentials`、`settings`、
 * `launchEnvironment`（未提供时 `launchEnvironmentOf` 会安全跳过）、`logger`。
 * @param options - `{credentials, settings}`。
 * @returns 假 ctx。
 */
function fakeCtx({ credentials, settings, logger } = {}) {
  return {
    get(name) {
      if (name === 'credentials') return credentials;
      if (name === 'settings') return settings;
      return undefined;
    },
    logger: logger ?? { warn() {} },
  };
}

/**
 * 造一个只实现 `describe()` 的假 settings 服务，回放 `web-search-deepseek` 段。
 * 传 `undefined` 时返回空条目列表，等价于「用户没配这一段」。
 * @param value - 该段的值。
 * @returns 假 settings 服务。
 */
function fakeSettings(value) {
  return {
    describe() {
      return value === undefined ? [] : [{ ns: 'web-search-deepseek', value }];
    },
  };
}

/**
 * 造一个假的 credentials 服务，从字面量 map 解析。
 * @param values - 引用名 → 值。
 * @returns 假服务。
 */
function fakeCredentials(values) {
  return {
    async resolve(ref) {
      const value = values[ref];
      return value === undefined ? undefined : { value, source: 'file' };
    },
  };
}

/** 替换全局 fetch，记录调用并回放。 */
function stubFetch(responder) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function configWith(overrides) {
  return Config({ fetchFallback: false, searchFallback: false, ...overrides });
}

export { fakeCtx, fakeSettings, fakeCredentials, stubFetch, configWith };
