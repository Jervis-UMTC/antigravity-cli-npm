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

test('resume rejects a tampered baseline manifest with traversal paths', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-resume-tamper-'));
  const first = await createStagingWorkspace(workspace);
  let resumed = null;
  try {
    await fs.writeFile(path.join(workspace, 'app.txt'), 'before\n', 'utf8');
    await first.begin();
    const container = first.container;
    await first.close({ preserve: true });
    await fs.writeFile(
      path.join(container, 'baseline.json'),
      `${JSON.stringify([['../outside.txt', 'dir']])}\n`,
      'utf8'
    );

    resumed = await createStagingWorkspace(workspace, { container });
    await assert.rejects(() => resumed.resume(), /baseline is invalid/);
  } finally {
    await resumed?.close().catch(() => {});
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('resume rejects duplicate baseline manifest paths', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-resume-duplicate-'));
  await fs.writeFile(path.join(workspace, 'app.txt'), 'before\n', 'utf8');
  const first = await createStagingWorkspace(workspace);
  let resumed = null;
  try {
    await first.begin();
    const container = first.container;
    const baselinePath = path.join(container, 'baseline.json');
    const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
    baseline.push(baseline[0]);
    await first.close({ preserve: true });
    await fs.writeFile(baselinePath, `${JSON.stringify(baseline)}\n`, 'utf8');

    resumed = await createStagingWorkspace(workspace, { container });
    await assert.rejects(() => resumed.resume(), /duplicate paths/);
  } finally {
    await resumed?.close().catch(() => {});
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('resume refuses a staging container that is a symlink or junction', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-resume-link-workspace-'));
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-resume-link-target-'));
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
    await assert.rejects(
      () => createStagingWorkspace(workspace, { container: link }),
      /invalid staging location/
    );
  } finally {
    await fs.rm(link, { recursive: true, force: true }).catch(() => {});
    await fs.rm(target, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('commit revalidates immediately before publication and preserves a racing external edit', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-race-'));
  const file = path.join(workspace, 'app.txt');
  await fs.writeFile(file, 'before\n', 'utf8');
  let raced = false;
  const staging = await createStagingWorkspace(workspace, {
    hooks: {
      async beforeApply(relative) {
        if (!raced && relative === 'app.txt') {
          raced = true;
          await fs.writeFile(file, 'external\n', 'utf8');
        }
      }
    }
  });

  try {
    await staging.begin();
    await fs.writeFile(path.join(staging.workspace, 'app.txt'), 'staged\n', 'utf8');
    await assert.rejects(() => staging.commit(), /changed outside this session/);
    assert.equal(await fs.readFile(file, 'utf8'), 'external\n');
  } finally {
    await staging.close();
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

test('staging rejects project links that could escape the transactional copy', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-link-project-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-link-outside-'));
  await fs.writeFile(path.join(outside, 'sentinel.txt'), 'unchanged\n', 'utf8');
  const link = path.join(workspace, 'external-link');
  try {
    try {
      await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('symbolic links are not available in this environment');
        return;
      }
      throw error;
    }
    const staging = await createStagingWorkspace(workspace);
    try {
      await assert.rejects(
        () => staging.begin(),
        process.platform === 'win32'
          ? /cannot be safely isolated on Windows/
          : /could escape transactional staging/
      );
      assert.equal(await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'unchanged\n');
    } finally {
      await staging.close();
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('relative internal symbolic links remain inside staging on supported platforms', { skip: process.platform === 'win32' }, async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-link-internal-'));
  await fs.mkdir(path.join(workspace, 'target'));
  await fs.writeFile(path.join(workspace, 'target', 'value.txt'), 'before\n', 'utf8');
  await fs.symlink('target', path.join(workspace, 'alias'), 'dir');
  const staging = await createStagingWorkspace(workspace);
  try {
    await staging.begin();
    await fs.writeFile(path.join(staging.workspace, 'alias', 'value.txt'), 'staged\n', 'utf8');
    assert.equal(await fs.readFile(path.join(workspace, 'target', 'value.txt'), 'utf8'), 'before\n');
    assert.equal(await fs.readFile(path.join(staging.workspace, 'target', 'value.txt'), 'utf8'), 'staged\n');
  } finally {
    await staging.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('internal dependency links are rewritten into the transactional staging copy', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-excluded-link-'));
  try {
    const target = path.join(workspace, 'node_modules', '.store', 'linked-package');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'value.txt'), 'real\n', 'utf8');
    try {
      await fs.symlink(target, path.join(workspace, 'node_modules', 'linked-package'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('symbolic links are not available in this environment');
        return;
      }
      throw error;
    }
    await fs.writeFile(path.join(workspace, 'app.txt'), 'before\n', 'utf8');
    const staging = await createStagingWorkspace(workspace);
    try {
      await staging.begin();
      assert.equal(await fs.readFile(path.join(staging.workspace, 'app.txt'), 'utf8'), 'before\n');
      await fs.writeFile(path.join(staging.workspace, 'node_modules', 'linked-package', 'value.txt'), 'staged\n', 'utf8');
      assert.equal(await fs.readFile(path.join(staging.workspace, 'node_modules', '.store', 'linked-package', 'value.txt'), 'utf8'), 'staged\n');
      assert.equal(await fs.readFile(path.join(target, 'value.txt'), 'utf8'), 'real\n');
    } finally {
      await staging.close();
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('external dependency links are rejected instead of pointing staged commands outside the project', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-dependency-escape-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-dependency-outside-'));
  try {
    await fs.mkdir(path.join(workspace, 'node_modules'), { recursive: true });
    try {
      await fs.symlink(outside, path.join(workspace, 'node_modules', 'external-package'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('symbolic links are not available in this environment');
        return;
      }
      throw error;
    }
    const staging = await createStagingWorkspace(workspace);
    try {
      await assert.rejects(() => staging.begin(), /Dependency link escapes the project/);
    } finally {
      await staging.close();
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('dependency link cycles are preserved as links without recursive copy expansion', { skip: process.platform === 'win32' }, async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-stage-dependency-cycle-'));
  try {
    const a = path.join(workspace, 'node_modules', '.store', 'a');
    const b = path.join(workspace, 'node_modules', '.store', 'b');
    await fs.mkdir(path.join(a, 'node_modules'), { recursive: true });
    await fs.mkdir(path.join(b, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(a, 'a.txt'), 'a\n', 'utf8');
    await fs.writeFile(path.join(b, 'b.txt'), 'b\n', 'utf8');
    await fs.symlink(path.relative(path.join(a, 'node_modules'), b), path.join(a, 'node_modules', 'b'), 'dir');
    await fs.symlink(path.relative(path.join(b, 'node_modules'), a), path.join(b, 'node_modules', 'a'), 'dir');
    const staging = await createStagingWorkspace(workspace);
    try {
      await staging.begin();
      assert.equal(await fs.readFile(path.join(staging.workspace, 'node_modules', '.store', 'a', 'node_modules', 'b', 'b.txt'), 'utf8'), 'b\n');
      assert.equal(await fs.readFile(path.join(staging.workspace, 'node_modules', '.store', 'b', 'node_modules', 'a', 'a.txt'), 'utf8'), 'a\n');
    } finally {
      await staging.close();
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
