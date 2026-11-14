/**
 * Contract tests for the browser bundle `lib/client.js`.
 *
 * The bundle is a classic script that calls `window.__ModuleLoader__.load`
 * and `require`s only seed modules, so Node cannot import it directly. These
 * tests emulate exactly that harness: capture the definition, run the factory
 * against a stubbed `require`, then drive `apply(ctx)` and the section
 * component. Catching a broken contract here is the whole point — a wrong slot
 * name or a missing export renders nothing and fails silently in the browser.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** Build the stub browser environment and evaluate the bundle body in it. */
function loadBundle() {
  let captured;
  const window = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition;
      },
    },
  };

  const noop = () => {};
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, noop],
    useEffect: () => noop,
  };
  const primitives = {
    SettingsSecretField: (props) => ({ type: 'SettingsSecretField', props }),
    SettingsForm: (props) => ({ type: 'SettingsForm', props }),
    SettingsValueField: (props) => ({ type: 'SettingsValueField', props }),
  };
  const seeds = {
    react,
    'react/jsx-runtime': { jsx: react.createElement, jsxs: react.createElement },
    'react-dom': {},
    'react-dom/client': {},
    '@deepseek-ai/cordis': {},
    'dsh-client-store': {},
    'dsh-client-ui-slots': {},
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
    'dsh-client-ui-dockkit': {},
  };
  const require = (name) => {
    if (!(name in seeds)) throw new Error(`unexpected require: ${name}`);
    return seeds[name];
  };

  // eslint-disable-next-line no-new-func
  new Function('window', 'require', SOURCE)(window, require);
  assert.ok(captured, 'client did not call __ModuleLoader__.load');
  return { captured, require };
}

/** A fake ctx that records slot registrations and locale dictionaries. */
function fakeContext(configValue, options = {}) {
  const registrations = [];
  const state = { dicts: null, injected: [], mutations: [] };
  const configForm = {
    getSnapshot: () => ({ value: configValue, revision: 0 }),
    subscribe: () => () => {},
  };
  if (options.mutate !== false) {
    configForm.mutate = async (ops) => {
      state.mutations.push(ops);
      return true;
    };
  }
  const ctx = {
    effect: (fn) => fn(),
    locale: {
      register: (ns, dicts) => {
        state.dicts = { ns, dicts };
        return () => {};
      },
    },
    configForms: { get: (ns) => (ns === 'search-fetch-router' ? configForm : undefined) },
    slots: {
      inject: (name, callback) => {
        state.injected.push(name);
        return callback();
      },
      register: (options, Component) => {
        registrations.push({ options, Component });
        return () => {};
      },
    },
    remote: {
      credentials: {
        describe: async (refs) => ({
          ok: true,
          value: Object.fromEntries(
            refs.map((reference) => [
              reference,
              { configured: true, writable: true, ...(options.masked ? { masked: options.masked } : {}) },
            ]),
          ),
        }),
        set: async () => ({ ok: true }),
      },
      $on: () => () => {},
    },
  };
  return { ctx, registrations, state };
}

/** Recursively expand function components into a flat list of host elements. */
function flatten(node, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node.type === 'function') {
    flatten(node.type(node.props), out);
    return out;
  }
  out.push(node);
  flatten(node.children, out);
  flatten(node.props?.children, out);
  return out;
}

/** Every key input in the rendered tree. */
function collectKeyInputs(tree) {
  return flatten(tree).filter(
    (node) => node.type === 'input' && node.props?.['data-sfr-key'] !== undefined,
  );
}

/** Every button in the rendered tree that carries an aria-label. */
function collectButtons(tree) {
  return flatten(tree).filter(
    (node) => node.type === 'button' && node.props?.['aria-label'] !== undefined,
  );
}

const DEFAULT_CONFIG = {
  tavilyApiKeyRefs: ['TAVILY_API_KEY'],
  firecrawlApiKeyRefs: ['FIRECRAWL_API_KEY'],
};

test('client: registers under its package name with the seed-only inject list', () => {
  const { captured, require } = loadBundle();
  assert.equal(captured.id, 'dsh-search-fetch-router');
  const exported = captured.factory(require);
  assert.equal(typeof exported.apply, 'function');
  assert.deepEqual(exported.inject, [
    'slots',
    'locale',
    'remote',
    'remote.credentials',
    'remote.settings',
    'configForms',
  ]);
});

