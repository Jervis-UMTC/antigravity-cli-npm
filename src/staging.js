import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { materializeAttachment } from './attachments.js';
import { throwIfAborted } from './cancel.js';

const APPLY_EXCLUDES = new Set(['.git', '.gemini', '.agents', 'node_modules']);
const COPY_IGNORES = new Set(['.gemini', '.agents']);
const DEPENDENCY_DIRS = new Set(['node_modules']);
const execFile = promisify(execFileCallback);

function depth(relative) {
  return relative.split(/[\\/]/).length;
}

function excluded(relative) {
  return relative
    .split(path.sep)
    .filter(Boolean)
    .some((part) => APPLY_EXCLUDES.has(part));
}

function hasPathPart(relative, names) {
  return relative
    .split(path.sep)
    .filter(Boolean)
    .some((part) => names.has(part));
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function assertSafeProjectLinks(root) {
  const queue = [root];
  while (queue.length) {
    const directory = queue.shift();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (hasPathPart(relative, COPY_IGNORES) || hasPathPart(relative, DEPENDENCY_DIRS)) continue;
      if (entry.isSymbolicLink()) {
        const linkTarget = await fs.readlink(absolute);
        if (process.platform === 'win32') {
          throw new Error(`Project contains a symbolic link or junction that cannot be safely isolated on Windows: ${relative}`);
        }
        const resolvedTarget = path.resolve(path.dirname(absolute), linkTarget);
        if (path.isAbsolute(linkTarget) || !inside(root, resolvedTarget)) {
          throw new Error(`Project contains an absolute or external symbolic link that could escape transactional staging: ${relative}`);
        }
        continue;
      }
      if (entry.isDirectory()) queue.push(absolute);
    }
  }
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function fingerprint(target) {
  const stat = await lstatOrNull(target);
  if (!stat) return null;
  if (stat.isDirectory()) return 'dir';
  if (stat.isSymbolicLink()) return `link:${await fs.readlink(target)}`;
  if (stat.isFile()) return `file:${stat.mode}:${await hashFile(target)}`;
  return `other:${stat.mode}`;
}

async function buildManifest(root) {
  const manifest = new Map();

  async function visit(directory, relativeDirectory = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relative = path.join(relativeDirectory, entry.name);
      if (excluded(relative)) continue;
      const absolute = path.join(directory, entry.name);
      manifest.set(relative, await fingerprint(absolute));
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(absolute, relative);
      }
    }
  }

  await visit(root);
  return manifest;
}

function manifestsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

async function clearDirectory(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map((entry) => fs.rm(path.join(directory, entry.name), {
    recursive: true,
    force: true
  })));
}

async function copyDependencyTree(source, destination, realRoot, stageRoot) {
  const links = [];

  const copyFiles = async (sourceDirectory, destinationDirectory) => {
    await fs.mkdir(destinationDirectory, { recursive: true });
    const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(sourceDirectory, entry.name);
      const destinationPath = path.join(destinationDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        links.push({ sourcePath, destinationPath });
        continue;
      }
      if (entry.isDirectory()) {
        await copyFiles(sourcePath, destinationPath);
        continue;
      }
      await fs.cp(sourcePath, destinationPath, {
        force: true,
        errorOnExist: false,
        preserveTimestamps: true
      });
    }
  };

  await copyFiles(source, destination);

  for (const { sourcePath, destinationPath } of links) {
    const linkTarget = await fs.readlink(sourcePath);
    const resolvedTarget = path.resolve(path.dirname(sourcePath), linkTarget);
    if (!inside(realRoot, resolvedTarget)) {
      throw new Error(`Dependency link escapes the project and cannot be isolated safely: ${path.relative(realRoot, sourcePath)}`);
    }
    const stagedTarget = path.join(stageRoot, path.relative(realRoot, resolvedTarget));
    let targetStat;
    try { targetStat = await fs.stat(sourcePath); } catch { targetStat = null; }
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    if (process.platform === 'win32') {
      if (targetStat?.isDirectory()) {
        await fs.symlink(stagedTarget, destinationPath, 'junction');
      } else {
        try {
          await fs.symlink(stagedTarget, destinationPath, 'file');
        } catch (error) {
          if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
          if (!targetStat?.isFile()) throw error;
          await fs.copyFile(resolvedTarget, destinationPath);
        }
      }
    } else {
      const stagedLinkTarget = path.isAbsolute(linkTarget) ? stagedTarget : linkTarget;
      await fs.symlink(stagedLinkTarget, destinationPath, targetStat?.isDirectory() ? 'dir' : 'file');
    }
  }
}

