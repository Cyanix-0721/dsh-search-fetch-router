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
  // title, description, tavily group, firecrawl group, exa group, max-results block, diagnostics block, note
  assert.equal(children.length, 8);

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
