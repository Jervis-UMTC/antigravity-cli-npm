import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStagingWorkspace } from '../src/staging.js';

test('staging and commit work in an ordinary folder with no Git metadata', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-no-git-'));
  await fs.writeFile(path.join(workspace, 'plain.txt'), 'before', 'utf8');
  const staging = await createStagingWorkspace(workspace);

  try {
    await assert.rejects(() => fs.stat(path.join(workspace, '.git')), /ENOENT/);
    await staging.begin();
    await fs.writeFile(path.join(staging.workspace, 'plain.txt'), 'after', 'utf8');
    await staging.commit();
    assert.equal(await fs.readFile(path.join(workspace, 'plain.txt'), 'utf8'), 'after');
    await assert.rejects(() => fs.stat(path.join(workspace, '.git')), /ENOENT/);
  } finally {
    await staging.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('staged edits are invisible until commit', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-test-'));
  await fs.writeFile(path.join(workspace, 'app.txt'), 'before', 'utf8');
  const staging = await createStagingWorkspace(workspace);

  try {
    await staging.begin();
    await fs.writeFile(path.join(staging.workspace, 'app.txt'), 'after', 'utf8');
    await fs.writeFile(path.join(staging.workspace, 'new.txt'), 'new', 'utf8');

    assert.equal(await fs.readFile(path.join(workspace, 'app.txt'), 'utf8'), 'before');
    await assert.rejects(() => fs.readFile(path.join(workspace, 'new.txt'), 'utf8'), /ENOENT/);

    await staging.commit();
    assert.equal(await fs.readFile(path.join(workspace, 'app.txt'), 'utf8'), 'after');
    assert.equal(await fs.readFile(path.join(workspace, 'new.txt'), 'utf8'), 'new');
  } finally {
    await staging.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('discard leaves the real project unchanged', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-discard-'));
  await fs.writeFile(path.join(workspace, 'app.txt'), 'before', 'utf8');
  const staging = await createStagingWorkspace(workspace);

  try {
    await staging.begin();
    await fs.writeFile(path.join(staging.workspace, 'app.txt'), 'staged', 'utf8');
    await staging.discard();
    assert.equal(await fs.readFile(path.join(workspace, 'app.txt'), 'utf8'), 'before');
  } finally {
    await staging.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('git metadata in the disposable copy is never published', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-git-'));
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  await fs.writeFile(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  await fs.writeFile(path.join(workspace, 'app.txt'), 'before', 'utf8');
  const staging = await createStagingWorkspace(workspace);

  try {
    await staging.begin();
    await fs.writeFile(path.join(staging.workspace, '.git', 'HEAD'), 'ref: refs/heads/hidden-work\n', 'utf8');
    await fs.mkdir(path.join(staging.workspace, '.agents'), { recursive: true });
    await fs.writeFile(path.join(staging.workspace, '.agents', 'provider-state.json'), '{}\n', 'utf8');
    await fs.writeFile(path.join(staging.workspace, 'app.txt'), 'after', 'utf8');
    await staging.commit();

    assert.equal(await fs.readFile(path.join(workspace, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main\n');
    await assert.rejects(() => fs.stat(path.join(workspace, '.agents')), /ENOENT/);
    assert.equal(await fs.readFile(path.join(workspace, 'app.txt'), 'utf8'), 'after');
  } finally {
    await staging.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('linked worktree or submodule .git pointer is never copied into disposable staging', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-git-pointer-'));
  const externalGit = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-external-git-'));
  const sentinel = path.join(externalGit, 'sentinel.txt');
  await fs.writeFile(sentinel, 'real metadata\n', 'utf8');
  await fs.writeFile(path.join(workspace, '.git'), `gitdir: ${externalGit}\n`, 'utf8');
  await fs.writeFile(path.join(workspace, 'app.txt'), 'before\n', 'utf8');
  const staging = await createStagingWorkspace(workspace);

  try {
    await staging.begin();
    const stagedGit = await fs.lstat(path.join(staging.workspace, '.git')).catch(() => null);
    assert.equal(stagedGit?.isFile() || false, false);
    await fs.writeFile(path.join(staging.workspace, 'app.txt'), 'after\n', 'utf8');
    await staging.commit();
    assert.equal(await fs.readFile(path.join(workspace, '.git'), 'utf8'), `gitdir: ${externalGit}\n`);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'real metadata\n');
    assert.equal(await fs.readFile(path.join(workspace, 'app.txt'), 'utf8'), 'after\n');
  } finally {
    await staging.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(externalGit, { recursive: true, force: true });
  }
});

test('attachment copies stay outside both the real project and staged project tree', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-input-project-'));
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-input-source-'));
  const sourcePath = path.join(sourceRoot, 'photo.png');
  await fs.writeFile(sourcePath, Buffer.from([1, 2, 3]));
  const staging = await createStagingWorkspace(workspace);

  try {
    await staging.begin();
    const [attachment] = await staging.stageAttachments([{
      sourcePath,
      name: 'photo.png',
      mimeType: 'image/png',
      kind: 'image',
      size: 3
    }]);

    assert.equal(attachment.stagedPath.startsWith(`${staging.workspace}${path.sep}`), false);
    assert.deepEqual(await fs.readdir(workspace), []);
  } finally {
    await staging.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(sourceRoot, { recursive: true, force: true });
  }
});

test('commit refuses to overwrite an external concurrent change', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-conflict-'));
  await fs.writeFile(path.join(workspace, 'app.txt'), 'before', 'utf8');
  const staging = await createStagingWorkspace(workspace);

  try {
    await staging.begin();
    await fs.writeFile(path.join(staging.workspace, 'app.txt'), 'staged', 'utf8');
    await fs.writeFile(path.join(workspace, 'app.txt'), 'external', 'utf8');

    await assert.rejects(() => staging.commit(), /changed outside this session/);
    assert.equal(await fs.readFile(path.join(workspace, 'app.txt'), 'utf8'), 'external');
  } finally {
    await staging.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('an interrupted staging workspace can resume and publish only when the real baseline is unchanged', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-resume-'));
  await fs.writeFile(path.join(workspace, 'app.txt'), 'before\n', 'utf8');
  const first = await createStagingWorkspace(workspace);
  let resumed = null;
  try {
    await first.begin();
    await fs.writeFile(path.join(first.workspace, 'app.txt'), 'after crash\n', 'utf8');
    const container = first.container;
    await first.close({ preserve: true });

    resumed = await createStagingWorkspace(workspace, { container });
    await resumed.resume();
    assert.equal(await fs.readFile(path.join(workspace, 'app.txt'), 'utf8'), 'before\n');
    await resumed.commit();
    assert.equal(await fs.readFile(path.join(workspace, 'app.txt'), 'utf8'), 'after crash\n');
  } finally {
    await resumed?.close().catch(() => {});
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('resume refuses to publish when the real project changed after interruption', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-resume-conflict-'));
  await fs.writeFile(path.join(workspace, 'app.txt'), 'before\n', 'utf8');
  const first = await createStagingWorkspace(workspace);
  let resumed = null;
  try {
    await first.begin();
    await fs.writeFile(path.join(first.workspace, 'app.txt'), 'staged\n', 'utf8');
    const container = first.container;
    await first.close({ preserve: true });
    await fs.writeFile(path.join(workspace, 'app.txt'), 'external\n', 'utf8');

    resumed = await createStagingWorkspace(workspace, { container });
    await assert.rejects(() => resumed.resume(), (error) => error?.code === 'RESUME_CONFLICT');
    assert.equal(await fs.readFile(path.join(workspace, 'app.txt'), 'utf8'), 'external\n');
  } finally {
    await resumed?.close().catch(() => {});
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('cancellation before publication leaves the real project unchanged', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-cancel-'));
  await fs.writeFile(path.join(workspace, 'app.txt'), 'before\n', 'utf8');
  const staging = await createStagingWorkspace(workspace);
  try {
    await staging.begin();
    await fs.writeFile(path.join(staging.workspace, 'app.txt'), 'staged\n', 'utf8');
    await fs.writeFile(path.join(staging.workspace, 'new.txt'), 'new\n', 'utf8');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => staging.commit({ signal: controller.signal }),
      (error) => error?.name === 'AbortError'
    );
    assert.equal(await fs.readFile(path.join(workspace, 'app.txt'), 'utf8'), 'before\n');
    await assert.rejects(() => fs.stat(path.join(workspace, 'new.txt')), /ENOENT/);
  } finally {
    await staging.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
