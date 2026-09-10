import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const VALID_REASONING = new Set(['auto', 'low', 'high']);
const VALID_AUTH = new Set(['auto', 'google', 'api-key']);
const VALID_APPROVAL = new Set(['ask', 'yes']);
const SETTINGS_VERSION = 1;

function rootDirectory({ baseDir, env = process.env, home = os.homedir() } = {}) {
  return path.resolve(baseDir || env.ANTIGRAVITY_HOME || path.join(home, '.antigravity-cli'));
}

function normalizeSettings(value) {
  const input = value && typeof value === 'object' ? value : {};
  const result = {};
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const reasoning = String(input.reasoning || '').trim().toLowerCase();
  const auth = String(input.auth || '').trim().toLowerCase();
  const approval = String(input.approval || '').trim().toLowerCase();
  const turbo = typeof input.turbo === 'boolean' ? input.turbo : null;
  if (model) result.model = model;
  if (VALID_REASONING.has(reasoning)) result.reasoning = reasoning;
  if (VALID_AUTH.has(auth)) result.auth = auth;
  if (VALID_APPROVAL.has(approval)) result.approval = approval;
  if (turbo !== null) result.turbo = turbo;
  return result;
}

async function writeJsonAtomic(file, body) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
  try { await fs.chmod(file, 0o600); } catch {}
}

export function settingsPath(options = {}) {
  return path.join(rootDirectory(options), 'settings.json');
}

export async function createSettingsStore(options = {}) {
  const file = settingsPath(options);

  async function load() {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      if (parsed?.version !== undefined && parsed.version !== SETTINGS_VERSION) {
        throw new Error(`Unsupported settings file version ${String(parsed.version)}: ${file}`);
      }
      return normalizeSettings(parsed);
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      if (error instanceof SyntaxError) throw new Error(`Settings file is invalid: ${file}`, { cause: error });
      throw error;
    }
  }

  async function save(value) {
    const normalized = normalizeSettings(value);
    if (Object.keys(normalized).length === 0) {
      await fs.rm(file, { force: true });
      return normalized;
    }
    await writeJsonAtomic(file, { version: SETTINGS_VERSION, ...normalized });
    return normalized;
  }

  async function update(patch) {
    const current = await load();
    const next = { ...current, ...(patch || {}) };
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === undefined || value === '') delete next[key];
    }
    return save(next);
  }

  return { path: file, load, save, update };
}

export function mergeRuntimePreferences(parsed, stored = {}, env = process.env) {
  const options = { ...parsed };
  const envAuth = String(env.ANTIGRAVITY_AUTH || '').trim();
  const envModel = String(env.ANTIGRAVITY_MODEL || '').trim();
  const envReasoning = String(env.ANTIGRAVITY_REASONING || '').trim();

  options.auth = options.auth || envAuth || stored.auth || 'google';
  options.model = options.model || envModel || stored.model || 'gemini-3.8-flash';
  options.reasoning = options.reasoning || envReasoning || stored.reasoning || 'high';
  if (options.turbo === null || options.turbo === undefined) options.turbo = stored.turbo === true;
  if (options.yes === null || options.yes === undefined) options.yes = options.turbo || stored.approval === 'yes';
  if (options.turbo) options.yes = true;
  return options;
}