test('client: mounts one section into plugins.detail.section', () => {
  const { captured, require } = loadBundle();
  const exported = captured.factory(require);
  const { ctx, registrations, state } = fakeContext(DEFAULT_CONFIG);
  exported.apply(ctx);

  assert.ok(state.dicts, 'locale dictionaries were not registered');
  assert.equal(state.dicts.ns, 'dsh-search-fetch-router');
  assert.deepEqual(
    Object.keys(state.dicts.dicts.zh).sort(),
    Object.keys(state.dicts.dicts.en).sort(),
    'zh and en dictionaries must share the same keys',
  );

  const section = registrations.find((r) => r.options.name === 'plugins.detail.section');
  const toggle = registrations.find((r) => r.options.name === 'conversation.input.left');
  assert.ok(section, 'the settings section must be registered');
  assert.ok(toggle, 'the composer toggle must be registered');
  assert.equal(section.options.id, 'dsh-search-fetch-router');
  assert.equal(toggle.options.id, 'dsh-search-fetch-router-toggle');
});

test('client: ignores foreign packages and renders only for its own bundle', () => {
  const { captured, require } = loadBundle();
  const exported = captured.factory(require);
  const { ctx, registrations } = fakeContext(DEFAULT_CONFIG);
  exported.apply(ctx);
  const { Component } = registrations[0];

  assert.equal(Component({ subject: { kind: 'item', id: 'x' } }), null);
  assert.equal(Component({ subject: { kind: 'bundle', pkg: { name: 'other' } } }), null);
  assert.equal(Component({}), null, 'a missing subject must not render');

  const own = Component({
    subject: { kind: 'bundle', pkg: { name: 'dsh-search-fetch-router' } },
  });
  assert.ok(own, 'own bundle must render');
  assert.equal(typeof own.type, 'function');
});

test('client: the card renders a field per configured reference', () => {
  const { captured, require } = loadBundle();
  const exported = captured.factory(require);
  const { ctx, registrations } = fakeContext({
    tavilyApiKeyRefs: ['TAVILY_API_KEY', 'TAVILY_API_KEY_2'],
    firecrawlApiKeyRefs: ['FIRECRAWL_API_KEY'],
  });
  exported.apply(ctx);
  const { Component } = registrations[0];
  const element = Component({
    subject: { kind: 'bundle', pkg: { name: 'dsh-search-fetch-router' } },
  });

  const tree = element.type(element.props);
  assert.equal(tree.type, 'div');
  const children = tree.children.flat(Infinity).filter(Boolean);
  // title, description, tavily group, firecrawl group, exa group, max-results block, note
  assert.equal(children.length, 7);

  const inputs = collectKeyInputs(tree);
  const labels = inputs.map((field) => field.props['data-sfr-key']).sort();
  assert.deepEqual(labels, ['EXA_API_KEY', 'FIRECRAWL_API_KEY', 'TAVILY_API_KEY', 'TAVILY_API_KEY_2']);
  // Nothing is being typed yet, so no field should be revealed and no eye button exists.
  assert.ok(inputs.every((field) => field.props.type === 'password'));
  // A group with more than one reference gets a per-row remove button; a single-row
  // group must not — you can never delete your last account.
  const removeButtons = collectButtons(tree).filter((button) => button.props['aria-label'] === 'Remove');
  assert.equal(removeButtons.length, 2);
});

test('client: falls back to the default reference names on a loading snapshot', () => {
  const { captured, require } = loadBundle();
  const exported = captured.factory(require);
  const { ctx, registrations } = fakeContext(undefined);
  exported.apply(ctx);
  const { Component } = registrations[0];
  const element = Component({
    subject: { kind: 'bundle', pkg: { name: 'dsh-search-fetch-router' } },
  });
  const tree = element.type(element.props);
  const inputs = collectKeyInputs(tree);
  assert.deepEqual(
    inputs.map((field) => field.props['data-sfr-key']).sort(),
    ['EXA_API_KEY', 'FIRECRAWL_API_KEY', 'TAVILY_API_KEY'],
  );
});

