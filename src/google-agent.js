import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { conversationAsText, conversationForModel } from './history.js';
import { cancellationError, throwIfAborted } from './cancel.js';

const require = createRequire(import.meta.url);
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const REASONING_BUDGETS = { low: 1024, high: 8192 };
const GOOGLE_OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SIGN_IN_SUCCESS_URL = 'https://developers.google.com/gemini-code-assist/auth_success_gemini';
const GOOGLE_SIGN_IN_FAILURE_URL = 'https://developers.google.com/gemini-code-assist/auth_failure_gemini';
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const GOOGLE_CREDENTIAL_REFRESH_SKEW_MS = 5 * 60 * 1000;
const PUBLIC_GEMINI_MODELS_URL = 'https://ai.google.dev/gemini-api/docs/models';
const PUBLIC_MODEL_DISCOVERY_TIMEOUT_MS = 8 * 1000;
const PUBLIC_MODEL_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const ANTIGRAVITY_INSTALL_URLS = {
  win32: 'https://antigravity.google/cli/install.cmd',
  default: 'https://antigravity.google/cli/install.sh'
};
const ANTIGRAVITY_PRINT_TIMEOUT = '10m';
let oauthMetadataPromise = null;
let bundledModelsPromise = null;
let publicModelsPromise = null;
const healthyBackendPaths = new Set();

function geminiPackageDir() {
  let packagePath;
  try {
    packagePath = require.resolve('@google/gemini-cli/package.json');
  } catch {
    throw new Error('Google account support is unavailable because @google/gemini-cli is not installed. Reinstall antigravity-cli-npm.');
  }
  return path.dirname(packagePath);
}

function geminiEntryPath() {
  return path.join(geminiPackageDir(), 'bundle', 'gemini.js');
}

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

