import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeApiKeyResolver } from '../lib/official.js';

const ENV = 'DEEPSEEK_API_KEY';

test('official resolver: a literal apiKey wins over everything', async () => {
  const ctx = { get: () => undefined };
  const resolve = makeApiKeyResolver(ctx, { apiKey: 'sk-literal' });
  assert.equal(await resolve(), 'sk-literal');
});

test('official resolver: uses the credentials service when there is no literal', async () => {
  const ctx = {
    get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: 'sk-cred' }) } : undefined),
  };
  const resolve = makeApiKeyResolver(ctx, {});
  assert.equal(await resolve(), 'sk-cred');
});

test('official resolver: falls back to the environment when credentials miss', async () => {
  const prev = process.env[ENV];
  process.env[ENV] = 'sk-env';
  try {
    const ctx = {
      get: (name) => (name === 'credentials' ? { resolve: async () => undefined } : undefined),
    };
    const resolve = makeApiKeyResolver(ctx, {});
    assert.equal(await resolve(), 'sk-env');
  } finally {
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
  }
});

test('official resolver: returns undefined when nothing is configured', async () => {
  const prev = process.env[ENV];
  delete process.env[ENV];
  try {
    const ctx = { get: () => undefined };
    const resolve = makeApiKeyResolver(ctx, {});
    assert.equal(await resolve(), undefined);
  } finally {
    if (prev !== undefined) process.env[ENV] = prev;
  }
});

test('official resolver: an invalid ref name skips credentials and reads that env var', async () => {
  // 引用名里有连字符就不合法，交给 credentials.resolve 会抛 TypeError——必须跳过它，
  // 直接按同名环境变量查。
  const name = 'BAD-NAME';
  const prev = process.env[name];
  process.env[name] = 'sk-weird';
  let credentialsCalled = false;
  try {
    const ctx = {
      get: (key) => (key === 'credentials'
        ? { resolve: async () => { credentialsCalled = true; return { value: 'x' }; } }
        : undefined),
    };
    const resolve = makeApiKeyResolver(ctx, { apiKeyEnv: name });
    assert.equal(await resolve(), 'sk-weird');
    assert.equal(credentialsCalled, false, 'invalid ref must not be handed to the credentials service');
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
});

test('official resolver: a throwing credentials service falls back to the environment', async () => {
  const prev = process.env[ENV];
  process.env[ENV] = 'sk-env2';
  try {
    const ctx = {
      get: (name) => (name === 'credentials'
        ? { resolve: async () => { throw new Error('credential service down'); } }
        : undefined),
    };
    const resolve = makeApiKeyResolver(ctx, {});
    assert.equal(await resolve(), 'sk-env2');
  } finally {
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
  }
});
