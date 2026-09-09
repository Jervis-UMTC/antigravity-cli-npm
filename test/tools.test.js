import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTools } from '../src/tools.js';

test('file tools stay inside the workspace and can edit/search files', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-tools-'));
  const tools = await createTools({ workspace, approveCommand: async () => true });

  await tools.execute('write_file', { path: 'src/app.js', content: 'const value = 1;\n' });
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

test('run_command respects approval', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-command-'));
  const denied = await createTools({ workspace, approveCommand: async () => false });
  const result = await denied.execute('run_command', { command: 'node -e "console.log(123)"' });
  assert.equal(result, 'Command denied by user.');
  await fs.rm(workspace, { recursive: true, force: true });
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