export async function discoverBundledGoogleModels({ entryPath = geminiEntryPath() } = {}) {
  if (entryPath === geminiEntryPath() && bundledModelsPromise) return bundledModelsPromise;

  const discover = async () => {
    const bundleDir = path.dirname(entryPath);
    const entry = await fs.readFile(entryPath, 'utf8');
    const imported = [...new Set(
      [...entry.matchAll(/["']\.\/([A-Za-z0-9_-]+\.js)["']/g)].map((match) => match[1])
    )];

    for (const name of imported) {
      try {
        const module = await import(pathToFileURL(path.join(bundleDir, name)).href);
        const definitions = module.DEFAULT_MODEL_CONFIGS?.modelDefinitions;
        if (!definitions || typeof definitions !== 'object') continue;

        const models = Object.entries(definitions)
          .filter(([id, definition]) => /^(?:gemini|gemma)-/i.test(id) && definition?.isVisible === true)
          .map(([id]) => id);
        if (models.length) return uniqueModelIds(models);
      } catch {
        // Try the source-level fallback below if a provider chunk cannot be imported.
      }
    }

    const models = [];
    const constantPattern = /(?:DEFAULT|PREVIEW|SECONDARY)_GEMINI[A-Z0-9_]*_MODEL\s*=\s*["']([^"']+)["']/g;
    for (const name of imported) {
      let text;
      try {
        text = await fs.readFile(path.join(bundleDir, name), 'utf8');
      } catch {
        continue;
      }
      for (const match of text.matchAll(constantPattern)) {
        if (/^gemini-\d/i.test(match[1])) models.push(match[1]);
      }
    }
    return uniqueModelIds(models);
  };

  if (entryPath !== geminiEntryPath()) return discover();
  bundledModelsPromise = discover();
  try {
    return await bundledModelsPromise;
  } catch (error) {
    bundledModelsPromise = null;
    throw error;
  }
}

export async function discoverGoogleModels({
  entryPath = geminiEntryPath(),
  fetchImpl = globalThis.fetch,
  curlLoader = loadPublicModelPageWithCurl,
  publicModelsUrl = PUBLIC_GEMINI_MODELS_URL,
  publicTimeoutMs = PUBLIC_MODEL_DISCOVERY_TIMEOUT_MS,
  platform = process.platform,
  officialModelsLoader = discoverOfficialAntigravityModels
} = {}) {
  const [officialResult, publicResult, bundledResult] = await Promise.allSettled([
    officialModelsLoader(),
    discoverPublicGoogleModels({
      fetchImpl,
      curlLoader,
      url: publicModelsUrl,
      timeoutMs: publicTimeoutMs,
      platform
    }),
    discoverBundledGoogleModels({ entryPath })
  ]);

  if (officialResult.status === 'fulfilled' && officialResult.value.length) {
    return uniqueModelIds(officialResult.value);
  }

  const publicModels = publicResult.status === 'fulfilled' ? publicResult.value : [];
  const bundledModels = bundledResult.status === 'fulfilled' ? bundledResult.value : [];
  const models = uniqueModelIds([...publicModels, ...bundledModels]);
  if (models.length) return models;

  if (officialResult.status === 'rejected') throw officialResult.reason;
  if (bundledResult.status === 'rejected') throw bundledResult.reason;
  if (publicResult.status === 'rejected') throw publicResult.reason;
  return [];
}

function parseOauthMetadata(text) {
  const clientId = text.match(/OAUTH_CLIENT_ID\s*=\s*["']([^"']+)["']/)?.[1];
  const clientSecret = text.match(/OAUTH_CLIENT_SECRET\s*=\s*["']([^"']+)["']/)?.[1];
  const scopeBody = text.match(/OAUTH_SCOPE\s*=\s*\[([\s\S]*?)\];/)?.[1];
  const scopes = scopeBody
    ? [...scopeBody.matchAll(/["']([^"']+)["']/g)].map((match) => match[1])
    : [];
  if (!clientId || !clientSecret || scopes.length === 0) return null;

  return {
    clientId,
    clientSecret,
    scopes,
    authorizationUrl: GOOGLE_OAUTH_AUTHORIZE_URL,
    tokenUrl: GOOGLE_OAUTH_TOKEN_URL,
    successUrl: text.match(/SIGN_IN_SUCCESS_URL\s*=\s*["']([^"']+)["']/)?.[1] || GOOGLE_SIGN_IN_SUCCESS_URL,
    failureUrl: text.match(/SIGN_IN_FAILURE_URL\s*=\s*["']([^"']+)["']/)?.[1] || GOOGLE_SIGN_IN_FAILURE_URL
  };
}

export async function loadGeminiOAuthMetadata() {
  if (oauthMetadataPromise) return oauthMetadataPromise;

  oauthMetadataPromise = (async () => {
    const bundleDir = path.join(geminiPackageDir(), 'bundle');
    const entry = await fs.readFile(path.join(bundleDir, 'gemini.js'), 'utf8');
    const chunkNames = [...new Set(
      [...entry.matchAll(/["']\.\/(chunk-[A-Za-z0-9_-]+\.js)["']/g)].map((match) => match[1])
    )];

    for (const chunkName of chunkNames) {
      const candidate = path.join(bundleDir, chunkName);
      const text = await fs.readFile(candidate, 'utf8');
      if (!text.includes('OAUTH_CLIENT_ID')) continue;
      const metadata = parseOauthMetadata(text);
      if (metadata) return metadata;
    }

    throw new Error('This @google/gemini-cli build does not contain the OAuth metadata required for Google sign-in. Reinstall the supported package version and try again.');
  })();

  try {
    return await oauthMetadataPromise;
  } catch (error) {
    oauthMetadataPromise = null;
    throw error;
  }
}

export function geminiOAuthCredentialsPath({ env = process.env, home = os.homedir() } = {}) {
  const providerHome = env.GEMINI_CLI_HOME || home;
  return path.join(providerHome, '.gemini', 'oauth_creds.json');
}

export function buildGoogleAuthUrl(metadata, redirectUri, state) {
  const url = new URL(metadata.authorizationUrl || GOOGLE_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('client_id', metadata.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('scope', metadata.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'consent select_account');
  return url.toString();
}

export function browserLaunchCommand(url, platform = process.platform) {
  if (platform === 'win32') {
    return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  }
  if (platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

async function openBrowserUrl(url, spawnImpl = spawn) {
  const launch = browserLaunchCommand(url);
  await new Promise((resolve, reject) => {
    const child = spawnImpl(launch.command, launch.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function readCachedCredentials(credentialsPath) {
  try {
    const body = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
    return body && typeof body === 'object' ? body : null;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    return null;
  }
}

async function writeCachedCredentials(credentialsPath, credentials) {
  await fs.mkdir(path.dirname(credentialsPath), { recursive: true });
  await fs.writeFile(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  try {
    await fs.chmod(credentialsPath, 0o600);
  } catch {
    // Windows may not support POSIX file modes. The file remains user-profile scoped.
  }
}

function normalizeTokenCredentials(body, existingCredentials = null, now = Date.now()) {
  if (!body?.access_token) throw new Error('Google token response did not contain an access token.');

  const credentials = { ...(existingCredentials || {}), ...body };
  if (body.expires_in !== undefined) {
    credentials.expiry_date = now + Number(body.expires_in) * 1000;
    delete credentials.expires_in;
  }
  if (!credentials.refresh_token && existingCredentials?.refresh_token) {
    credentials.refresh_token = existingCredentials.refresh_token;
  }
  if (!credentials.refresh_token) {
    throw new Error('Google did not return a refresh token. Retry sign-in and approve account access.');
  }
  return credentials;
}

function oauthTokenError(body, status, fallback) {
  const message = body?.error_description || body?.error || fallback || `Google token request failed with HTTP ${status}.`;
  const error = new Error(message);
  error.oauthCode = typeof body?.error === 'string' ? body.error : null;
  return error;
}

async function parseTokenResponse(response, fallbackMessage) {
  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error('Google returned an invalid token response.');
  }
  if (!response.ok) throw oauthTokenError(body, response.status, fallbackMessage);
  return body;
}

export async function ensureGoogleCredentials({
  metadataLoader = loadGeminiOAuthMetadata,
  fetchImpl = globalThis.fetch,
  credentialsPath = geminiOAuthCredentialsPath(),
  now = Date.now(),
  refreshSkewMs = GOOGLE_CREDENTIAL_REFRESH_SKEW_MS
} = {}) {
  const credentials = await readCachedCredentials(credentialsPath);
  if (!credentials?.refresh_token) return null;

  const expiry = Number(credentials.expiry_date);
  if (credentials.access_token && Number.isFinite(expiry) && expiry > now + refreshSkewMs) {
    return credentials;
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Refreshing Google login requires Node.js fetch support. Use Node.js 20 or newer.');
  }

  const metadata = await metadataLoader();
  const form = new URLSearchParams({
    client_id: metadata.clientId,
    client_secret: metadata.clientSecret,
    refresh_token: credentials.refresh_token,
    grant_type: 'refresh_token'
  });
  const response = await fetchImpl(metadata.tokenUrl || GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form
  });
  const body = await parseTokenResponse(response, 'Google login refresh failed.');
  const refreshed = normalizeTokenCredentials(body, credentials, now);
  await writeCachedCredentials(credentialsPath, refreshed);
  return refreshed;
}

async function exchangeAuthorizationCode({ metadata, code, redirectUri, fetchImpl, existingCredentials }) {
  const form = new URLSearchParams({
    client_id: metadata.clientId,
    client_secret: metadata.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  });
  const response = await fetchImpl(metadata.tokenUrl || GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form
  });
  const body = await parseTokenResponse(response, 'Google token exchange failed.');
  return normalizeTokenCredentials(body, existingCredentials);
}

function parseCallbackPort(value) {
  if (!value) return 0;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid OAUTH_CALLBACK_PORT: ${value}`);
  }
  return port;
}

async function startOAuthCallback({ metadata, state, fetchImpl, credentialsPath, timeoutMs, callbackPort }) {
  const existingCredentials = await readCachedCredentials(credentialsPath);
  let redirectUri = null;
  let settled = false;
  let timer = null;
  let resolveCompletion;
  let rejectCompletion;

  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (requestUrl.pathname !== '/oauth2callback') {
      response.writeHead(404);
      response.end();
      return;
    }

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close(() => {});
      if (error) rejectCompletion(error);
      else resolveCompletion();
    };

    const providerError = requestUrl.searchParams.get('error');
    if (providerError) {
      response.writeHead(302, { Location: metadata.failureUrl || GOOGLE_SIGN_IN_FAILURE_URL });
      response.end();
      finish(new Error(requestUrl.searchParams.get('error_description') || providerError));
      return;
    }
    if (requestUrl.searchParams.get('state') !== state) {
      response.writeHead(400);
      response.end('Invalid OAuth state.');
      finish(new Error('Google sign-in returned an invalid state value.'));
      return;
    }

    const code = requestUrl.searchParams.get('code');
    if (!code) {
      response.writeHead(400);
      response.end('Missing authorization code.');
      finish(new Error('Google sign-in did not return an authorization code.'));
      return;
    }

    try {
      const credentials = await exchangeAuthorizationCode({
        metadata,
        code,
        redirectUri,
        fetchImpl,
        existingCredentials
      });
      await writeCachedCredentials(credentialsPath, credentials);
      response.writeHead(302, { Location: metadata.successUrl || GOOGLE_SIGN_IN_SUCCESS_URL });
      response.end();
      finish();
    } catch (error) {
      response.writeHead(302, { Location: metadata.failureUrl || GOOGLE_SIGN_IN_FAILURE_URL });
      response.end();
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });

  const port = await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(callbackPort, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : callbackPort);
    });
  });

  redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  server.on('error', (error) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    rejectCompletion(error);
  });
  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    server.close(() => {});
    rejectCompletion(new Error('Google sign-in timed out after 5 minutes.'));
  }, timeoutMs);
  timer.unref?.();

  return {
    redirectUri,
    completion,
    close: async () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      await new Promise((resolve) => server.close(resolve));
    }
  };
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

export function parseGeminiJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Gemini CLI returned no output.');

  let body;
  try {
    body = JSON.parse(trimmed);
  } catch {
    throw new Error(`Gemini CLI returned invalid JSON: ${trimmed.slice(0, 500)}`);
  }

  if (body.error) {
    const message = typeof body.error === 'string'
      ? body.error
      : body.error.message || JSON.stringify(body.error);
    throw new Error(message);
  }

  if (typeof body.response !== 'string') {
    throw new Error('Gemini CLI response did not contain a text response.');
  }

  return body.response.trim() || '(no response)';
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
  metadataLoader = loadGeminiOAuthMetadata,
  openBrowser = openBrowserUrl,
  fetchImpl = globalThis.fetch,
  credentialsPath = geminiOAuthCredentialsPath(),
  timeoutMs = OAUTH_TIMEOUT_MS,
  callbackPort = parseCallbackPort(process.env.OAUTH_CALLBACK_PORT),
  notify = () => {},
  officialProbe = probeOfficialAntigravityAccount,
  officialVerify = verifyOfficialAntigravitySubscription
} = {}) {
  if (await officialProbe()) return;

  let cached = null;
  try {
    cached = await ensureGoogleCredentials({ metadataLoader, fetchImpl, credentialsPath });
  } catch {
    // A revoked or otherwise unusable cached refresh token falls through to browser reauthentication.
  }

  if (!cached) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('Google sign-in requires Node.js fetch support. Use Node.js 20 or newer.');
    }

    let metadata;
    try {
      metadata = await metadataLoader();
    } catch (error) {
      throw new Error(`Google sign-in could not start: ${error instanceof Error ? error.message : String(error)}`);
    }

    const state = crypto.randomBytes(32).toString('hex');
    let callback;
    try {
      callback = await startOAuthCallback({
        metadata,
        state,
        fetchImpl,
        credentialsPath,
        timeoutMs,
        callbackPort
      });
    } catch (error) {
      throw new Error(`Google sign-in could not start the local callback: ${error instanceof Error ? error.message : String(error)}`);
    }

    const authUrl = buildGoogleAuthUrl(metadata, callback.redirectUri, state);
    notify('Complete sign-in in your browser.');

    try {
      await openBrowser(authUrl);
    } catch {
      notify(`Browser could not open automatically. Open this URL:\n${authUrl}`);
    }

    try {
      await callback.completion;
    } catch (error) {
      throw new Error(`Google sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (await officialProbe()) {
    await officialVerify();
    return;
  }
  throw new Error(
    'Google sign-in is saved, but the official Antigravity subscription session is not active. ' +
    'The installed Google Antigravity CLI could not migrate the saved account into its secure keyring.'
  );
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
        throw new Error('Google subscription sign-in is required. Run `agy login`.');
      }
      throw new Error(`Google subscription request failed${detail ? `: ${detail}` : '.'}`);
    }

    const parsed = parseAntigravityJson(result.stdout);
    this.conversationId = parsed.conversationId || this.conversationId;
    return parsed.response;
  }
}
