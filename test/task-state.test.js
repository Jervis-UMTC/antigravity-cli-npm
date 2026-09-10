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
    assert.equal('sourcePath' in loaded.attachments[0], false);
    assert.doesNotMatch(await fs.readFile(store.path, 'utf8'), /notes\.txt.*sourcePath|sourcePath/);
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

test('task checkpoint rejects a staging path that resolves through a symlink or junction', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-task-link-workspace-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-task-link-state-'));
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-task-link-target-'));
  const link = path.join(os.tmpdir(), `agyc-stage-link-${process.pid}-${Date.now()}`);
  try {
    try {
      await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('symlink/junction creation is not permitted on this host');
        return;
      }
      throw error;
    }
    assert.equal(isSafeTaskContainer(link), false);
    const store = await createTaskStore(workspace, { baseDir: stateRoot });
    await assert.rejects(
      () => store.save({ prompt: 'x', container: link }),
      /outside the OS temporary staging area/
    );
  } finally {
    await fs.rm(link, { recursive: true, force: true }).catch(() => {});
    await fs.rm(target, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});