test('client: the eye toggle only appears once there is a draft to reveal', () => {
  const { captured, require } = loadBundle();
  const exported = captured.factory(require);
  const { KeyField } = exported.__test;
  const t = (key) => key;
  const base = { t, reference: 'TAVILY_API_KEY', status: { configured: false, writable: true, busy: false }, onEdit: () => {}, onSave: () => {} };

  // Empty draft: masked input, no eye button.
  const empty = KeyField({ ...base, draft: '' });
  const emptyInputs = collectKeyInputs(empty);
  assert.equal(emptyInputs.length, 1);
  assert.equal(emptyInputs[0].props.type, 'password');
  assert.equal(collectButtons(empty).length, 0, 'no eye button without a draft');

  // A typed, unsaved draft: value echoed, still masked, eye button present and labelled.
  const typed = KeyField({ ...base, draft: 'tvly-partial' });
  const typedInputs = collectKeyInputs(typed);
  assert.equal(typedInputs[0].props.type, 'password', 'masked until the eye is clicked');
  assert.equal(typedInputs[0].props.value, 'tvly-partial');
  const buttons = collectButtons(typed);
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props['aria-label'], 'show');
  assert.equal(typeof buttons[0].props.onClick, 'function');
});

test('client: a busy field disables the input and the save button', () => {
  const { captured, require } = loadBundle();
  const exported = captured.factory(require);
  const { KeyField } = exported.__test;
  const t = (key) => key;
  const tree = KeyField({
    t,
    reference: 'FIRECRAWL_API_KEY',
    status: { configured: true, writable: true, busy: true },
    draft: 'fc-partial',
    onEdit: () => {},
    onSave: () => {},
  });
  assert.equal(collectKeyInputs(tree)[0].props.disabled, true);
  const saveButtons = flatten(tree).filter(
    (node) => node.type === 'button' && node.props?.['aria-label'] === undefined,
  );
  assert.equal(saveButtons.length, 1);
  assert.equal(saveButtons[0].props.disabled, true, 'save stays disabled while busy');
});

/** Every "add another key" button (one per group). */
function collectAddButtons(tree) {
  return flatten(tree).filter(
    (node) => node.type === 'button' && node.props?.['data-sfr-add'] !== undefined,
  );
}

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

test('client: the add button appends a reference name through form.mutate', async () => {
  const { captured, require } = loadBundle();
  const exported = captured.factory(require);
  const { ctx, registrations, state } = fakeContext(DEFAULT_CONFIG);
  exported.apply(ctx);
  const { Component } = registrations[0];
  const element = Component({
    subject: { kind: 'bundle', pkg: { name: 'dsh-search-fetch-router' } },
  });
  const tree = element.type(element.props);

  const addButtons = collectAddButtons(tree);
  assert.equal(addButtons.length, 3, 'one add button per group');
  assert.equal(addButtons[0].props.disabled, false);

  await addButtons[0].props.onClick();
  assert.deepEqual(state.mutations.at(-1), [
    { op: 'set', path: ['tavilyApiKeyRefs'], value: ['TAVILY_API_KEY', 'TAVILY_API_KEY_2'] },
  ]);

  // The second add button targets the exa array (search providers render before fetch).
  await addButtons[1].props.onClick();
  assert.deepEqual(state.mutations.at(-1), [
    { op: 'set', path: ['exaApiKeyRefs'], value: ['EXA_API_KEY', 'EXA_API_KEY_2'] },
  ]);

  // The third targets the firecrawl array independently.
  await addButtons[2].props.onClick();
  assert.deepEqual(state.mutations.at(-1), [
    { op: 'set', path: ['firecrawlApiKeyRefs'], value: ['FIRECRAWL_API_KEY', 'FIRECRAWL_API_KEY_2'] },
  ]);
});

