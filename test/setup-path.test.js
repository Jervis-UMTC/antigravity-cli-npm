import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureWindowsPath,
  shouldConfigureWindowsPath,
  windowsNpmBinPath,
  windowsPathContains
} from '../scripts/setup-path.js';

test('Windows npm bin path uses npm prefix and falls back to APPDATA', () => {
  assert.equal(
    windowsNpmBinPath({ npm_config_prefix: 'C:\\Users\\me\\AppData\\Roaming\\npm' }),
    'C:\\Users\\me\\AppData\\Roaming\\npm'
  );
  assert.equal(
    windowsNpmBinPath({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }),
    'C:\\Users\\me\\AppData\\Roaming\\npm'
  );
});

test('PATH matching is case-insensitive and expands Windows environment references', () => {
  const env = { APPDATA: 'C:\\Users\\Me\\AppData\\Roaming' };
  assert.equal(
    windowsPathContains('C:\\Windows;%APPDATA%\\npm', 'c:\\users\\me\\appdata\\roaming\\npm\\', env),
    true
  );
});

test('PATH setup supports an explicit non-mutating CI/install opt-out', () => {
  assert.equal(shouldConfigureWindowsPath({
    platform: 'win32',
    packageRoot: 'C:\\work\\antigravity-cli-npm',
    env: { INIT_CWD: 'C:\\work\\antigravity-cli-npm', AGYC_SKIP_PATH_SETUP: '1' }
  }), false);
});

test('PATH setup only runs for direct package work or global installs on Windows', () => {
  const packageRoot = 'C:\\work\\antigravity-cli-npm';
  assert.equal(shouldConfigureWindowsPath({
    platform: 'win32',
    packageRoot,
    env: { INIT_CWD: 'C:\\work\\antigravity-cli-npm' }
  }), true);
  assert.equal(shouldConfigureWindowsPath({
    platform: 'win32',
    packageRoot,
    env: { npm_config_global: 'true' }
  }), true);
  assert.equal(shouldConfigureWindowsPath({
    platform: 'win32',
    packageRoot,
    env: { INIT_CWD: 'C:\\work\\consumer' }
  }), false);
  assert.equal(shouldConfigureWindowsPath({
    platform: 'linux',
    packageRoot,
    env: { INIT_CWD: packageRoot }
  }), false);
});

test('configureWindowsPath still checks persistent user PATH when current shell has a temporary npm entry', () => {
  let writes = 0;
  const result = configureWindowsPath({
    platform: 'win32',
    packageRoot: 'C:\\work\\antigravity-cli-npm',
    env: {
      INIT_CWD: 'C:\\work\\antigravity-cli-npm',
      APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
      PATH: 'C:\\Windows;%APPDATA%\\npm'
    },
    persistImpl: () => {
      writes += 1;
      return { ok: true, changed: false };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(writes, 1);
});

test('configureWindowsPath persists exactly the missing npm command directory', () => {
  let persisted = null;
  const result = configureWindowsPath({
    platform: 'win32',
    packageRoot: 'C:\\work\\antigravity-cli-npm',
    env: {
      INIT_CWD: 'C:\\work\\antigravity-cli-npm',
      npm_config_prefix: 'C:\\Users\\me\\AppData\\Roaming\\npm',
      PATH: 'C:\\Windows'
    },
    persistImpl: (target) => {
      persisted = target;
      return { ok: true, changed: true };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(persisted, 'C:\\Users\\me\\AppData\\Roaming\\npm');
});