async function copyDirectoryContents(source, destination, relativeDirectory = '', realRoot = source, stageRoot = destination) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const relative = path.join(relativeDirectory, entry.name);
    if (hasPathPart(relative, COPY_IGNORES)) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.name === 'node_modules') {
      await copyDependencyTree(sourcePath, destinationPath, realRoot, stageRoot);
      continue;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await fs.mkdir(destinationPath, { recursive: true });
      await copyDirectoryContents(sourcePath, destinationPath, relative, realRoot, stageRoot);
      continue;
    }
    await fs.cp(sourcePath, destinationPath, {
      recursive: entry.isSymbolicLink(),
      force: true,
      errorOnExist: false,
      preserveTimestamps: true,
      verbatimSymlinks: true
    });
  }
}

async function isolateGitPointer(realRoot, stageRoot) {
  const realGit = path.join(realRoot, '.git');
  const stat = await lstatOrNull(realGit);
  if (!stat?.isFile()) return false;

  const stagedGit = path.join(stageRoot, '.git');
  await fs.rm(stagedGit, { recursive: true, force: true });
  try {
    await execFile('git', ['init', '-q'], {
      cwd: stageRoot,
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    });
  } catch {
    // A disposable staging copy is still safe without Git metadata. The
    // critical invariant is that the real worktree/submodule gitdir pointer
    // is never copied into staging where commands could mutate it.
  }
  return true;
}

function changedPaths(before, after) {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((key) => before.get(key) !== after.get(key));
}

