import assert from 'node:assert/strict';
import test from 'node:test';
import { isSensitiveEnvironmentName, subprocessEnvironment } from '../src/environment.js';

test('subprocess environment removes secret-like variables while preserving ordinary runtime values', () => {
  const env = subprocessEnvironment({
    PATH: 'runtime-path',
    HOME: '/home/example',
    SAFE_FLAG: 'visible',
    GITHUB_TOKEN: 'hidden-token',
    AWS_SECRET_ACCESS_KEY: 'hidden-secret',
    OPENAI_API_KEY: 'hidden-key',
    DATABASE_URL: 'postgres://user:pass@example/db',
    PGPASSWORD: 'hidden-password'
  });

  assert.equal(env.PATH, 'runtime-path');
  assert.equal(env.HOME, '/home/example');
  assert.equal(env.SAFE_FLAG, 'visible');
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.PGPASSWORD, undefined);
});

test('explicit AGYC_PASSTHROUGH_ENV opt-in restores only named sensitive variables', () => {
  const env = subprocessEnvironment({
    AGYC_PASSTHROUGH_ENV: 'GITHUB_TOKEN, NEXT_PUBLIC_API_KEY',
    GITHUB_TOKEN: 'allowed-token',
    NEXT_PUBLIC_API_KEY: 'allowed-public-key',
    AWS_SECRET_ACCESS_KEY: 'still-hidden'
  });

  assert.equal(env.GITHUB_TOKEN, 'allowed-token');
  assert.equal(env.NEXT_PUBLIC_API_KEY, 'allowed-public-key');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.AGYC_PASSTHROUGH_ENV, undefined);
});

test('sensitive environment-name detection covers common credential conventions', () => {
  for (const name of ['CI_JOB_TOKEN', 'AZURE_CLIENT_SECRET', 'PGPASSWORD', 'DATABASE_URL', 'GOOGLE_APPLICATION_CREDENTIALS']) {
    assert.equal(isSensitiveEnvironmentName(name), true, name);
  }
  assert.equal(isSensitiveEnvironmentName('PATH'), false);
  assert.equal(isSensitiveEnvironmentName('GOOGLE_CLOUD_PROJECT'), false);
});
