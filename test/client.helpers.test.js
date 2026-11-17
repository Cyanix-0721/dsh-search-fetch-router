import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  loadBundle,
  fakeContext,
  flatten,
  collectKeyInputs,
  collectButtons,
  collectAddButtons,
  collectText,
  DEFAULT_CONFIG,
} from './helpers/client-harness.js';

test('client: nextRefName picks the first free suffixed name', () => {
  const { captured, require } = loadBundle();
  const { nextRefName } = captured.factory(require).__test;
  assert.equal(nextRefName([], 'TAVILY_API_KEY'), 'TAVILY_API_KEY');
  assert.equal(nextRefName(['TAVILY_API_KEY'], 'TAVILY_API_KEY'), 'TAVILY_API_KEY_2');
  assert.equal(
    nextRefName(['TAVILY_API_KEY', 'TAVILY_API_KEY_2'], 'TAVILY_API_KEY'),
    'TAVILY_API_KEY_3',
  );
  // A gap is filled before growing the suffix.
  assert.equal(
    nextRefName(['TAVILY_API_KEY', 'TAVILY_API_KEY_3'], 'TAVILY_API_KEY'),
    'TAVILY_API_KEY_2',
  );
});

test('client: save button state helper', () => {
  const { captured, require } = loadBundle();
  const { saveDisabled } = captured.factory(require).__test;
  assert.equal(saveDisabled(true, true, true), true, '忙碌时禁用');
  assert.equal(saveDisabled(false, false, false), true, '没有 key 草稿也没改名称时禁用');
  assert.equal(saveDisabled(false, true, false), false, '有 key 草稿时可用');
  assert.equal(saveDisabled(false, false, true), false, '只改了名称也可保存');
});

test('client: validateRefName rejects bad or duplicate names', () => {
  const { captured, require } = loadBundle();
  const { validateRefName } = captured.factory(require).__test;
  assert.equal(validateRefName('TAVILY_API_KEY_2', ['TAVILY_API_KEY'], 'TAVILY_API_KEY'), null);
  assert.equal(validateRefName('TAVILY_API_KEY', ['TAVILY_API_KEY'], 'TAVILY_API_KEY'), null, '不改原名视为通过');
  assert.equal(validateRefName('1bad', ['TAVILY_API_KEY'], 'TAVILY_API_KEY'), 'invalidName', '数字开头非法');
  assert.equal(validateRefName('has space', [], 'X'), 'invalidName', '空格非法');
  assert.equal(validateRefName('EXA_API_KEY', ['EXA_API_KEY'], 'TAVILY_API_KEY'), 'duplicateName', '撞名');
  assert.equal(validateRefName('  MY_KEY  ', [], 'X'), null, '两端空白裁掉后合法');
  assert.equal(validateRefName('', [], 'X'), 'emptyName', '空名');
  assert.equal(validateRefName('   ', [], 'X'), 'emptyName', '纯空白也算空名');
});

test('client: planSave 决定改名下标 / 是否写 key / 错误，且不做任何 I/O', () => {
  const { captured, require } = loadBundle();
  const { planSave } = captured.factory(require).__test;
  const fieldInfo = { field: 'tavilyApiKeyRefs', list: ['TAVILY_API_KEY', 'TAVILY_API_KEY_2'] };
  const refs = ['TAVILY_API_KEY', 'TAVILY_API_KEY_2', 'EXA_API_KEY'];

  // 改名 + 填 key：下标取该 ref 在字段数组里的位置，key 去掉两端空白。
  assert.deepEqual(
    planSave({ reference: 'TAVILY_API_KEY', newNameRaw: 'TAVILY_MAIN', text: ' tvly-abc ', fieldInfo, refs }),
    { error: null, noop: false, rename: { field: 'tavilyApiKeyRefs', index: 0, to: 'TAVILY_MAIN' }, key: 'tvly-abc' },
  );
  // 只改名、不填 key。
  const renameOnly = planSave({ reference: 'TAVILY_API_KEY_2', newNameRaw: 'TAVILY_BACKUP', text: '', fieldInfo, refs });
  assert.deepEqual(renameOnly.rename, { field: 'tavilyApiKeyRefs', index: 1, to: 'TAVILY_BACKUP' });
  assert.equal(renameOnly.key, null);
  // 只填 key、不改名。
  const keyOnly = planSave({ reference: 'TAVILY_API_KEY', newNameRaw: 'TAVILY_API_KEY', text: 'tvly-x', fieldInfo, refs });
  assert.equal(keyOnly.rename, null);
  assert.equal(keyOnly.key, 'tvly-x');
  // 既没改名也没填 key：noop。
  assert.equal(
    planSave({ reference: 'TAVILY_API_KEY', newNameRaw: 'TAVILY_API_KEY', text: '', fieldInfo, refs }).noop,
    true,
  );
  // 撞名：拒绝，且不产生 rename / key。
  assert.deepEqual(
    planSave({ reference: 'TAVILY_API_KEY', newNameRaw: 'EXA_API_KEY', text: '', fieldInfo, refs }),
    { error: 'duplicateName', noop: false, rename: null, key: null },
  );
  // 空名。
  assert.equal(planSave({ reference: 'TAVILY_API_KEY', newNameRaw: '   ', text: '', fieldInfo, refs }).error, 'emptyName');
  // ref 不属于任何配置字段：failed。
  assert.equal(planSave({ reference: 'GHOST', newNameRaw: 'NEW', text: '', fieldInfo: undefined, refs }).error, 'failed');
});

