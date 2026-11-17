import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { DEEPSEEK_DEFAULT_BASE_URL } from '@deepseek-ai/dsh-web-search-deepseek';

import { Config } from '../lib/config.js';
import { createRouter } from '../lib/execute.js';
import { SEARCH_BACKENDS } from '../lib/search-backends.js';

import {
  fakeCtx,
  fakeSettings,
  fakeCredentials,
  stubFetch,
  configWith,
} from './helpers/execute-harness.js';

test('note: a throwing logger never breaks the request', async () => {
  const fakeBackend = {
    id: 'fake', label: 'Fake', keyRefsField: 'fakeApiKeyRefs', timeoutField: 'fakeTimeoutMs', defaultTimeoutMs: 5_000,
    async run() { return { sources: [{ url: 'https://fake.example/log' }], truncated: false }; },
  };
  const config = { providerOrder: ['fake'], fakeApiKeyRefs: ['FAKE_KEY'], fakeTimeoutMs: 5_000, cooldownMs: 60_000, searchFallback: false };
  const ctx = fakeCtx({
    credentials: fakeCredentials({ FAKE_KEY: 'fk' }),
    logger: { warn() {}, debug() { throw new Error('logger exploded'); }, info() { throw new Error('logger exploded'); } },
  });
  const router = createRouter(ctx, config, { searchBackends: { fake: fakeBackend } });
  const result = await router.search({ query: 'q' }, undefined);
  assert.equal(result.sources[0].url, 'https://fake.example/log');
});

test('warn: a throwing warn logger never breaks the request', async () => {
  const fakeBackend = {
    id: 'fake',
    label: 'Fake',
    keyRefsField: 'fakeApiKeyRefs',
    timeoutField: 'fakeTimeoutMs',
    defaultTimeoutMs: 5_000,
    async run() {
      return { sources: [{ url: 'https://fake.example/ok' }], truncated: false };
    },
  };
  const config = {
    providerOrder: ['tavlp', 'fake'],
    fakeApiKeyRefs: ['FAKE_KEY'],
    fakeTimeoutMs: 5_000,
    cooldownMs: 60_000,
    searchFallback: false,
  };
  const ctx = fakeCtx({
    credentials: fakeCredentials({ FAKE_KEY: 'fk' }),
    logger: { warn() { throw new Error('warn exploded'); }, debug() {}, info() {} },
  });
  const router = createRouter(ctx, config, { searchBackends: { ...SEARCH_BACKENDS, fake: fakeBackend } });
  const result = await router.search({ query: 'q' }, undefined);
  assert.equal(result.sources[0].url, 'https://fake.example/ok');
});
