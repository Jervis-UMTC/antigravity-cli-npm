import assert from 'node:assert/strict';
import test from 'node:test';
import { provisionInstall } from '../scripts/postinstall.js';

test('postinstall provisions PATH and the official backend without a separate setup command', async () => {
  const out = [];
  const err = [];
  const calls = [];
  const result = await provisionInstall({
    platform: 'win32',
    env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
    configurePath: ({ platform, env }) => {
      calls.push(['path', platform, env.APPDATA]);
      return { ok: true, changed: true, target: 'C:\\Users\\me\\AppData\\Roaming\\npm' };
    },
    ensureBackend: async ({ platform, env }) => {
      calls.push(['backend', platform, env.APPDATA]);
      return 'C:\\Users\\me\\AppData\\Local\\antigravity-cli-npm\\provider\\agy.exe';
    },
    stdout: { write: (value) => out.push(value) },
    stderr: { write: (value) => err.push(value) }
  });

  assert.equal(result.backend, 'ready');
  assert.deepEqual(calls, [
    ['path', 'win32', 'C:\\Users\\me\\AppData\\Roaming'],
    ['backend', 'win32', 'C:\\Users\\me\\AppData\\Roaming']
  ]);
  assert.match(out.join(''), /added .*npm.*Open a new terminal once/);
  assert.equal(err.length, 0);
});

test('postinstall keeps npm installation usable when provider download is temporarily unavailable', async () => {
  const err = [];
  const result = await provisionInstall({
    platform: 'linux',
    env: {},
    configurePath: () => ({ ok: true, changed: false, skipped: true }),
    ensureBackend: async () => { throw new Error('offline'); },
    stderr: { write: (value) => err.push(value) }
  });

  assert.equal(result.backend, 'deferred');
  assert.match(err.join(''), /first Google request will retry automatically/);
});

test('postinstall allows explicit provider preinstall opt-out', async () => {
  let backendCalls = 0;
  const result = await provisionInstall({
    platform: 'linux',
    env: { AGYC_SKIP_PROVIDER_INSTALL: 'true' },
    configurePath: () => ({ ok: true, changed: false, skipped: true }),
    ensureBackend: async () => { backendCalls += 1; return '/provider/agy'; }
  });

  assert.equal(result.backend, 'skipped');
  assert.equal(backendCalls, 0);
});