test('client: a remove button unsets that reference', async () => {
  const { captured, require } = loadBundle();
  const exported = captured.factory(require);
  const { ctx, registrations, state } = fakeContext({
    tavilyApiKeyRefs: ['TAVILY_API_KEY', 'TAVILY_API_KEY_2'],
    firecrawlApiKeyRefs: ['FIRECRAWL_API_KEY'],
  });
  exported.apply(ctx);
  const { Component } = registrations[0];
  const element = Component({
    subject: { kind: 'bundle', pkg: { name: 'dsh-search-fetch-router' } },
  });
  const tree = element.type(element.props);

  const removeButtons = collectButtons(tree).filter((button) => button.props['aria-label'] === 'Remove');
  assert.equal(removeButtons.length, 2, 'only the two-row group gets remove buttons');

  await removeButtons[0].props.onClick();
  assert.deepEqual(state.mutations.at(-1), [
    { op: 'set', path: ['tavilyApiKeyRefs'], value: ['TAVILY_API_KEY_2'] },
  ]);
});

test('client: add is disabled when the form cannot mutate', () => {
  const { captured, require } = loadBundle();
  const exported = captured.factory(require);
  const { ctx, registrations } = fakeContext(DEFAULT_CONFIG, { mutate: false });
  exported.apply(ctx);
  const { Component } = registrations[0];
  const element = Component({
    subject: { kind: 'bundle', pkg: { name: 'dsh-search-fetch-router' } },
  });
  const tree = element.type(element.props);

  const addButtons = collectAddButtons(tree);
  assert.equal(addButtons.length, 3);
  assert.ok(addButtons.every((button) => button.props.disabled === true));
  // Default config has one ref per group, so no remove buttons either
  // (header ordering/enable buttons carry aria-labels too, so filter for Remove).
  assert.equal(
    collectButtons(tree).filter((button) => button.props['aria-label'] === 'Remove').length,
    0,
  );
});

test('client: disabling a search provider removes it from providerOrder', async () => {
  const { captured, require } = loadBundle();
  const exported = captured.factory(require);
  const { ctx, registrations, state } = fakeContext({
    tavilyApiKeyRefs: ['TAVILY_API_KEY'],
    exaApiKeyRefs: ['EXA_API_KEY'],
    firecrawlApiKeyRefs: ['FIRECRAWL_API_KEY'],
    providerOrder: ['tavily', 'exa'],
  });
  exported.apply(ctx);
  const { Component } = registrations[0];
  const element = Component({ subject: { kind: 'bundle', pkg: { name: 'dsh-search-fetch-router' } } });
  const tree = element.type(element.props);

  // Both providers are enabled → two "Disable" buttons, in tavily-then-exa order.
  const disableButtons = collectButtons(tree).filter((b) => b.props['aria-label'] === 'Disable');
  assert.equal(disableButtons.length, 2);
  await disableButtons[1].props.onClick(); // exa
  assert.deepEqual(state.mutations.at(-1), [
    { op: 'set', path: ['providerOrder'], value: ['tavily'] },
  ]);
});

test('client: move down reorders providerOrder', async () => {
  const { captured, require } = loadBundle();
  const exported = captured.factory(require);
  const { ctx, registrations, state } = fakeContext({
    tavilyApiKeyRefs: ['TAVILY_API_KEY'],
    exaApiKeyRefs: ['EXA_API_KEY'],
    firecrawlApiKeyRefs: ['FIRECRAWL_API_KEY'],
    providerOrder: ['tavily', 'exa'],
  });
  exported.apply(ctx);
  const { Component } = registrations[0];
  const element = Component({ subject: { kind: 'bundle', pkg: { name: 'dsh-search-fetch-router' } } });
  const tree = element.type(element.props);

  // First enabled provider (tavily) can move down; its button is the first enabled "Move down".
  const downButtons = collectButtons(tree).filter((b) => b.props['aria-label'] === 'Move down' && b.props.disabled !== true);
  assert.equal(downButtons.length, 1);
  await downButtons[0].props.onClick();
  assert.deepEqual(state.mutations.at(-1), [
    { op: 'set', path: ['providerOrder'], value: ['exa', 'tavily'] },
  ]);
});

