/**
 * 文本安全工具：按 Unicode 码点截断、清理孤立代理。
 *
 * 为什么要专门处理：JavaScript 的 `String.prototype.slice` 以 UTF-16 代码单元为单位。
 * 直接 `slice(0, n)` 可能落在一个代理对的正中间，切出半个字——那个孤立代理单独输出时
 * 会被上层（XML/JSON 序列化、终端、下游模型）替换成 U+FFFD（�），甚至让严格的序列化器
 * 直接抛错。用户看到的就是正文末尾冒出乱码。
 *
 * 这里的做法：先把输入里的**孤立代理**（本来就坏的数据）剔掉，再按**码点**截断，
 * 保证截断点永远落在完整字符之间。
 *
 * @module dsh-search-fetch-router/text
 */

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

/**
 * 剔除孤立代理。
 *
 * 成对的高+低代理（合法字符）原样保留；单个孤立的高代理或低代理全部丢弃。
 * 这不是「正常文本会遇到的输入」——它只会在上游把二进制/损坏文本硬塞进 JSON 字符串时出现，
 * 但一旦出现，清掉比让它流到下游更好。
 * @param input - 任意值；非字符串一律当作空串。
 * @returns 清理后的字符串。
 */
export function stripLoneSurrogates(input) {
  if (typeof input !== 'string') return '';
  const out = [];
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (isHighSurrogate(code)) {
      const next = input.charCodeAt(i + 1);
      if (isLowSurrogate(next)) {
        out.push(input[i], input[i + 1]);
        i += 1;
      }
      // 孤立高代理：不 push，丢弃。
    } else if (isLowSurrogate(code)) {
      // 孤立低代理：不 push，丢弃。
    } else {
      out.push(input[i]);
    }
  }
  return out.join('');
}

/**
 * 按码点计算长度（emoji、CJK 扩展区等按 1 个字符算，而不是 2 个代码单元）。
 * @param input - 任意值；非字符串当作空串。
 * @returns 码点数量。
 */
export function codePointLength(input) {
  if (typeof input !== 'string') return 0;
  // 先清孤立代理，否则一个孤立高/低代理会被 Array.from 当成 1 个码点误算。
  return Array.from(stripLoneSurrogates(input)).length;
}

/**
 * 按码点安全截断。
 * @param value - 待截断的任意值；非字符串当作空串。
 * @param maxChars - 最大码点数。非有限数或 <= 0 时截成空串（只要原来非空就标 truncated）。
 * @returns `{text, truncated}`：`text` 是清理+截断后的字符串，`truncated` 表示是否丢弃了内容。
 */
export function clampText(value, maxChars) {
  const clean = stripLoneSurrogates(value);
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return { text: '', truncated: clean.length > 0 };
  }
  const limit = Math.floor(maxChars);
  const points = Array.from(clean);
  if (points.length <= limit) return { text: clean, truncated: false };
  // slice 作用在「码点数组」上，绝不会切开代理对。
  return { text: points.slice(0, limit).join(''), truncated: true };
}

/**
 * 递归清理一个值里的所有字符串（对象/数组深拷贝，其他类型原样返回）。
 *
 * 用于执行层出口：搜索结果/抓取结果的字段形状由各家适配器决定，逐字段手写清理容易漏，
 * 索性对整棵结果树扫一遍。结果都是纯 JSON 结构（plain object / array / string / number /
 * boolean / null），不需要处理 Date、Map 等特殊对象。
 * @param value - 任意 JSON 结构的值。
 * @returns 清理后的新值。
 */
export function sanitizeStrings(value) {
  if (typeof value === 'string') return stripLoneSurrogates(value);
  if (Array.isArray(value)) return value.map(sanitizeStrings);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = sanitizeStrings(inner);
    return out;
  }
  return value;
}
