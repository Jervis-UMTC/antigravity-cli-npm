import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskStore, isSafeTaskContainer, taskStatePath } from '../src/task-state.js';

test('task checkpoint saves and restores only a safe OS-temporary staging container', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-task-workspace-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-task-state-'));
  const container = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-stage-'));
  const stagedPath = path.join(container, 'inputs', '01-notes.txt');
  await fs.mkdir(path.dirname(stagedPath), { recursive: true });
  await fs.writeFile(stagedPath, 'notes', 'utf8');

  try {
    const store = await createTaskStore(workspace, { baseDir: stateRoot });
    await store.save({
      prompt: 'finish the refactor',
      container,
      attachments: [{
        name: 'notes.txt',
        sourcePath: path.join(workspace, 'notes.txt'),
        stagedPath,
        mimeType: 'text/plain',
        kind: 'text',
        size: 5
      }]
    });
    const loaded = await store.load();
    assert.equal(loaded.prompt, 'finish the refactor');
    assert.equal(loaded.container, container);
    assert.equal(loaded.attachments[0].stagedPath, stagedPath);
    assert.match(store.path, /tasks/);
    assert.equal(store.path, taskStatePath(workspace, { baseDir: stateRoot }));
    assert.equal(isSafeTaskContainer(container), true);

    await store.clear({ removeStage: true });
    assert.equal(await store.load(), null);
    await assert.rejects(() => fs.stat(container), /ENOENT/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
    await fs.rm(container, { recursive: true, force: true });
  }
});

test('task checkpoint refuses arbitrary non-staging directories', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-task-unsafe-workspace-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-task-unsafe-state-'));
  const unsafe = await fs.mkdtemp(path.join(os.tmpdir(), 'ordinary-temp-'));
  try {
    const store = await createTaskStore(workspace, { baseDir: stateRoot });
    await assert.rejects(() => store.save({ prompt: 'x', container: unsafe }), /outside the OS temporary staging area/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
    await fs.rm(unsafe, { recursive: true, force: true });
  }
});

test('stale task checkpoint self-clears when its staging directory is already gone', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-task-stale-workspace-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-task-stale-state-'));
  const container = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-stage-'));
  try {
    const store = await createTaskStore(workspace, { baseDir: stateRoot });
    await store.save({ prompt: 'finish this task', container });
    await fs.rm(container, { recursive: true, force: true });
    assert.equal(await store.load(), null);
    await assert.rejects(() => fs.stat(store.path), /ENOENT/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
    await fs.rm(container, { recursive: true, force: true });
  }
});

test('Windows task checkpoint accepts the same workspace with different path casing', { skip: process.platform !== 'win32' }, async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-task-case-workspace-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-task-case-state-'));
  const container = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-stage-'));
  try {
    const upperStore = await createTaskStore(workspace.toUpperCase(), { baseDir: stateRoot });
    await upperStore.save({ prompt: 'resume me', container });
    const normalStore = await createTaskStore(workspace, { baseDir: stateRoot });
    assert.equal((await normalStore.load()).prompt, 'resume me');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
    await fs.rm(container, { recursive: true, force: true });
  }
});

test('task checkpoint claim is atomic so concurrent project tasks cannot overwrite each other', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-task-concurrent-workspace-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-task-concurrent-state-'));
  const firstContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-stage-'));
  const secondContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-stage-'));
  try {
    const firstStore = await createTaskStore(workspace, { baseDir: stateRoot });
    const secondStore = await createTaskStore(workspace, { baseDir: stateRoot });
    const results = await Promise.allSettled([
      firstStore.save({ prompt: 'first task', container: firstContainer }),
      secondStore.save({ prompt: 'second task', container: secondContainer })
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected.reason.code, 'TASK_ALREADY_ACTIVE');
    assert.match((await firstStore.load()).prompt, /^(first|second) task$/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
    await fs.rm(firstContainer, { recursive: true, force: true });
    await fs.rm(secondContainer, { recursive: true, force: true });
  }
});
