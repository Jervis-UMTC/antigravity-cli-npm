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
  assert.equal(pkg.name, 'antigyc');
  assert.equal(pkg.version, '0.1.3');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.publishConfig.access, 'public');
  assert.equal(pkg.repository.url, 'git+https://github.com/Jervis-UMTC/antigravity-cli-npm.git');
  assert.equal(pkg.bugs.url, 'https://github.com/Jervis-UMTC/antigravity-cli-npm/issues');
  assert.equal(pkg.homepage, 'https://github.com/Jervis-UMTC/antigravity-cli-npm#readme');
  assert.doesNotMatch(pkg.scripts['release:check'], /npm publish/);
  assert.match(pkg.scripts['release:publish-check'], /npm publish --dry-run --ignore-scripts --json/);
  assert.match(pkg.scripts.lint, /eslint/);
  assert.match(pkg.scripts.coverage, /c8 --check-coverage/);
  assert.match(pkg.scripts['release:check'], /npm run lint/);
  assert.match(pkg.scripts['release:check'], /npm run coverage/);
  assert.equal(pkg.engines.node, '>=20.11.0 <21 || >=22 <23 || >=24 <25');
  assert.equal(pkg.scripts.prepare, undefined);
  assert.equal(pkg.scripts.postinstall, 'node scripts/postinstall.js');
  assert.equal(pkg.bin.antigyc, 'bin/agy.js');
  assert.equal(pkg.bin['antigravity-cli-npm'], undefined);
  assert.equal(pkg.bin.agy, undefined);
  assert.equal(pkg.bin.antigravity, undefined);
  assert.equal(pkg.dependencies.fflate, '0.8.3');
  assert.equal(pkg.dependencies['@lydell/node-pty'], '1.1.0');
  assert.equal(pkg.dependencies['@anthropic-ai/sandbox-runtime'], '0.0.75');
  assert.equal(pkg.dependencies['@google/gemini-cli'], undefined);
  assert.ok(pkg.keywords.includes('antigyc'));

  for (const runtimeFile of ['src/agent.js', 'src/google-agent.js']) {
    const runtime = await fs.readFile(path.join(ROOT, runtimeFile), 'utf8');
    assert.equal(runtime.includes("'(no response)'"), false, `${runtimeFile} must not emit a fake no-response placeholder`);
  }

  const lock = JSON.parse(await fs.readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const changelog = await fs.readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.match(changelog, new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')}(?:\\s|-)+`, 'm'));
  const pty = lock.packages['node_modules/@lydell/node-pty'];
  for (const platformPackage of [
    '@lydell/node-pty-darwin-arm64', '@lydell/node-pty-darwin-x64',
    '@lydell/node-pty-linux-arm64', '@lydell/node-pty-linux-x64',
    '@lydell/node-pty-win32-arm64', '@lydell/node-pty-win32-x64'
  ]) {
    assert.equal(pty.optionalDependencies[platformPackage], '1.1.0');
    assert.ok(lock.packages[`node_modules/${platformPackage}`], `missing ${platformPackage} from lockfile`);
  }

  assert.ok(pkg.files.includes('LICENSE'));
  for (const file of ['LICENSE', 'src/settings.js', 'src/init.js', 'src/cancel.js', 'src/command-child.js', 'src/command-sandbox.js', 'src/doctor.js', 'src/task-state.js', 'scripts/postinstall.js']) {
    await fs.access(path.join(ROOT, file));
  }

  const workflow = await fs.readFile(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  for (const runner of ['ubuntu-latest', 'macos-latest', 'windows-latest']) assert.match(workflow, new RegExp(runner));
  assert.match(workflow, /node: \[20, 22, 24\]/);
  assert.match(workflow, /npm audit --audit-level=moderate/);
  assert.match(workflow, /AGYC_SKIP_PROVIDER_INSTALL/);
  assert.match(workflow, /AGYC_SKIP_PATH_SETUP/);
  assert.match(workflow, /npm run lint/);
  assert.match(workflow, /npm run coverage/);
  assert.match(workflow, /bubblewrap socat ripgrep/);
  assert.match(workflow, /apparmor_restrict_unprivileged_userns/);
  assert.match(pkg.scripts.check, /src\/doctor\.js/);
  assert.match(pkg.scripts.check, /src\/events\.js/);
  assert.match(pkg.scripts.check, /src\/task-state\.js/);
  assert.match(pkg.scripts.check, /src\/command-sandbox\.js/);
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
    'src/cli.js', 'src/settings.js', 'src/init.js', 'src/cancel.js', 'src/doctor.js', 'src/task-state.js'
  ]) assert.ok(names.includes(required), `missing ${required}`);
  assert.equal(names.some((name) => name.startsWith('test/')), false);
  assert.equal(names.some((name) => /(^|\/)\.git(?:\/|$)/.test(name)), false);
  assert.equal(names.some((name) => /(^|\/)\.gemini(?:\/|$)/.test(name)), false);
  assert.equal(names.some((name) => /(^|\/)\.agents(?:\/|$)/.test(name)), false);
});
