import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { Config } from '../lib/config.js';

const READMES = ['README.md', 'README.zh-CN.md'];

/** 抓出 README 设置表里被反引号包起来的字段名。 */
function documentedKeys(file) {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  return new Set([...text.matchAll(/^\| `([a-zA-Z]+)` \|/gm)].map((match) => match[1]));
}

for (const file of READMES) {
  test(`docs: ${file} documents every config field`, () => {
    // 设置表是用户唯一的配置参考。加了字段忘了写，用户就永远不知道它存在——
    // 这类漏项没有运行时症状，只能靠这条断言拦住。
    const missing = Object.keys(Config({})).filter((key) => !documentedKeys(file).has(key));
    assert.deepEqual(missing, [], `${file} is missing config fields: ${missing.join(', ')}`);
  });

  test(`docs: ${file} documents no field that no longer exists`, () => {
    // 反向也查：删字段后留下的表格行会误导用户去配一个不生效的键。
    const extra = [...documentedKeys(file)].filter((key) => !(key in Config({})));
    assert.deepEqual(extra, [], `${file} documents non-existent fields: ${extra.join(', ')}`);
  });
}

test('docs: every error code in CODES is documented in both READMEs', async () => {
  const { CODES } = await import('../lib/errors.js');
  for (const file of READMES) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const code of Object.values(CODES)) {
      assert.ok(text.includes(code), `${file} does not document error code ${code}`);
    }
  }
});
