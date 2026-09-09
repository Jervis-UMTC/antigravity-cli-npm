import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { conversationAsText, conversationForModel } from './history.js';
import { cancellationError, throwIfAborted } from './cancel.js';

const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const REASONING_BUDGETS = { low: 1024, high: 8192 };
const ANTIGRAVITY_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const ANTIGRAVITY_LOGIN_POLL_MS = 750;
const MAX_LOGIN_CAPTURE_CHARS = 32_000;
const PUBLIC_GEMINI_MODELS_URL = 'https://ai.google.dev/gemini-api/docs/models';
const PUBLIC_MODEL_DISCOVERY_TIMEOUT_MS = 8 * 1000;
const PUBLIC_MODEL_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const ANTIGRAVITY_INSTALL_URLS = {
  win32: 'https://antigravity.google/cli/install.cmd',
  default: 'https://antigravity.google/cli/install.sh'
};
const ANTIGRAVITY_PRINT_TIMEOUT = '10m';
let publicModelsPromise = null;
const healthyBackendPaths = new Set();

export function officialAntigravityBinaryPath({
  platform = process.platform,
  env = process.env,
  home = os.homedir()
} = {}) {
  const override = String(env.ANTIGRAVITY_CLI_BINARY || '').trim();
  if (override) return path.resolve(override);
  if (platform === 'win32') {
    const localAppData = String(env.LOCALAPPDATA || '').trim() || path.join(home, 'AppData', 'Local');
    return path.join(localAppData, 'agy', 'bin', 'agy.exe');
  }
  return path.join(home, '.local', 'bin', 'agy');
}

async function fileExists(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function captureExecutable(executable, args, { cwd = process.cwd(), env = process.env, signal, timeoutMs = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancellationError());
      return;
    }
    const child = spawn(executable, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let exceeded = false;
    let aborted = false;
    let timedOut = false;
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = timeoutMs ? setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs) : null;
    timeout?.unref?.();
    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') > MAX_CAPTURE_BYTES) {
        exceeded = true;
        child.kill();
        return current;
      }
      return next;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (aborted || signal?.aborted) return reject(cancellationError());
      if (timedOut) return reject(new Error(`Provider command timed out after ${timeoutMs} ms.`));
      if (exceeded) return reject(new Error('Provider produced too much output.'));
      resolve({ code, stdout, stderr });
    });
  });
}