function safeResumeContainer(container) {
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(container);
  const relative = path.relative(tempRoot, resolved);
  return path.basename(resolved).startsWith('agyc-stage-') &&
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function saveManifest(file, manifest) {
  await fs.writeFile(file, `${JSON.stringify([...manifest.entries()])}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function loadManifest(file) {
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(parsed) || parsed.some((item) => !Array.isArray(item) || item.length !== 2)) {
    throw new Error('Interrupted staging baseline is invalid.');
  }
  return new Map(parsed);
}

async function copyForBackup(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, {
    recursive: true,
    force: true,
    errorOnExist: false,
    preserveTimestamps: true,
    verbatimSymlinks: true
  });
}

async function restoreBackup(realRoot, backupRoot, changes, backedUp) {
  for (const relative of [...changes].sort((a, b) => depth(b) - depth(a))) {
    await fs.rm(path.join(realRoot, relative), { recursive: true, force: true });
  }

  for (const relative of [...backedUp].sort((a, b) => depth(a) - depth(b))) {
    const source = path.join(backupRoot, relative);
    const target = path.join(realRoot, relative);
    await copyForBackup(source, target);
  }
}

async function applyEntry(stageRoot, realRoot, relative, finalFingerprint) {
  const source = path.join(stageRoot, relative);
  const target = path.join(realRoot, relative);

  if (finalFingerprint === 'dir') {
    const current = await lstatOrNull(target);
    if (current && !current.isDirectory()) {
      await fs.rm(target, { recursive: true, force: true });
    }
    await fs.mkdir(target, { recursive: true });
    return;
  }

  if (finalFingerprint?.startsWith('link:')) {
    const linkTarget = await fs.readlink(source);
    let type = 'file';
    try {
      type = (await fs.stat(source)).isDirectory() ? 'dir' : 'file';
    } catch {
      // Preserve dangling links as file links when the target cannot be resolved.
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rm(target, { recursive: true, force: true });
    await fs.symlink(linkTarget, target, type);
    return;
  }

  if (finalFingerprint?.startsWith('file:')) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tempTarget = `${target}.agy-${process.pid}-${crypto.randomUUID()}.tmp`;
    const stat = await fs.stat(source);
    await fs.copyFile(source, tempTarget);
    await fs.chmod(tempTarget, stat.mode);
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(tempTarget, target);
  }
}

export async function createStagingWorkspace(realWorkspace, { container: resumeContainer = null } = {}) {
  const realRoot = path.resolve(realWorkspace);
  let container;
  if (resumeContainer) {
    if (!safeResumeContainer(resumeContainer)) {
      throw new Error('Refusing to resume a task from an invalid staging location.');
    }
    container = path.resolve(resumeContainer);
  } else {
    container = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-stage-'));
  }
  const stageRoot = path.join(container, 'workspace');
  const backupRoot = path.join(container, 'rollback');
  const inputRoot = path.join(container, 'inputs');
  const baselinePath = path.join(container, 'baseline.json');
  await fs.mkdir(stageRoot, { recursive: true });
  await fs.mkdir(inputRoot, { recursive: true });

  let baseline = new Map();

  return {
    container,
    workspace: stageRoot,

    async begin() {
      await assertSafeProjectLinks(realRoot);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = await buildManifest(realRoot);
        await clearDirectory(stageRoot);
        await clearDirectory(inputRoot);
        await copyDirectoryContents(realRoot, stageRoot);
        await isolateGitPointer(realRoot, stageRoot);
        const staged = await buildManifest(stageRoot);
        if (manifestsEqual(before, staged)) {
          baseline = before;
          await saveManifest(baselinePath, baseline);
          return;
        }
      }
      throw new Error('Project changed while preparing the hidden workspace. Run the instruction again.');
    },

    async resume() {
      baseline = await loadManifest(baselinePath);
      const current = await buildManifest(realRoot);
      if (!manifestsEqual(current, baseline)) {
        const error = new Error('The real project changed after the interrupted task. The saved task cannot be resumed safely.');
        error.code = 'RESUME_CONFLICT';
        throw error;
      }
      await isolateGitPointer(realRoot, stageRoot);
      return true;
    },

    async stageAttachments(attachments = []) {
      await clearDirectory(inputRoot);
      const staged = [];
      for (let index = 0; index < attachments.length; index += 1) {
        const attachment = attachments[index];
        const safeName = attachment.name.replace(/[<>:\"/\\|?*\x00-\x1f]/g, '_');
        const target = path.join(inputRoot, `${String(index + 1).padStart(2, '0')}-${safeName}`);
        staged.push(await materializeAttachment(attachment, target));
      }
      return staged;
    },

    async commit({ signal } = {}) {
      throwIfAborted(signal);
      const final = await buildManifest(stageRoot);
      const changes = changedPaths(baseline, final);
      if (changes.length === 0) return [];

      for (const relative of changes) {
        throwIfAborted(signal);
        const current = await fingerprint(path.join(realRoot, relative));
        const expected = baseline.get(relative) ?? null;
        if (current !== expected) {
          throw new Error(`Project changed outside this session: ${relative}. No staged changes were applied.`);
        }
      }

      await fs.rm(backupRoot, { recursive: true, force: true });
      await fs.mkdir(backupRoot, { recursive: true });
      const backedUp = [];

      for (const relative of changes) {
        throwIfAborted(signal);
        const source = path.join(realRoot, relative);
        if (await lstatOrNull(source)) {
          await copyForBackup(source, path.join(backupRoot, relative));
          backedUp.push(relative);
        }
      }

      try {
        const removals = changes
          .filter((relative) => !final.has(relative))
          .sort((a, b) => depth(b) - depth(a));
        for (const relative of removals) {
          throwIfAborted(signal);
          await fs.rm(path.join(realRoot, relative), { recursive: true, force: true });
        }

        const directories = changes
          .filter((relative) => final.get(relative) === 'dir')
          .sort((a, b) => depth(a) - depth(b));
        for (const relative of directories) {
          throwIfAborted(signal);
          await applyEntry(stageRoot, realRoot, relative, final.get(relative));
        }

        const files = changes
          .filter((relative) => final.has(relative) && final.get(relative) !== 'dir')
          .sort((a, b) => depth(a) - depth(b));
        for (const relative of files) {
          throwIfAborted(signal);
          await applyEntry(stageRoot, realRoot, relative, final.get(relative));
        }
      } catch (error) {
        await restoreBackup(realRoot, backupRoot, changes, backedUp);
        throw error;
      }

      baseline = final;
      // The real-project publication has already completed successfully.
      // Refreshing the disposable resume manifest is only bookkeeping at
      // this point and must not turn a successful commit into a false error.
      try { await saveManifest(baselinePath, baseline); } catch {}
      return changes;
    },

    async discard() {
      // Nothing in the real project is touched until commit(). begin() replaces
      // this staging tree before the next instruction.
      await clearDirectory(inputRoot);
    },

    async close({ preserve = false } = {}) {
      if (!preserve) await fs.rm(container, { recursive: true, force: true });
    }
  };
}
