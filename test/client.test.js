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
            refs.map((reference) => [reference, { configured: true, writable: true }]),
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

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].options.name, 'plugins.detail.section');
  assert.equal(registrations[0].options.id, 'dsh-search-fetch-router');
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
  // title, description, tavily group, firecrawl group, note
  assert.equal(children.length, 5);

  const inputs = collectKeyInputs(tree);
  const labels = inputs.map((field) => field.props['data-sfr-key']).sort();
  assert.deepEqual(labels, ['FIRECRAWL_API_KEY', 'TAVILY_API_KEY', 'TAVILY_API_KEY_2']);
  // Nothing is being typed yet, so no field should be revealed and no eye button exists.
  assert.ok(inputs.every((field) => field.props.type === 'password'));
  // A group with more than one reference gets a per-row remove button; a single-row
  // group must not — you can never delete your last account.
  const removeButtons = collectButtons(tree);
  assert.equal(removeButtons.length, 2);
  assert.ok(removeButtons.every((button) => button.props['aria-label'] === 'Remove'));
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
    ['FIRECRAWL_API_KEY', 'TAVILY_API_KEY'],
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

/** Every "Add account" button (one per group). */
function collectAddButtons(tree) {
  return flatten(tree).filter(
    (node) => node.type === 'button' && Array.isArray(node.children) && node.children.includes('Add account'),
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
  assert.equal(addButtons.length, 2, 'one add button per group');
  assert.equal(addButtons[0].props.disabled, false);

  await addButtons[0].props.onClick();
  assert.deepEqual(state.mutations.at(-1), [
    { op: 'set', path: ['tavilyApiKeyRefs', 1], value: 'TAVILY_API_KEY_2' },
  ]);

  // The second add button targets the firecrawl array independently.
  await addButtons[1].props.onClick();
  assert.deepEqual(state.mutations.at(-1), [
    { op: 'set', path: ['firecrawlApiKeyRefs', 1], value: 'FIRECRAWL_API_KEY_2' },
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

  const removeButtons = collectButtons(tree);
  assert.equal(removeButtons.length, 2, 'only the two-row group gets remove buttons');

  await removeButtons[0].props.onClick();
  assert.deepEqual(state.mutations.at(-1), [
    { op: 'unset', path: ['tavilyApiKeyRefs', 0] },
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
  assert.equal(addButtons.length, 2);
  assert.ok(addButtons.every((button) => button.props.disabled === true));
  // Default config has one ref per group, so no remove buttons either.
  assert.equal(collectButtons(tree).length, 0);
});