test('client: key 输入框保有可访问名称', () => {
  const { captured, require } = loadBundle();
  const { KeyField } = captured.factory(require).__test;
  const t = (key) => key;
  const node = KeyField({
    t,
    reference: 'TAVILY_API_KEY',
    status: { configured: true, writable: true, busy: false },
    draft: '',
    onEdit: () => {},
    onSave: () => {},
  });
  const key = flatten(node).find(
    (n) => n.type === 'input' && n.props?.['data-sfr-key'] === 'TAVILY_API_KEY',
  );
  assert.ok(key, 'key 输入框渲染出来了');
  assert.equal(key.props['aria-label'], 'keyLabel: TAVILY_API_KEY', 'key 输入框带 aria-label，读屏能读出这是哪把 key');
});

test('client: provider ordering helpers (toggle / move-before / swap / merge)', () => {
  const { captured, require } = loadBundle();
  const { mergeKnown, applyProviderToggle, moveItemBefore, swapItem } = captured.factory(require).__test;

  assert.deepEqual(mergeKnown(['tavily'], ['custom']), ['tavily', 'custom']);
  assert.deepEqual(applyProviderToggle(['a', 'b'], 'c', true), ['a', 'b', 'c']);
  assert.deepEqual(applyProviderToggle(['a', 'b'], 'a', true), ['a', 'b']); // already on
  assert.deepEqual(applyProviderToggle(['a', 'b'], 'a', false), ['b']);
  assert.deepEqual(moveItemBefore(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(moveItemBefore(['a', 'b', 'c'], 'a', 'c'), ['b', 'a', 'c']);
  assert.deepEqual(moveItemBefore(['a', 'b'], 'a', 'a'), ['a', 'b']); // no-op
  assert.deepEqual(swapItem(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(swapItem(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']); // out of range
});

test('orderFor: 没配过时回退到供应商表派生的默认顺序', () => {
  const { captured, require } = loadBundle();
  const { orderFor, DEFAULT_ORDER } = captured.factory(require).__test;
  assert.deepEqual(orderFor(undefined), [...DEFAULT_ORDER]);
  assert.deepEqual(orderFor({ getSnapshot: () => ({ value: {} }) }), [...DEFAULT_ORDER]);
});

test('orderFor: 空数组代表「全部停用」，不能回退成默认', () => {
  // 这是真会出错的场景：用户把三家全停用，卡片若回退默认就会显示成全部启用，
  // 与运行时（一个 key 都不用）正好相反。
  const { captured, require } = loadBundle();
  const { orderFor } = captured.factory(require).__test;
  assert.deepEqual(orderFor({ getSnapshot: () => ({ value: { providerOrder: [] } }) }), []);
});

test('orderFor: 默认顺序与供应商表一致，且不含无 key 的兜底', () => {
  const { captured, require } = loadBundle();
  const { DEFAULT_ORDER } = captured.factory(require).__test;
  assert.deepEqual([...DEFAULT_ORDER], ['tavily', 'exa', 'firecrawl']);
  assert.ok(!DEFAULT_ORDER.includes('deepseek-official'));
  assert.ok(!DEFAULT_ORDER.includes('http'));
});

test('client: every provider shows which chains it serves', () => {
  const { captured, require } = loadBundle();
  const exported = captured.factory(require);
  const { ctx, registrations } = fakeContext();
  exported.apply(ctx);
  const { Component } = registrations[0];
  const element = Component({
    subject: { kind: 'bundle', pkg: { name: 'dsh-search-fetch-router' } },
  });
  const tree = element.type(element.props);
  const badges = collectText(tree).filter((text) => text === 'Search · Fetch');
  assert.equal(badges.length, 3, 'all three built-in providers serve both chains');
});

test('client: findNamespaceView picks by namespace and viewEnabled reads enabled', () => {
  const { captured, require } = loadBundle();
  const { findNamespaceView, viewEnabled } = captured.factory(require).__test;
  const describeValue = {
    namespaces: [
      { ns: 'other', value: { enabled: true } },
      { ns: 'search-fetch-router', value: { enabled: false } },
    ],
  };
  const view = findNamespaceView(describeValue, 'search-fetch-router');
  assert.equal(view.ns, 'search-fetch-router');
  assert.equal(findNamespaceView(describeValue, 'missing'), undefined);
  assert.equal(findNamespaceView(undefined, 'search-fetch-router'), undefined);
  assert.equal(viewEnabled(view), false);
  assert.equal(viewEnabled({ value: { enabled: true } }), true);
  assert.equal(viewEnabled({ value: {} }), true, 'missing enabled field counts as on');
  assert.equal(viewEnabled(undefined), true);
});

test('client: RouterToggle renders a switch that defaults to on', () => {
  const { captured, require } = loadBundle();
  const { RouterToggle } = captured.factory(require).__test;
  const el = RouterToggle({ ctx: {} });
  assert.equal(el.type, 'button');
  assert.equal(el.props['data-sfr-router-toggle'], '1');
  assert.equal(el.props.role, 'switch');
  assert.equal(el.props['aria-checked'], 'true');
  assert.match(el.props['aria-label'], /Search boost on/);
  assert.deepEqual(el.children, ['Search boost: on']);
});

test('client: unwrapRemote peels the {ok,value} envelope and passes bare values through', () => {
  const { captured, require } = loadBundle();
  const { unwrapRemote } = captured.factory(require).__test;
  assert.deepEqual(unwrapRemote({ ok: true, value: { namespaces: [] } }), { namespaces: [] });
  assert.equal(unwrapRemote({ ok: false, error: { message: 'x' } }), undefined);
  assert.equal(unwrapRemote(undefined), undefined);
  const bare = { namespaces: [] };
  assert.equal(unwrapRemote(bare), bare);
});

test('client: a real describe envelope resolves the toggle to the stored off state', () => {
  const { captured, require } = loadBundle();
  const { unwrapRemote, findNamespaceView, viewEnabled } = captured.factory(require).__test;
  // remote 调用的真实形态：{ ok:true, value:{ writable, hasDocument, namespaces:[…] } }
  const envelope = {
    ok: true,
    value: {
      writable: true,
      hasDocument: true,
      namespaces: [{ ns: 'search-fetch-router', value: { enabled: false }, revision: 3 }],
    },
  };
  const view = findNamespaceView(unwrapRemote(envelope), 'search-fetch-router');
  assert.equal(view.revision, 3);
  assert.equal(viewEnabled(view), false, 'stored enabled:false must read as off');
});

test('client: normalizeMaxResultsMode whitelists the three modes and defaults to cap', () => {
  const { captured, require } = loadBundle();
  const { normalizeMaxResultsMode } = captured.factory(require).__test;
  assert.equal(normalizeMaxResultsMode('provider-max'), 'provider-max');
  assert.equal(normalizeMaxResultsMode(' PROVIDER-DEFAULT '), 'provider-default');
  assert.equal(normalizeMaxResultsMode('cap'), 'cap');
  assert.equal(normalizeMaxResultsMode('nope'), 'cap');
  assert.equal(normalizeMaxResultsMode(42), 'cap');
});
