import assert from 'node:assert/strict';
import { exec as execCallback, execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createTools } from '../src/tools.js';

const exec = promisify(execCallback);
const execFile = promisify(execFileCallback);

function hostCommandSandboxFactory({ environment }) {
  return {
    runProcess({ executable, args, cwd, signal, timeoutMs }) {
      return execFile(executable, args, {
        cwd,
        env: environment,
        signal,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024
      });
    },
    runCommand({ command, cwd, signal, timeoutMs }) {
      return exec(command, {
        cwd,
        env: environment,
        signal,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024
      });
    }
  };
}

test('file tools stay inside the workspace and can edit/search files', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-tools-'));
  const tools = await createTools({ workspace, approveCommand: async () => true });

  assert.match(
    await tools.execute('write_file', { path: 'src/app.js', content: 'const value = 1;\n' }),
    /^Created src[\\/]app\.js\.$/
  );
  assert.match(
    await tools.execute('write_file', { path: 'src/app.js', content: 'const value = 1;\n' }),
    /^Updated src[\\/]app\.js\.$/
  );
  await tools.execute('replace_in_file', {
    path: 'src/app.js',
    old_text: 'value = 1',
    new_text: 'value = 2'
  });

  const read = await tools.execute('read_file', { path: 'src/app.js' });
  assert.match(read, /value = 2/);

  const search = await tools.execute('search_files', { query: 'value = 2' });
  assert.match(search, /src[\\/]app\.js:1/);

  await assert.rejects(
    () => tools.execute('read_file', { path: '../outside.txt' }),
    /outside the project/
  );

  await fs.rm(workspace, { recursive: true, force: true });
});

