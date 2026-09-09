import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function canonicalWorkspace(workspace) {
  const resolved = path.resolve(workspace);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function projectKey(workspace) {
  return crypto.createHash('sha256').update(canonicalWorkspace(workspace)).digest('hex').slice(0, 32);
}

function rootDirectory({ baseDir, env = process.env, home = os.homedir() } = {}) {
  return path.resolve(baseDir || env.ANTIGRAVITY_HOME || path.join(home, '.antigravity-cli'));
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isSafeTaskContainer(container, { tempRoot = os.tmpdir() } = {}) {
  if (!container) return false;
  const resolved = path.resolve(container);
  return inside(tempRoot, resolved) && path.basename(resolved).startsWith('agyc-stage-');
}

export function taskStatePath(workspace, options = {}) {
  return path.join(rootDirectory(options), 'tasks', `${projectKey(workspace)}.json`);
}

function normalizeAttachments(items, container) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const stagedPath = path.resolve(String(item?.stagedPath || ''));
    if (!inside(container, stagedPath)) throw new Error('Interrupted task attachment path is outside its staging container.');
    return {
      name: String(item?.name || ''),
      sourcePath: String(item?.sourcePath || ''),
      stagedPath,
      mimeType: String(item?.mimeType || ''),
      kind: String(item?.kind || ''),
      size: Number(item?.size) || 0
    };
  });
}

async function writeJsonAtomic(file, body) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
  try { await fs.chmod(file, 0o600); } catch {}
}

export async function createTaskStore(workspace, options = {}) {
  const resolvedWorkspace = path.resolve(workspace);
  const file = taskStatePath(resolvedWorkspace, options);
  const tempRoot = options.tempRoot || os.tmpdir();

  async function load() {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      if (parsed?.version !== 1 || typeof parsed.prompt !== 'string' || !parsed.prompt.trim()) {
        throw new Error(`Interrupted task state is invalid: ${file}`);
      }
      if (path.resolve(String(parsed.workspace || '')) !== resolvedWorkspace) {
        throw new Error(`Interrupted task belongs to a different workspace: ${file}`);
      }
      const container = path.resolve(String(parsed.container || ''));
      if (!isSafeTaskContainer(container, { tempRoot })) {
        throw new Error(`Interrupted task staging path is invalid: ${file}`);
      }
      return {
        version: 1,
        workspace: resolvedWorkspace,
        prompt: parsed.prompt,
        container,
        attachments: normalizeAttachments(parsed.attachments, container),
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : null
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) throw new Error(`Interrupted task state is invalid: ${file}`);
      throw error;
    }
  }

  async function save({ prompt, container, attachments = [], createdAt = new Date().toISOString() }) {
    const resolvedContainer = path.resolve(container);
    if (!isSafeTaskContainer(resolvedContainer, { tempRoot })) {
      throw new Error('Refusing to save an interrupted task outside the OS temporary staging area.');
    }
    const body = {
      version: 1,
      workspace: resolvedWorkspace,
      prompt: String(prompt || '').trim(),
      container: resolvedContainer,
      attachments: normalizeAttachments(attachments, resolvedContainer),
      createdAt
    };
    if (!body.prompt) throw new Error('Interrupted task prompt cannot be empty.');
    await writeJsonAtomic(file, body);
    return body;
  }

  async function clear({ removeStage = false } = {}) {
    let current = null;
    if (removeStage) {
      try { current = await load(); } catch {}
    }
    await fs.rm(file, { force: true });
    if (current?.container && isSafeTaskContainer(current.container, { tempRoot })) {
      await fs.rm(current.container, { recursive: true, force: true });
    }
  }

  return { path: file, load, save, clear };
}
