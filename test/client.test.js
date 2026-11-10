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
function fakeContext(configValue) {
  const registrations = [];
  const state = { dicts: null, injected: [] };
  const configForm = {
    getSnapshot: () => ({ value: configValue }),
    subscribe: () => () => {},
  };
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

/** Recursively expand function components and collect every secret field. */
function collectSecretFields(node, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectSecretFields(child, out);
    return out;
  }
  if (typeof node.type === 'function') {
    collectSecretFields(node.type(node.props), out);
    return out;
  }
  if (node.type === 'SettingsSecretField') out.push(node.props);
  collectSecretFields(node.children, out);
  collectSecretFields(node.props?.children, out);
  return out;
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

  const secretFields = collectSecretFields(tree);
  const labels = secretFields.map((field) => field.label).sort();
  assert.deepEqual(labels, ['FIRECRAWL_API_KEY', 'TAVILY_API_KEY', 'TAVILY_API_KEY_2']);
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
  const secretFields = collectSecretFields(tree);
  assert.deepEqual(
    secretFields.map((field) => field.label).sort(),
    ['FIRECRAWL_API_KEY', 'TAVILY_API_KEY'],
  );
});