test('agent file tools hide common secret files but allow non-secret env templates', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-sensitive-files-'));
  try {
    await fs.writeFile(path.join(workspace, '.env'), 'API_KEY=do-not-send\n', 'utf8');
    await fs.writeFile(path.join(workspace, '.env.example'), 'API_KEY=replace-me\n', 'utf8');
    await fs.writeFile(path.join(workspace, 'app.txt'), 'safe content\n', 'utf8');
    const tools = await createTools({ workspace });

    await assert.rejects(() => tools.execute('read_file', { path: '.env' }), /sensitive project path/);
    const listing = await tools.execute('list_files', { path: '.' });
    assert.doesNotMatch(listing, /^\.env$/m);
    assert.match(listing, /^\.env\.example$/m);
    const search = await tools.execute('search_files', { query: 'do-not-send' });
    assert.doesNotMatch(search, /do-not-send/);
    assert.match(await tools.execute('read_file', { path: '.env.example' }), /replace-me/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('file listings explicitly report truncation instead of silently stopping', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-list-truncated-'));
  try {
    await fs.writeFile(path.join(workspace, 'a.txt'), 'a', 'utf8');
    await fs.writeFile(path.join(workspace, 'b.txt'), 'b', 'utf8');
    const tools = await createTools({ workspace });
    const listing = await tools.execute('list_files', { max_entries: 1 });
    assert.match(listing, /listing truncated at 1 entries/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('run_command respects approval', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-command-'));
  const denied = await createTools({ workspace, approveCommand: async () => false });
  const result = await denied.execute('run_command', { command: 'node -e "console.log(123)"' });
  assert.equal(result, 'Command denied by user.');
  await fs.rm(workspace, { recursive: true, force: true });
});

test('project subprocesses do not inherit secret-like environment variables by default', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-command-env-'));
  try {
    const environment = {
      ...process.env,
      AGYC_VISIBLE_TEST_VALUE: 'visible',
      AGYC_TEST_SECRET_TOKEN: 'hidden'
    };
    const tools = await createTools({
      workspace,
      approveCommand: async () => true,
      environment,
      commandSandboxFactory: hostCommandSandboxFactory
    });
    const result = await tools.execute('run_process', {
      executable: process.execPath,
      args: ['-e', 'console.log(`${process.env.AGYC_VISIBLE_TEST_VALUE || "missing"}:${process.env.AGYC_TEST_SECRET_TOKEN || "missing"}`)']
    });
    assert.match(result, /visible:missing/);

    const allowed = await createTools({
      workspace,
      approveCommand: async () => true,
      environment: { ...environment, AGYC_PASSTHROUGH_ENV: 'AGYC_TEST_SECRET_TOKEN' },
      commandSandboxFactory: hostCommandSandboxFactory
    });
    const allowedResult = await allowed.execute('run_process', {
      executable: process.execPath,
      args: ['-e', 'console.log(process.env.AGYC_TEST_SECRET_TOKEN || "missing")']
    });
    assert.match(allowedResult, /hidden/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('project_overview gives compact repository context without command approval', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-overview-'));
  try {
    await fs.mkdir(path.join(workspace, 'src'));
    await fs.writeFile(path.join(workspace, 'src', 'app.js'), 'console.log("ok");\n', 'utf8');
    await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({
      name: 'overview-fixture',
      version: '1.2.3',
      scripts: { test: 'node --test', lint: 'eslint .' }
    }), 'utf8');
    const tools = await createTools({ workspace, approveCommand: async () => false });
    const overview = await tools.execute('project_overview', {});
    assert.match(overview, /overview-fixture@1\.2\.3/);
    assert.match(overview, /scripts: test, lint/);
    assert.match(overview, /\[dir\] src/);
    assert.match(overview, /\.js:1/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('large file reads are bounded and point the agent to line ranges', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-read-bound-'));
  try {
    await fs.writeFile(path.join(workspace, 'large.txt'), `${'x'.repeat(200)}\n`.repeat(1000), 'utf8');
    const tools = await createTools({ workspace });
    const result = await tools.execute('read_file', { path: 'large.txt' });
    assert.ok(result.length < 121_000);
    assert.match(result, /file read truncated; use start_line\/end_line/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('line ranges can inspect files larger than the normal 1 MiB read limit', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-read-large-range-'));
  try {
    const file = path.join(workspace, 'huge.txt');
    const lines = Array.from({ length: 12_000 }, (_value, index) => `line-${index + 1}-${'x'.repeat(100)}`);
    await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
    const tools = await createTools({ workspace });
    await assert.rejects(() => tools.execute('read_file', { path: 'huge.txt' }), /Use start_line\/end_line/);
    const result = await tools.execute('read_file', { path: 'huge.txt', start_line: 10_001, end_line: 10_003 });
    assert.match(result, /10001: line-10001-/);
    assert.match(result, /10003: line-10003-/);
    assert.doesNotMatch(result, /10004: line-10004-/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('validation discovery, symbol navigation, validated rollback patching, and argv process execution work together', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-agent-tools-'));
  try {
    await fs.mkdir(path.join(workspace, 'src'));
    await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: {
      test: 'node --test',
      typecheck: 'tsc --noEmit',
      verify: 'npm test && npm run typecheck',
      'test:integration': 'node --test test/integration'
    } }), 'utf8');
    await fs.writeFile(path.join(workspace, 'src', 'one.js'), 'export function calculate() { return 1; }\nconsole.log(calculate());\n', 'utf8');
    await fs.writeFile(path.join(workspace, 'src', 'two.js'), 'const value = calculate();\n', 'utf8');
    const tools = await createTools({
      workspace,
      approveCommand: async () => true,
      commandSandboxFactory: hostCommandSandboxFactory
    });

    const checks = await tools.execute('discover_checks', {});
    assert.match(checks, /npm test/);
    assert.match(checks, /npm run typecheck/);
    assert.match(checks, /npm run verify/);
    assert.match(checks, /npm run test:integration/);

    const symbol = await tools.execute('find_symbol', { name: 'calculate' });
    assert.match(symbol, /one\.js:1/);
    const references = await tools.execute('find_references', { name: 'calculate' });
    assert.match(references, /one\.js:1/);
    assert.match(references, /two\.js:1/);

    const patch = await tools.execute('apply_patch', { changes: [
      { path: 'src/one.js', old_text: 'return 1', new_text: 'return 2' },
      { path: 'src/two.js', old_text: 'const value', new_text: 'const result' }
    ] });
    assert.match(patch, /2 patch hunks across 2 files/);
    assert.match(await fs.readFile(path.join(workspace, 'src', 'one.js'), 'utf8'), /return 2/);
    assert.match(await fs.readFile(path.join(workspace, 'src', 'two.js'), 'utf8'), /const result/);

    const processResult = await tools.execute('run_process', {
      executable: process.execPath,
      args: ['-e', 'console.log("ARGV_OK")']
    });
    assert.match(processResult, /ARGV_OK/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('apply_patch validates every hunk before writing any file', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-patch-atomic-'));
  try {
    await fs.writeFile(path.join(workspace, 'one.txt'), 'one\n', 'utf8');
    await fs.writeFile(path.join(workspace, 'two.txt'), 'two\n', 'utf8');
    const tools = await createTools({ workspace });
    await assert.rejects(() => tools.execute('apply_patch', { changes: [
      { path: 'one.txt', old_text: 'one', new_text: 'changed' },
      { path: 'two.txt', old_text: 'missing', new_text: 'changed' }
    ] }), /Could not find/);
    assert.equal(await fs.readFile(path.join(workspace, 'one.txt'), 'utf8'), 'one\n');
    assert.equal(await fs.readFile(path.join(workspace, 'two.txt'), 'utf8'), 'two\n');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('aborted tool execution does not start a shell command', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-tools-abort-'));
  try {
    const tools = await createTools({ workspace, approveCommand: async () => true });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => tools.execute('run_command', { command: 'node -e "process.exit(99)"' }, { signal: controller.signal }),
      (error) => error?.name === 'AbortError'
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('long command output preserves both the beginning and failure summary at the end', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-tools-long-output-'));
  try {
    const tools = await createTools({
      workspace,
      approveCommand: async () => true,
      commandSandbox: {
        runProcess: async () => ({
          stdout: 'BEGIN\n' + 'x'.repeat(100000) + '\nFINAL_FAILURE_SUMMARY\n',
          stderr: ''
        })
      }
    });
    const result = await tools.execute('run_process', {
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("BEGIN\\n" + "x".repeat(100000) + "\\nFINAL_FAILURE_SUMMARY\\n")']
    });
    assert.match(result, /^BEGIN/);
    assert.match(result, /truncated \d+ chars; showing final output below/);
    assert.match(result, /FINAL_FAILURE_SUMMARY\s*$/);
    assert.ok(result.length < 81_000);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
