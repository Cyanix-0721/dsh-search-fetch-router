/**
 * Shared harness for the `lib/client.js` browser-bundle contract tests.
 *
 * The bundle is a classic script that calls `window.__ModuleLoader__.load`
 * and `require`s only seed modules, so Node cannot import it directly. These
 * helpers emulate exactly that harness: capture the definition, run the factory
 * against a stubbed `require`, then let each test drive `apply(ctx)` and the
 * section component. Catching a broken contract here is the whole point — a
 * wrong slot name or a missing export renders nothing and fails silently in
 * the browser.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8');

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

  // Node ≥21 exposes a real globalThis.navigator whose `language` follows the host
  // (this machine reports zh-CN). translate() falls back to navigator.language when
  // props.t is absent, so without a pin these assertions would flip to the Chinese
  // dictionary and fail. Inject a fixed English navigator to keep them locale-stable.
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', 'navigator', SOURCE)(window, require, { language: 'en' });
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

/** Every "add another key" button (one per group). */
function collectAddButtons(tree) {
  return flatten(tree).filter(
    (node) => node.type === 'button' && node.props?.['data-sfr-add'] !== undefined,
  );
}

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

const DEFAULT_CONFIG = {
  tavilyApiKeyRefs: ['TAVILY_API_KEY'],
  firecrawlApiKeyRefs: ['FIRECRAWL_API_KEY'],
};

export {
  loadBundle,
  fakeContext,
  flatten,
  collectKeyInputs,
  collectButtons,
  collectAddButtons,
  collectText,
  DEFAULT_CONFIG,
};
