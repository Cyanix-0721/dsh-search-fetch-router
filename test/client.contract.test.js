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