test('client: rendered search-provider order follows providerOrder', () => {
  const { captured, require } = loadBundle();
  const exported = captured.factory(require);
  const { ctx, registrations } = fakeContext({
    tavilyApiKeyRefs: ['TAVILY_API_KEY'],
    exaApiKeyRefs: ['EXA_API_KEY'],
    firecrawlApiKeyRefs: ['FIRECRAWL_API_KEY'],
    providerOrder: ['exa', 'tavily'],
  });
  exported.apply(ctx);
  const { Component } = registrations[0];
  const element = Component({ subject: { kind: 'bundle', pkg: { name: 'dsh-search-fetch-router' } } });
  const tree = element.type(element.props);
  assert.deepEqual(
    collectKeyInputs(tree).map((i) => i.props['data-sfr-key']),
    ['EXA_API_KEY', 'TAVILY_API_KEY', 'FIRECRAWL_API_KEY'],
    'groups render in providerOrder, then fetch groups',
  );
});

test('client: KeyField shows the masked preview and an editable name input', () => {
  const { captured, require } = loadBundle();
  const { KeyField } = captured.factory(require).__test;
  const t = (key) => key;
  const node = KeyField({
    t,
    reference: 'TAVILY_API_KEY',
    status: { configured: true, writable: true, busy: false, masked: '••••abcd' },
    draft: '',
    onEdit: () => {},
    onSave: () => {},
  });
  const spans = flatten(node).filter((n) => n.type === 'span');
  assert.ok(
    spans.some((span) => [].concat(span.children).join('').includes('••••abcd')),
    'masked preview rendered in the badge',
  );
  const nameInputs = flatten(node).filter(
    (n) => n.type === 'input' && n.props?.['data-sfr-name'] === 'TAVILY_API_KEY',
  );
  assert.equal(nameInputs.length, 1, '名称是可编辑输入');
  assert.equal(nameInputs[0].props.value, 'TAVILY_API_KEY');
  assert.equal(typeof nameInputs[0].props.onChange, 'function', '名称改动只落在本地草稿');
  assert.equal(nameInputs[0].props.onBlur, undefined, '名称不在 blur 时落库');
  const saveBtn = flatten(node).filter((n) => n.type === 'button')[0];
  assert.equal(saveBtn.props.disabled, true, '没输 key、也没改名称时保存按钮禁用');

  const active = KeyField({
    t,
    reference: 'TAVILY_API_KEY',
    status: { configured: false, writable: true, busy: false },
    draft: 'tvly-partial',
    onEdit: () => {},
    onSave: () => {},
  });
  const activeSave = flatten(active).filter(
    (n) => n.type === 'button' && n.props?.['aria-label'] === undefined && n.props?.['data-sfr-add'] === undefined,
  )[0];
  assert.equal(activeSave.props.disabled, false, '有草稿时可保存');
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

/** Every string rendered anywhere in the tree (text nodes included). */
function collectText(node, out = []) {
  if (node == null) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out; }
  if (typeof node === 'object') {
    collectText(node.children, out);
    collectText(node.props?.children, out);
  }
  return out;
}

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

test('client: settings card renders the max-results input and three mode buttons', () => {
  const { captured, require } = loadBundle();
  const { RouterSettingsCard } = captured.factory(require).__test;
  const form = {
    getSnapshot: () => ({ value: {
      providerOrder: ['tavily', 'exa', 'firecrawl'],
      maxSearchResults: 20,
      maxResultsMode: 'provider-max',
      tavilyApiKeyRefs: ['TAVILY_API_KEY'],
      exaApiKeyRefs: ['EXA_API_KEY'],
      firecrawlApiKeyRefs: ['FIRECRAWL_API_KEY'],
    } }),
    mutate: async () => true,
    subscribe: () => () => {},
  };
  const ctx = { remote: { credentials: { async describe() { return { ok: true, value: {} }; }, async set() { return { ok: true }; } } } };
  const tree = RouterSettingsCard({ ctx, form, t: (key) => key });
  const found = [];
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    if (node.props) found.push(node);
    if (node.children) walk(node.children);
  };
  walk(tree);
  const modes = found.filter((n) => n.type === 'button' && n.props['data-sfr-mode']);
  assert.equal(modes.length, 3, 'three mode buttons');
  const active = modes.filter((n) => n.props['aria-pressed'] === true);
  assert.equal(active.length, 1);
  assert.equal(active[0].props['data-sfr-mode'], 'provider-max');
  assert.ok(found.some((n) => n.type === 'input' && n.props['data-sfr-maxresults'] === 'input'), 'max-results input present');
});