export async function installOfficialAntigravityCli({
  platform = process.platform,
  binaryPath = officialAntigravityBinaryPath({ platform }),
  fetchImpl = globalThis.fetch,
  captureImpl = captureExecutable
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Installing the Google Antigravity backend requires fetch support.');
  const url = platform === 'win32' ? ANTIGRAVITY_INSTALL_URLS.win32 : ANTIGRAVITY_INSTALL_URLS.default;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Google Antigravity installer returned HTTP ${response.status}.`);
  const script = await response.text();
  const extension = platform === 'win32' ? '.cmd' : '.sh';
  const tempFile = path.join(os.tmpdir(), `agy-google-backend-${process.pid}-${crypto.randomUUID()}${extension}`);
  const targetDirectory = path.dirname(binaryPath);
  await fs.writeFile(tempFile, script, { encoding: 'utf8', mode: 0o700 });
  try {
    const executable = platform === 'win32' ? 'cmd.exe' : 'sh';
    const args = platform === 'win32'
      ? ['/d', '/s', '/c', `"${tempFile}" --dir "${targetDirectory}" --skip-path --skip-aliases`]
      : [tempFile, '--dir', targetDirectory, '--skip-path', '--skip-aliases'];
    const result = await captureImpl(executable, args, { env: process.env, timeoutMs: 180_000 });
    if (result.code !== 0) {
      const detail = String(result.stderr || result.stdout || '').trim();
      throw new Error(`Google Antigravity backend installation failed${detail ? `: ${detail}` : '.'}`);
    }
  } finally {
    await fs.rm(tempFile, { force: true });
  }
  if (!await fileExists(binaryPath)) {
    throw new Error(`Google Antigravity backend was not installed at ${binaryPath}.`);
  }
  return binaryPath;
}

export async function probeOfficialAntigravityBinary({
  binaryPath = officialAntigravityBinaryPath(),
  captureImpl = captureExecutable
} = {}) {
  if (!await fileExists(binaryPath)) return { ready: false, version: null, error: 'missing' };
  try {
    const result = await captureImpl(binaryPath, ['--version'], { env: googleAccountEnv(process.env), timeoutMs: 10_000 });
    const version = String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null;
    if (result.code !== 0 || !version) return { ready: false, version: null, error: 'unhealthy' };
    return { ready: true, version, error: null };
  } catch (error) {
    return { ready: false, version: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function ensureOfficialAntigravityCli({
  platform = process.platform,
  binaryPath = officialAntigravityBinaryPath({ platform }),
  installImpl = installOfficialAntigravityCli,
  probeImpl = probeOfficialAntigravityBinary,
  env = process.env
} = {}) {
  const useCache = installImpl === installOfficialAntigravityCli && probeImpl === probeOfficialAntigravityBinary;
  if (useCache && healthyBackendPaths.has(binaryPath)) return binaryPath;

  const existing = await probeImpl({ binaryPath });
  if (existing.ready) {
    if (useCache) healthyBackendPaths.add(binaryPath);
    return binaryPath;
  }

  if (String(env.ANTIGRAVITY_CLI_BINARY || '').trim() && await fileExists(binaryPath)) {
    throw new Error(`Configured Google Antigravity backend is not usable: ${binaryPath}`);
  }
  if (await fileExists(binaryPath)) await fs.rm(binaryPath, { force: true });
  const installed = await installImpl({ platform, binaryPath });
  const verified = await probeImpl({ binaryPath: installed });
  if (!verified.ready) throw new Error(`Installed Google Antigravity backend is not usable: ${installed}`);
  if (useCache) healthyBackendPaths.add(installed);
  return installed;
}

export function parseAntigravityModels(text) {
  const models = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const slug = line.trim().split(/\s+/)[0];
    if (!slug) continue;
    const effortVariant = slug.match(/^(gemini-\d+(?:\.\d+)?-(?:flash(?:-lite)?|pro))-(?:low|medium|high)$/i);
    models.push((effortVariant?.[1] || slug).toLowerCase());
  }
  return uniqueModelIds(models);
}

export async function discoverOfficialAntigravityModels({
  ensureImpl = ensureOfficialAntigravityCli,
  captureImpl = captureExecutable
} = {}) {
  const binary = await ensureImpl();
  const result = await captureImpl(binary, ['models'], { env: googleAccountEnv(process.env), timeoutMs: 30_000 });
  if (result.code !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`Google Antigravity model discovery failed${detail ? `: ${detail}` : '.'}`);
  }
  const models = parseAntigravityModels(result.stdout);
  if (!models.length) throw new Error('Google Antigravity returned no available models.');
  return models;
}

function uniqueModelIds(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    let model = String(value || '').trim();
    if (model.startsWith('models/')) model = model.slice('models/'.length);
    if (!model || model === 'none' || seen.has(model)) continue;
    seen.add(model);
    output.push(model);
  }
  return output;
}

export function parsePublicGoogleModels(html) {
  const pattern = /\bgemini-\d+(?:\.\d+)?-(?:flash-lite|flash|pro)(?:-preview)?(?![a-z0-9-])/gi;
  return uniqueModelIds((String(html || '').match(pattern) || []).map((model) => model.toLowerCase()));
}

function loadPublicModelPageWithCurl(url, {
  timeoutMs = PUBLIC_MODEL_DISCOVERY_TIMEOUT_MS,
  platform = process.platform,
  spawnImpl = spawn
} = {}) {
  return new Promise((resolve, reject) => {
    const executable = platform === 'win32' ? 'curl.exe' : 'curl';
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const child = spawnImpl(executable, [
      '-L',
      '--fail',
      '--silent',
      '--show-error',
      '--max-time', String(seconds),
      url
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let exceeded = false;
    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') > PUBLIC_MODEL_PAGE_MAX_BYTES) {
        exceeded = true;
        child.kill();
        return current;
      }
      return next;
    };

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (exceeded) {
        reject(new Error('Google public model catalog response was too large.'));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `curl exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function discoverPublicGoogleModels({
  fetchImpl = globalThis.fetch,
  curlLoader = loadPublicModelPageWithCurl,
  url = PUBLIC_GEMINI_MODELS_URL,
  timeoutMs = PUBLIC_MODEL_DISCOVERY_TIMEOUT_MS,
  platform = process.platform
} = {}) {
  const isDefaultRequest = fetchImpl === globalThis.fetch &&
    curlLoader === loadPublicModelPageWithCurl &&
    url === PUBLIC_GEMINI_MODELS_URL &&
    timeoutMs === PUBLIC_MODEL_DISCOVERY_TIMEOUT_MS &&
    platform === process.platform;

  const discover = async () => {
    let lastError = null;
    const loadWithFetch = async () => {
      if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
      const signal = typeof AbortSignal?.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
      const response = await fetchImpl(url, {
        headers: { accept: 'text/html' },
        signal
      });
      if (!response.ok) throw new Error(`Google public model catalog returned HTTP ${response.status}.`);
      return response.text();
    };
    const loadWithCurl = async () => {
      if (typeof curlLoader !== 'function') throw new Error('curl fallback is unavailable');
      return curlLoader(url, { timeoutMs, platform });
    };

    const attempts = platform === 'win32'
      ? [loadWithCurl, loadWithFetch]
      : [loadWithFetch, loadWithCurl];

    for (const attempt of attempts) {
      try {
        const models = parsePublicGoogleModels(await attempt());
        if (models.length) return models;
        lastError = new Error('Google public model catalog contained no general Gemini Pro/Flash models.');
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('Google public model discovery failed.');
  };

  if (!isDefaultRequest) return discover();
  if (!publicModelsPromise) publicModelsPromise = discover();
  try {
    return await publicModelsPromise;
  } catch (error) {
    publicModelsPromise = null;
    throw error;
  }
}

export async function discoverGoogleModels({
  fetchImpl = globalThis.fetch,
  curlLoader = loadPublicModelPageWithCurl,
  publicModelsUrl = PUBLIC_GEMINI_MODELS_URL,
  publicTimeoutMs = PUBLIC_MODEL_DISCOVERY_TIMEOUT_MS,
  platform = process.platform,
  officialModelsLoader = discoverOfficialAntigravityModels
} = {}) {
  const [officialResult, publicResult] = await Promise.allSettled([
    officialModelsLoader(),
    discoverPublicGoogleModels({
      fetchImpl,
      curlLoader,
      url: publicModelsUrl,
      timeoutMs: publicTimeoutMs,
      platform
    })
  ]);

  if (officialResult.status === 'fulfilled' && officialResult.value.length) {
    return uniqueModelIds(officialResult.value);
  }

  const publicModels = publicResult.status === 'fulfilled' ? publicResult.value : [];
  const models = uniqueModelIds(publicModels);
  if (models.length) return models;

  if (officialResult.status === 'rejected') throw officialResult.reason;
  if (publicResult.status === 'rejected') throw publicResult.reason;
  return [];
}

async function loadAntigravityPty() {
  try {
    return await import('@lydell/node-pty');
  } catch {
    throw new Error('Official Antigravity browser sign-in support is unavailable. Reinstall antigravity-cli-npm.');
  }
}

function stripTerminalControl(value) {
  return String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runOfficialAntigravityLogin({
  ensureImpl = ensureOfficialAntigravityCli,
  accountProbe = probeOfficialAntigravityAccount,
  ptyLoader = loadAntigravityPty,
  timeoutMs = ANTIGRAVITY_LOGIN_TIMEOUT_MS,
  pollMs = ANTIGRAVITY_LOGIN_POLL_MS,
  env = process.env
} = {}) {
  if (await accountProbe({ ensureImpl })) return true;

  const binary = await ensureImpl();
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-official-login-'));
  let terminal = null;
  let output = '';
  let exited = false;
  let exitCode = null;

  try {
    const ptyModule = await ptyLoader();
    const spawnPty = ptyModule.spawn || ptyModule.default?.spawn;
    if (typeof spawnPty !== 'function') {
      throw new Error('Official Antigravity browser sign-in support could not initialize a hidden terminal.');
    }

    terminal = spawnPty(binary, [], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd,
      env: googleAccountEnv(env)
    });

    terminal.onData?.((chunk) => {
      output = `${output}${String(chunk || '')}`.slice(-MAX_LOGIN_CAPTURE_CHARS);
    });
    terminal.onExit?.((event) => {
      exited = true;
      exitCode = event?.exitCode ?? null;
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await accountProbe({ ensureImpl: async () => binary })) return true;
      if (exited) break;
      await wait(pollMs);
    }

    if (await accountProbe({ ensureImpl: async () => binary })) return true;

    const detail = stripTerminalControl(output).slice(-1500);
    if (exited) {
      throw new Error(
        `Official Antigravity sign-in ended before authentication completed${exitCode === null ? '' : ` (exit ${exitCode})`}${detail ? `: ${detail}` : '.'}`
      );
    }
    throw new Error(`Official Antigravity sign-in timed out${detail ? `: ${detail}` : '.'}`);
  } finally {
    try { terminal?.kill?.(); } catch {}
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

function normalizeReasoning(value) {
  const level = String(value || 'auto').trim().toLowerCase();
  if (!['auto', 'low', 'high'].includes(level)) {
    throw new Error('Reasoning must be auto, low, or high.');
  }
  return level;
}

function reasoningTargets(model) {
  if (model === 'auto' || model === 'pro') {
    return ['gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-2.5-pro'];
  }
  if (model === 'flash') {
    return ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash'];
  }
  if (model === 'flash-lite') {
    return ['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];
  }
  return [model];
}

export function buildReasoningDefaults(model, reasoning) {
  const level = normalizeReasoning(reasoning);
  if (level === 'auto') return null;

  const customOverrides = reasoningTargets(model || 'auto').map((target) => {
    const thinkingConfig = /^gemini-3(?:\.|-|$)/.test(target)
      ? { thinkingLevel: level.toUpperCase() }
      : { thinkingBudget: REASONING_BUDGETS[level] };

    return {
      match: { model: target },
      modelConfig: {
        generateContentConfig: { thinkingConfig }
      }
    };
  });

  return {
    general: {
      enableNotifications: false,
      topicUpdateNarration: false
    },
    ui: {
      dynamicWindowTitle: false,
      hideBanner: true,
      hideFooter: true,
      inlineThinkingMode: 'off',
      loadingPhrases: 'off',
      showSpinner: false,
      showStatusInTitle: false,
      showUserIdentity: false
    },
    modelConfigs: { customOverrides }
  };
}

export function googleAccountEnv(source = process.env, defaultsPath = null) {
  const env = { ...source, NO_COLOR: '1' };

  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  delete env.GOOGLE_GENAI_USE_VERTEXAI;
  delete env.GOOGLE_GENAI_USE_GCA;
  delete env.GOOGLE_APPLICATION_CREDENTIALS;

  if (defaultsPath && !env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH) {
    env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = defaultsPath;
  }

  return env;
}

export function parseAntigravityJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Google Antigravity returned no output.');
  let body;
  try {
    body = JSON.parse(trimmed);
  } catch {
    throw new Error(`Google Antigravity returned invalid JSON: ${trimmed.slice(0, 500)}`);
  }
  if (body.status && body.status !== 'SUCCESS') {
    throw new Error(body.error || `Google Antigravity request ended with status ${body.status}.`);
  }
  if (body.error) throw new Error(typeof body.error === 'string' ? body.error : JSON.stringify(body.error));
  if (typeof body.response !== 'string') throw new Error('Google Antigravity response did not contain response text.');
  return {
    response: body.response.trim() || '(no response)',
    conversationId: typeof body.conversation_id === 'string' && body.conversation_id ? body.conversation_id : null
  };
}

export async function resolveAntigravityModel(model, {
  modelsLoader = discoverOfficialAntigravityModels
} = {}) {
  const requested = String(model || 'auto').trim().toLowerCase();
  if (!requested || requested === 'auto') return null;
  if (!['pro', 'flash', 'flash-lite'].includes(requested)) return requested;
  const models = await modelsLoader();
  const suffix = requested === 'flash-lite' ? 'flash-lite' : requested;
  const resolved = [...models]
    .filter((candidate) => new RegExp(`^gemini-\\d+(?:\\.\\d+)?-${suffix}$`, 'i').test(candidate))
    .sort((left, right) => {
      const leftMatch = left.match(/^gemini-(\d+)(?:\.(\d+))?-/i);
      const rightMatch = right.match(/^gemini-(\d+)(?:\.(\d+))?-/i);
      return Number(rightMatch?.[1] || 0) - Number(leftMatch?.[1] || 0) ||
        Number(rightMatch?.[2] || 0) - Number(leftMatch?.[2] || 0);
    })[0];
  if (!resolved) throw new Error(`The ${requested} model is not currently available to this Google subscription.`);
  return resolved;
}

export function buildAntigravityArgs({
  prompt,
  model = null,
  reasoning = 'auto',
  yes = false,
  attachments = [],
  conversationId = null
}) {
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--disable-slash-commands',
    '--print-timeout', ANTIGRAVITY_PRINT_TIMEOUT
  ];
  if (model) args.push('--model', model);
  if (reasoning !== 'auto') args.push('--effort', normalizeReasoning(reasoning));
  if (yes) args.push('--dangerously-skip-permissions');
  if (conversationId) args.push('--conversation', conversationId);
  const directories = [...new Set(attachments.map((attachment) => path.dirname(attachment.stagedPath)).filter(Boolean))];
  for (const directory of directories) args.push('--add-dir', directory);
  return args;
}

async function probeOfficialAntigravityAccount({
  ensureImpl = ensureOfficialAntigravityCli,
  captureImpl = captureExecutable
} = {}) {
  try {
    const binary = await ensureImpl();
    const result = await captureImpl(binary, ['models'], { env: googleAccountEnv(process.env), timeoutMs: 15_000 });
    return result.code === 0 && parseAntigravityModels(result.stdout).length > 0;
  } catch {
    return false;
  }
}

export async function verifyOfficialAntigravitySubscription({
  ensureImpl = ensureOfficialAntigravityCli,
  captureImpl = captureExecutable
} = {}) {
  const binary = await ensureImpl();
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-login-check-'));
  try {
    const result = await captureImpl(binary, [
      '-p', 'Reply with exactly OK.',
      '--output-format', 'json',
      '--disable-slash-commands',
      '--print-timeout', '1m'
    ], { cwd, env: googleAccountEnv(process.env), timeoutMs: 75_000 });
    if (result.code !== 0) {
      const detail = String(result.stderr || result.stdout || '').trim();
      throw new Error(`Google subscription verification failed${detail ? `: ${detail}` : '.'}`);
    }
    const parsed = parseAntigravityJson(result.stdout);
    if (!/^OK\.?$/i.test(parsed.response.trim())) {
      throw new Error('Google subscription verification returned an unexpected response.');
    }
    return true;
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

export async function googleRuntimeStatus({
  binaryPath = officialAntigravityBinaryPath(),
  captureImpl = captureExecutable
} = {}) {
  const backend = await probeOfficialAntigravityBinary({ binaryPath, captureImpl });
  if (!backend.ready) return { backend: backend.error === 'missing' ? 'missing' : 'broken', account: 'unknown', version: null };
  try {
    const result = await captureImpl(binaryPath, ['models'], { env: googleAccountEnv(process.env), timeoutMs: 15_000 });
    const connected = result.code === 0 && parseAntigravityModels(result.stdout).length > 0;
    return { backend: 'ready', account: connected ? 'connected' : 'login-required', version: backend.version };
  } catch {
    return { backend: 'ready', account: 'login-required', version: backend.version };
  }
}

export async function loginWithGoogle({
  notify = () => {},
  officialProbe = probeOfficialAntigravityAccount,
  officialLogin = runOfficialAntigravityLogin,
  officialVerify = verifyOfficialAntigravitySubscription
} = {}) {
  if (await officialProbe()) return;

  notify('Complete sign-in in your browser.');
  await officialLogin({ accountProbe: officialProbe });

  if (!await officialProbe()) {
    throw new Error('Official Antigravity sign-in completed without creating a usable subscription session.');
  }

  await officialVerify();
}

export class GoogleAccountAgent {
  constructor({
    workspace,
    displayWorkspace,
    model = 'auto',
    reasoning = 'auto',
    yes = false,
    history = [],
    backend = {}
  }) {
    this.workspace = workspace;
    this.displayWorkspace = displayWorkspace || workspace;
    this.model = model || 'auto';
    this.reasoning = normalizeReasoning(reasoning);
    this.yes = yes;
    this.conversationId = null;
    this.seedHistory = conversationForModel(history);
    this.ensureBackend = backend.ensure || ensureOfficialAntigravityCli;
    this.captureBackend = backend.capture || captureExecutable;
    this.modelsLoader = backend.models || discoverOfficialAntigravityModels;
  }

  setModel(model) {
    if (!model || !model.trim()) throw new Error('Model name cannot be empty.');
    this.model = model.trim();
  }

  setReasoning(reasoning) {
    this.reasoning = normalizeReasoning(reasoning);
  }

  setApproval(yes) {
    this.yes = Boolean(yes);
  }

  clear() {
    this.conversationId = null;
    this.seedHistory = [];
  }

  async prompt(text, { attachments = [], signal } = {}) {
    throwIfAborted(signal);
    const binary = await this.ensureBackend();
    const effectiveModel = await resolveAntigravityModel(this.model, { modelsLoader: this.modelsLoader });
    const previousConversation = !this.conversationId && this.seedHistory.length
      ? `\n\nPrevious conversation:\n${conversationAsText(this.seedHistory)}`
      : '';
    const attachmentInstruction = attachments.length
      ? `\n\nAttachments for this request:\n${attachments.map((attachment) => `- ${attachment.name}: ${attachment.stagedPath}`).join('\n')}\nRead every listed attachment with the read_file tool before answering. Images and PDFs are multimodal inputs. Do not copy attachment files into the project.`
      : '';
    const hiddenInstruction = `Operate on this staged copy as the project at ${this.displayWorkspace}. Do not mention staging paths, conversation storage, or internal tool activity. Complete the user's coding request, validate it, and return only the concise final result.${previousConversation}${attachmentInstruction}\n\nUser request:\n${text}`;
    const args = buildAntigravityArgs({
      prompt: hiddenInstruction,
      model: effectiveModel,
      reasoning: this.reasoning,
      yes: this.yes,
      attachments,
      conversationId: this.conversationId
    });
    const result = await this.captureBackend(binary, args, {
      cwd: this.workspace,
      env: googleAccountEnv(process.env),
      signal
    });

    if (result.code !== 0) {
      let structuredError = '';
      try {
        const body = JSON.parse(String(result.stdout || '').trim());
        structuredError = typeof body.error === 'string' ? body.error : '';
      } catch {}
      const detail = (structuredError || result.stderr || result.stdout || '').trim();
      if (/auth(?:entication)? required|not authenticated|sign.?in|log.?in|credential/i.test(detail)) {
        const error = new Error('Google subscription session became unavailable. Retry the request; official Antigravity sign-in will reopen automatically if needed.');
        error.code = 'GOOGLE_AUTH_REQUIRED';
        throw error;
      }
      throw new Error(`Google subscription request failed${detail ? `: ${detail}` : '.'}`);
    }

    const parsed = parseAntigravityJson(result.stdout);
    this.conversationId = parsed.conversationId || this.conversationId;
    return parsed.response;
  }
}
