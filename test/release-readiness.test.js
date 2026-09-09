import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('release metadata is explicit and production files include hardening modules', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.publishConfig.access, 'public');
  assert.equal(pkg.bin.agy, 'bin/agy.js');
  assert.equal(pkg.dependencies.fflate, '0.8.3');
  assert.ok(pkg.files.includes('LICENSE'));
  for (const file of ['LICENSE', 'src/settings.js', 'src/init.js', 'src/cancel.js']) {
    await fs.access(path.join(ROOT, file));
  }
});

test('npm dry-run tarball contains runtime/license files and excludes tests/provider state', async () => {
  const executable = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm.cmd pack --dry-run --ignore-scripts --json']
    : ['pack', '--dry-run', '--ignore-scripts', '--json'];
  const { stdout } = await exec(executable, args, {
    cwd: ROOT,
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 5 * 1024 * 1024
  });
  const report = JSON.parse(stdout)[0];
  const names = report.files.map((entry) => entry.path.replace(/\\/g, '/'));
  for (const required of [
    'LICENSE', 'README.md', 'CHANGELOG.md', 'bin/agy.js',
    'src/cli.js', 'src/settings.js', 'src/init.js', 'src/cancel.js'
  ]) assert.ok(names.includes(required), `missing ${required}`);
  assert.equal(names.some((name) => name.startsWith('test/')), false);
  assert.equal(names.some((name) => /(^|\/)\.git(?:\/|$)/.test(name)), false);
  assert.equal(names.some((name) => /(^|\/)\.gemini(?:\/|$)/.test(name)), false);
  assert.equal(names.some((name) => /(^|\/)\.agents(?:\/|$)/.test(name)), false);
});
