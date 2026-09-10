import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { conversationAsText, conversationForModel } from './history.js';
import { cancellationError, isCancellation, throwIfAborted } from './cancel.js';
import { createEventSink } from './events.js';
import { subprocessEnvironment } from './environment.js';
import { processGroupOptions, terminateProcessTree } from './process.js';

const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const ANTIGRAVITY_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const ANTIGRAVITY_LOGIN_POLL_MS = 750;
const MAX_LOGIN_CAPTURE_CHARS = 32_000;
const PUBLIC_GEMINI_MODELS_URL = 'https://ai.google.dev/gemini-api/docs/models';
const PUBLIC_MODEL_DISCOVERY_TIMEOUT_MS = 8 * 1000;
const PUBLIC_MODEL_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const ANTIGRAVITY_RELEASE_BASE_URL = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app';
const ANTIGRAVITY_RELEASE_BUCKET_PREFIX = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/';
const MAX_PROVIDER_MANIFEST_BYTES = 64 * 1024;
const MAX_PROVIDER_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_PROVIDER_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_PROVIDER_BINARY_BYTES = 256 * 1024 * 1024;
const ANTIGRAVITY_PRINT_TIMEOUT = '10m';
const PROVIDER_METADATA_VERSION = 1;
let publicModelsPromise = null;

export function officialAntigravityBinaryPath({
  platform = process.platform,
  env = process.env,
  home = os.homedir()
} = {}) {
  const override = String(env.ANTIGRAVITY_CLI_BINARY || '').trim();
  if (override) {
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    if (!pathApi.isAbsolute(override)) {
      throw new Error('ANTIGRAVITY_CLI_BINARY must be an absolute path.');
    }
    return pathApi.normalize(override);
  }
  if (platform === 'win32') {
    const localAppData = String(env.LOCALAPPDATA || '').trim() || path.join(home, 'AppData', 'Local');
    return path.join(localAppData, 'antigravity-cli-npm', 'provider', 'agy.exe');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'antigravity-cli-npm', 'provider', 'agy');
  }
  const dataHome = String(env.XDG_DATA_HOME || '').trim() || path.join(home, '.local', 'share');
  return path.join(dataHome, 'antigravity-cli-npm', 'provider', 'agy');
}

async function fileExists(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function sha256File(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

export function officialAntigravityMetadataPath({ binaryPath = officialAntigravityBinaryPath() } = {}) {
  return path.join(path.dirname(binaryPath), 'provider.json');
}

async function readProviderMetadata(binaryPath) {
  const metadataPath = officialAntigravityMetadataPath({ binaryPath });
  try {
    const parsed = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    return parsed?.version === PROVIDER_METADATA_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

async function writeProviderMetadata(binaryPath, body) {
  const metadataPath = officialAntigravityMetadataPath({ binaryPath });
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  const temp = `${metadataPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify({ version: PROVIDER_METADATA_VERSION, ...body }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, metadataPath);
  try { await fs.chmod(metadataPath, 0o600); } catch {}
}

async function finalizeProviderMetadata(binaryPath, providerVersion) {
  const current = await readProviderMetadata(binaryPath);
  if (!current) return;
  await writeProviderMetadata(binaryPath, {
    ...current,
    providerVersion: providerVersion || current.providerVersion || null,
    binarySha256: await sha256File(binaryPath),
    verifiedAt: new Date().toISOString()
  });
}

export async function providerProvenanceStatus({ binaryPath = officialAntigravityBinaryPath() } = {}) {
  if (!await fileExists(binaryPath)) return { status: 'missing', sourceUrl: null, providerVersion: null };
  const metadata = await readProviderMetadata(binaryPath);
  if (!metadata?.sourceUrl || !metadata.binarySha256) {
    return { status: 'unrecorded', sourceUrl: metadata?.sourceUrl || null, providerVersion: metadata?.providerVersion || null };
  }
  const binarySha256 = await sha256File(binaryPath);
  return {
    status: binarySha256 === metadata.binarySha256 ? 'verified' : 'changed',
    sourceUrl: metadata.sourceUrl,
    providerVersion: metadata.providerVersion || null,
    installerSha256: metadata.installerSha256 || null,
    releaseUrl: metadata.releaseUrl || null,
    releaseSha512: metadata.releaseSha512 || null,
    binarySha256,
    recordedBinarySha256: metadata.binarySha256,
    installedAt: metadata.installedAt || null,
    verifiedAt: metadata.verifiedAt || null
  };
}

function providerReleasePlatform({ platform = process.platform, arch = process.arch, libc = null } = {}) {
  const normalizedArch = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null;
  if (!normalizedArch) throw new Error(`Google Antigravity does not support this CPU architecture: ${arch}`);
  if (platform === 'win32') return `windows_${normalizedArch}`;
  if (platform === 'darwin') return `darwin_${normalizedArch}`;
  if (platform !== 'linux') throw new Error(`Google Antigravity does not support this operating system: ${platform}`);
  let effectiveLibc = libc;
  if (!effectiveLibc) {
    try {
      effectiveLibc = process.report?.getReport?.().header?.glibcVersionRuntime ? 'glibc' : 'musl';
    } catch {
      effectiveLibc = 'glibc';
    }
  }
  return `linux_${normalizedArch}${effectiveLibc === 'musl' ? '_musl' : ''}`;
}

async function boundedResponseBytes(response, maxBytes, label, signal) {
  const contentLength = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`${label} is larger than the ${maxBytes} byte safety limit.`);
  }
  const chunks = [];
  let total = 0;
  if (response.body?.[Symbol.asyncIterator]) {
    for await (const chunk of response.body) {
      throwIfAborted(signal);
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) throw new Error(`${label} is larger than the ${maxBytes} byte safety limit.`);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
  }
  if (typeof response.arrayBuffer !== 'function') throw new Error(`${label} returned no readable body.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(`${label} is larger than the ${maxBytes} byte safety limit.`);
  return buffer;
}

function parseReleaseManifest(buffer, manifestUrl) {
  let manifest;
  try {
    manifest = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error('Google Antigravity release manifest is invalid JSON.', { cause: error });
  }
  const version = typeof manifest?.version === 'string' ? manifest.version.trim() : '';
  const releaseUrl = typeof manifest?.url === 'string' ? manifest.url.trim() : '';
  const sha512 = typeof manifest?.sha512 === 'string' ? manifest.sha512.trim().toLowerCase() : '';
  if (!version || !releaseUrl || !/^[a-f0-9]{128}$/.test(sha512)) {
    throw new Error('Google Antigravity release manifest is missing a valid version, URL, or SHA-512 digest.');
  }
  if (!releaseUrl.startsWith(ANTIGRAVITY_RELEASE_BUCKET_PREFIX)) {
    throw new Error(`Google Antigravity release manifest points outside the official release bucket: ${releaseUrl}`);
  }
  return { version, releaseUrl, sha512, manifestUrl };
}

function tarText(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/, '').trim();
}

function tarOctal(buffer, offset, length) {
  const value = tarText(buffer, offset, length).replace(/^0+/, '') || '0';
  if (!/^[0-7]+$/.test(value)) throw new Error('Google Antigravity release archive contains an invalid TAR size field.');
  return Number.parseInt(value, 8);
}

function extractProviderBinaryFromTarGz(archive) {
  let tar;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_PROVIDER_UNPACKED_BYTES });
  } catch (error) {
    throw new Error('Google Antigravity release archive could not be decompressed safely.', { cause: error });
  }
  let offset = 0;
  let binary = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = tarOctal(header, 124, 12);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    if (size > MAX_PROVIDER_BINARY_BYTES) throw new Error('Google Antigravity release archive contains an oversized entry.');
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error('Google Antigravity release archive is truncated.');
    if (type === '0' && path.posix.basename(fullName) === 'antigravity') {
      if (binary) throw new Error('Google Antigravity release archive contains multiple provider binaries.');
      binary = Buffer.from(tar.subarray(dataStart, dataEnd));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!binary?.length) throw new Error('Google Antigravity release archive does not contain the provider binary.');
  return binary;
}

async function captureExecutable(executable, args, { cwd = process.cwd(), env = subprocessEnvironment(process.env), signal, timeoutMs = null, input = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancellationError());
      return;
    }
    const child = spawn(executable, args, {
      cwd,
      env,
      windowsHide: true,
      ...processGroupOptions(),
      stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceeded = false;
    let aborted = false;
    let timedOut = false;
    const onAbort = () => {
      aborted = true;
      terminateProcessTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = timeoutMs ? setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs) : null;
    timeout?.unref?.();
    const append = (chunks, currentBytes, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (currentBytes + buffer.length > MAX_CAPTURE_BYTES) {
        exceeded = true;
        terminateProcessTree(child);
        return currentBytes;
      }
      chunks.push(buffer);
      return currentBytes + buffer.length;
    };
    child.stdout.on('data', (chunk) => { stdoutBytes = append(stdoutChunks, stdoutBytes, chunk); });
    child.stderr.on('data', (chunk) => { stderrBytes = append(stderrChunks, stderrBytes, chunk); });
    if (input != null && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(String(input), 'utf8');
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (aborted || signal?.aborted) return reject(cancellationError());
      if (timedOut) return reject(new Error(`Provider command timed out after ${timeoutMs} ms.`));
      if (exceeded) return reject(new Error('Provider produced too much output.'));
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
        stderr: Buffer.concat(stderrChunks, stderrBytes).toString('utf8')
      });
    });
  });
}

export async function installOfficialAntigravityCli({
  platform = process.platform,
  arch = process.arch,
  libc = null,
  binaryPath = officialAntigravityBinaryPath({ platform }),
  fetchImpl = globalThis.fetch,
  signal
} = {}) {
  throwIfAborted(signal);
  if (typeof fetchImpl !== 'function') throw new Error('Installing the Google Antigravity backend requires fetch support.');
  const platformId = providerReleasePlatform({ platform, arch, libc });
  const manifestUrl = `${ANTIGRAVITY_RELEASE_BASE_URL}/manifests/${platformId}.json`;
  const manifestResponse = await fetchImpl(manifestUrl, { signal, redirect: 'error' });
  throwIfAborted(signal);
  if (!manifestResponse.ok) throw new Error(`Google Antigravity release manifest returned HTTP ${manifestResponse.status}.`);
  const manifest = parseReleaseManifest(
    await boundedResponseBytes(manifestResponse, MAX_PROVIDER_MANIFEST_BYTES, 'Google Antigravity release manifest', signal),
    manifestUrl
  );
  const releaseResponse = await fetchImpl(manifest.releaseUrl, { signal, redirect: 'error' });
  throwIfAborted(signal);
  if (!releaseResponse.ok) throw new Error(`Google Antigravity release package returned HTTP ${releaseResponse.status}.`);
  const releasePackage = await boundedResponseBytes(releaseResponse, MAX_PROVIDER_PACKAGE_BYTES, 'Google Antigravity release package', signal);
  const actualSha512 = crypto.createHash('sha512').update(releasePackage).digest('hex');
  if (actualSha512 !== manifest.sha512) {
    throw new Error('Google Antigravity release package failed SHA-512 verification.');
  }
  const binary = platform === 'win32' ? releasePackage : extractProviderBinaryFromTarGz(releasePackage);
  if (!binary.length || binary.length > MAX_PROVIDER_BINARY_BYTES) throw new Error('Google Antigravity provider binary has an invalid size.');

  const targetDirectory = path.dirname(binaryPath);
  const tempFile = path.join(targetDirectory, `.${path.basename(binaryPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.mkdir(targetDirectory, { recursive: true });
  try {
    throwIfAborted(signal);
    await fs.writeFile(tempFile, binary, { mode: 0o700, flag: 'wx' });
    try { await fs.chmod(tempFile, 0o700); } catch {}
    throwIfAborted(signal);
    await fs.rm(binaryPath, { force: true });
    await fs.rename(tempFile, binaryPath);
  } finally {
    await fs.rm(tempFile, { force: true });
  }
  if (!await fileExists(binaryPath)) {
    throw new Error(`Google Antigravity backend was not installed at ${binaryPath}.`);
  }
  await writeProviderMetadata(binaryPath, {
    sourceUrl: manifest.manifestUrl,
    releaseUrl: manifest.releaseUrl,
    releaseSha512: manifest.sha512,
    binarySha256: await sha256File(binaryPath),
    providerVersion: manifest.version,
    installedAt: new Date().toISOString(),
    verifiedAt: null
  });
  return binaryPath;
}

export async function probeOfficialAntigravityBinary({
  binaryPath = officialAntigravityBinaryPath(),
  captureImpl = captureExecutable,
  signal
} = {}) {
  throwIfAborted(signal);
  if (!await fileExists(binaryPath)) return { ready: false, version: null, error: 'missing' };
  try {
    const result = await captureImpl(binaryPath, ['--version'], { env: googleAccountEnv(process.env), timeoutMs: 10_000, signal });
    const version = String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null;
    if (result.code !== 0 || !version) return { ready: false, version: null, error: 'unhealthy' };
    return { ready: true, version, error: null };
  } catch (error) {
    if (isCancellation(error) || signal?.aborted) throw cancellationError();
    return { ready: false, version: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function replaceManagedProvider({
  platform,
  binaryPath,
  installImpl,
  probeImpl,
  provenanceImpl = providerProvenanceStatus,
  action = 'Installed',
  signal
}) {
  throwIfAborted(signal);
  const metadataPath = officialAntigravityMetadataPath({ binaryPath });
  const backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'antigyc-provider-backup-'));
  const backupBinary = path.join(backupRoot, path.basename(binaryPath));
  const backupMetadata = path.join(backupRoot, 'provider.json');
  const hadBinary = await fileExists(binaryPath);
  const hadMetadata = await fileExists(metadataPath);
  try {
    if (hadBinary) await fs.copyFile(binaryPath, backupBinary);
    if (hadMetadata) await fs.copyFile(metadataPath, backupMetadata);
    await fs.rm(binaryPath, { force: true });
    await fs.rm(metadataPath, { force: true });

    const installed = await installImpl({ platform, binaryPath, signal });
    throwIfAborted(signal);
    const recorded = await provenanceImpl({ binaryPath: installed });
    if (recorded.status !== 'verified') {
      throw new Error(`${action} Google Antigravity backend provenance is not verified: ${recorded.status}.`);
    }
    const verified = await probeImpl({ binaryPath: installed, signal });
    if (!verified.ready) throw new Error(`${action} Google Antigravity backend is not usable: ${installed}`);
    await finalizeProviderMetadata(installed, verified.version);
    const provenance = await provenanceImpl({ binaryPath: installed });
    if (provenance.status !== 'verified') {
      throw new Error(`${action} Google Antigravity backend provenance changed during verification.`);
    }
    return { binaryPath: installed, version: verified.version, provenance };
  } catch (error) {
    await fs.mkdir(path.dirname(binaryPath), { recursive: true });
    await fs.rm(binaryPath, { force: true });
    await fs.rm(metadataPath, { force: true });
    if (hadBinary) await fs.copyFile(backupBinary, binaryPath);
    if (hadMetadata) await fs.copyFile(backupMetadata, metadataPath);
    throw error;
  } finally {
    await fs.rm(backupRoot, { recursive: true, force: true });
  }
}

export async function ensureOfficialAntigravityCli({
  platform = process.platform,
  env = process.env,
  binaryPath = officialAntigravityBinaryPath({ platform, env }),
  installImpl = installOfficialAntigravityCli,
  probeImpl = probeOfficialAntigravityBinary,
  provenanceImpl = providerProvenanceStatus,
  signal
} = {}) {
  throwIfAborted(signal);
  const override = String(env.ANTIGRAVITY_CLI_BINARY || '').trim();
  if (override) {
    const existing = await probeImpl({ binaryPath, signal });
    if (!existing.ready) {
      throw new Error(`Configured Google Antigravity backend is not usable: ${binaryPath}`);
    }
    return binaryPath;
  }

  if (await fileExists(binaryPath)) {
    const provenance = await provenanceImpl({ binaryPath });
    if (provenance.status === 'verified') {
      const existing = await probeImpl({ binaryPath, signal });
      if (existing.ready) return binaryPath;
    }
  }

  const replacement = await replaceManagedProvider({
    platform,
    binaryPath,
    installImpl,
    probeImpl,
    provenanceImpl,
    action: 'Installed',
    signal
  });
  return replacement.binaryPath;
}

export async function updateOfficialAntigravityCli({
  platform = process.platform,
  env = process.env,
  binaryPath = officialAntigravityBinaryPath({ platform, env }),
  installImpl = installOfficialAntigravityCli,
  probeImpl = probeOfficialAntigravityBinary,
  provenanceImpl = providerProvenanceStatus
} = {}) {
  if (String(env.ANTIGRAVITY_CLI_BINARY || '').trim()) {
    throw new Error('Provider update is disabled when ANTIGRAVITY_CLI_BINARY points to an externally managed backend.');
  }

  return replaceManagedProvider({
    platform,
    binaryPath,
    installImpl,
    probeImpl,
    provenanceImpl,
    action: 'Updated'
  });
}

export function parseAntigravityModels(text) {
  const models = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const slug = line.trim().split(/\s+/)[0];
    if (!/^(?:gemini|claude|gpt|o\d|text-embedding)[a-z0-9]*(?:[.-][a-z0-9]+)+$/i.test(slug)) continue;
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
    const detail = sanitizeProviderDetail(result.stderr || result.stdout);
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
      ...processGroupOptions(platform),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let exceeded = false;
    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') > PUBLIC_MODEL_PAGE_MAX_BYTES) {
        exceeded = true;
        terminateProcessTree(child, { platform });
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
  let officialError = null;
  try {
    const officialModels = uniqueModelIds(await officialModelsLoader());
    if (officialModels.length) return officialModels;
  } catch (error) {
    officialError = error;
  }

  try {
    const publicModels = uniqueModelIds(await discoverPublicGoogleModels({
      fetchImpl,
      curlLoader,
      url: publicModelsUrl,
      timeoutMs: publicTimeoutMs,
      platform
    }));
    if (publicModels.length) return publicModels;
  } catch (error) {
    if (!officialError) throw error;
  }

  if (officialError) throw officialError;
  return [];
}

async function loadAntigravityPty() {
  try {
    return await import('@lydell/node-pty');
  } catch {
    throw new Error('Official Antigravity browser sign-in support is unavailable. Reinstall antigyc.');
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

function sanitizeProviderDetail(value, maxLength = 1500) {
  return stripTerminalControl(value)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/\b((?:token|secret|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key|credential|cookie)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1[redacted]@')
    .slice(0, maxLength);
}

function wait(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancellationError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(cancellationError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runOfficialAntigravityLogin({
  ensureImpl = ensureOfficialAntigravityCli,
  accountProbe = probeOfficialAntigravityAccount,
  ptyLoader = loadAntigravityPty,
  timeoutMs = ANTIGRAVITY_LOGIN_TIMEOUT_MS,
  pollMs = ANTIGRAVITY_LOGIN_POLL_MS,
  env = process.env,
  signal
} = {}) {
  throwIfAborted(signal);
  if (await accountProbe({ ensureImpl, signal })) return true;

  const binary = await ensureImpl({ signal });
  throwIfAborted(signal);
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
      throwIfAborted(signal);
      if (await accountProbe({ ensureImpl: async () => binary, signal })) return true;
      if (exited) break;
      await wait(pollMs, signal);
    }

    throwIfAborted(signal);
    if (await accountProbe({ ensureImpl: async () => binary, signal })) return true;

    const detail = sanitizeProviderDetail(output.slice(-3000));
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

export function googleAccountEnv(source = process.env, defaultsPath = null) {
  const env = { ...subprocessEnvironment(source), NO_COLOR: '1' };

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
    throw new Error(`Google Antigravity returned invalid JSON: ${sanitizeProviderDetail(trimmed, 500)}`);
  }
  const errorDetail = typeof body.error === 'string'
    ? body.error
    : typeof body.error?.message === 'string'
      ? body.error.message
      : body.error
        ? JSON.stringify(body.error)
        : '';
  if (body.status && String(body.status).toUpperCase() !== 'SUCCESS') {
    throw new Error(errorDetail ? sanitizeProviderDetail(errorDetail) : `Google Antigravity request ended with status ${body.status}.`);
  }
  if (body.error) throw new Error(sanitizeProviderDetail(errorDetail));
  if (typeof body.response !== 'string') throw new Error('Google Antigravity response did not contain response text.');
  return {
    response: body.response.trim(),
    conversationId: typeof body.conversation_id === 'string' && body.conversation_id ? body.conversation_id : null
  };
}

export function parseAntigravityStreamJson(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('Google Antigravity returned no output.');
  let result = null;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`Google Antigravity returned invalid stream JSON: ${sanitizeProviderDetail(line, 500)}`);
    }
    if (event?.event === 'result' && event.result && typeof event.result === 'object') result = event.result;
    else if (typeof event?.status === 'string' && typeof event?.response === 'string') result = event;
  }
  if (!result) throw new Error('Google Antigravity stream ended without a result event.');
  return parseAntigravityJson(JSON.stringify(result));
}

function isGoogleAuthFailure(value) {
  return /auth(?:entication)? required|not authenticated|sign.?in|log.?in|credential/i.test(String(value || ''));
}

function googleAuthRequiredError() {
  const error = new Error('Google subscription session became unavailable. Retry the request; official Antigravity sign-in will reopen automatically if needed.');
  error.code = 'GOOGLE_AUTH_REQUIRED';
  return error;
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

function appendAntigravityExecutionArgs(args, {
  model = null,
  reasoning = 'high',
  yes = false,
  attachments = [],
  conversationId = null
}) {
  if (model) args.push('--model', model);
  if (reasoning !== 'auto') args.push('--effort', normalizeReasoning(reasoning));
  // Print mode cannot surface the provider's interactive permission UI. The
  // wrapper already operates on a disposable project copy, so normal mode
  // auto-approves provider tools inside Antigravity's terminal sandbox. The
  // explicit `yes` mode keeps auto-approval and removes that sandbox limit.
  args.push('--dangerously-skip-permissions');
  if (!yes) args.push('--sandbox');
  if (conversationId) args.push('--conversation', conversationId);
  const directories = [...new Set(attachments.map((attachment) => path.dirname(attachment.stagedPath)).filter(Boolean))];
  for (const directory of directories) args.push('--add-dir', directory);
  return args;
}

export function buildAntigravityArgs({
  prompt,
  model = null,
  reasoning = 'high',
  yes = false,
  attachments = [],
  conversationId = null
}) {
  return appendAntigravityExecutionArgs([
    '-p', prompt,
    '--output-format', 'json',
    '--disable-slash-commands',
    '--print-timeout', ANTIGRAVITY_PRINT_TIMEOUT
  ], { model, reasoning, yes, attachments, conversationId });
}

export function buildAntigravityStreamArgs({
  model = null,
  reasoning = 'high',
  yes = false,
  attachments = [],
  conversationId = null
} = {}) {
  return appendAntigravityExecutionArgs([
    '--print=',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--disable-slash-commands',
    '--print-timeout', ANTIGRAVITY_PRINT_TIMEOUT
  ], { model, reasoning, yes, attachments, conversationId });
}

export function buildAntigravityStreamInput(prompt) {
  return `${JSON.stringify({ event: 'user', message: { content: String(prompt || '') } })}\n`;
}

async function probeOfficialAntigravityAccount({
  ensureImpl = ensureOfficialAntigravityCli,
  captureImpl = captureExecutable,
  signal
} = {}) {
  try {
    throwIfAborted(signal);
    const binary = await ensureImpl({ signal });
    const result = await captureImpl(binary, ['models'], { env: googleAccountEnv(process.env), timeoutMs: 15_000, signal });
    return result.code === 0 && parseAntigravityModels(result.stdout).length > 0;
  } catch (error) {
    if (isCancellation(error) || signal?.aborted) throw cancellationError();
    return false;
  }
}

export async function verifyOfficialAntigravitySubscription({
  ensureImpl = ensureOfficialAntigravityCli,
  captureImpl = captureExecutable,
  signal
} = {}) {
  throwIfAborted(signal);
  const binary = await ensureImpl({ signal });
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-login-check-'));
  try {
    const result = await captureImpl(binary, [
      '-p', 'Reply with exactly OK.',
      '--output-format', 'json',
      '--disable-slash-commands',
      '--print-timeout', '1m'
    ], { cwd, env: googleAccountEnv(process.env), timeoutMs: 75_000, signal });
    if (result.code !== 0) {
      const detail = sanitizeProviderDetail(result.stderr || result.stdout);
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
  env = process.env,
  binaryPath = officialAntigravityBinaryPath({ env }),
  captureImpl = captureExecutable,
  provenanceImpl = providerProvenanceStatus
} = {}) {
  const override = String(env.ANTIGRAVITY_CLI_BINARY || '').trim();
  if (!override) {
    const provenance = await provenanceImpl({ binaryPath });
    if (provenance.status !== 'verified') {
      return {
        backend: provenance.status === 'missing' ? 'missing' : 'broken',
        account: 'unknown',
        version: provenance.providerVersion || null
      };
    }
  }

  const backend = await probeOfficialAntigravityBinary({ binaryPath, captureImpl });
  if (!backend.ready) return { backend: backend.error === 'missing' ? 'missing' : 'broken', account: 'unknown', version: null };
  try {
    const result = await captureImpl(binaryPath, ['models'], { env: googleAccountEnv(env), timeoutMs: 15_000 });
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
  officialVerify = verifyOfficialAntigravitySubscription,
  signal
} = {}) {
  throwIfAborted(signal);
  if (await officialProbe({ signal })) return;

  notify('Complete sign-in in your browser.');
  await officialLogin({ accountProbe: officialProbe, signal });

  throwIfAborted(signal);
  if (!await officialProbe({ signal })) {
    throw new Error('Official Antigravity sign-in completed without creating a usable subscription session.');
  }

  await officialVerify({ signal });
}

export class GoogleAccountAgent {
  constructor({
    workspace,
    displayWorkspace,
    model = 'auto',
    reasoning = 'high',
    yes = false,
    history = [],
    backend = {},
    onActivity = () => {},
    onEvent = () => {}
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
    this.onActivity = typeof onActivity === 'function' ? onActivity : () => {};
    this.emitEvent = createEventSink(typeof onEvent === 'function' ? onEvent : () => {});
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
    this.onActivity('Working');
    const binary = await this.ensureBackend({ signal });
    const effectiveModel = await resolveAntigravityModel(this.model, { modelsLoader: this.modelsLoader });
    const previousConversation = !this.conversationId && this.seedHistory.length
      ? `\n\nPrevious conversation:\n${conversationAsText(this.seedHistory)}`
      : '';
    const attachmentInstruction = attachments.length
      ? `\n\nAttachments for this request:\n${attachments.map((attachment) => `- ${attachment.name}: ${attachment.stagedPath}`).join('\n')}\nRead every listed attachment with the read_file tool before answering. Images and PDFs are multimodal inputs. Do not copy attachment files into the project.`
      : '';
    const hiddenInstruction = `Shell response rules: Never use emojis in any user-facing response. Keep terminal output plain text and professional. Do not use Markdown formatting or Markdown syntax in the final response: no # headings, bold/italic markers, backticks, fenced code blocks, Markdown tables, blockquotes, or Markdown link syntax. Use ordinary text lines and simple hyphen lists only when a list is useful. Every final user-facing response must end with a final section titled "Summary"; that plain-text Summary section must be the last section and briefly state the result and validation performed.\n\nOperate autonomously on this staged copy as the project at ${this.displayWorkspace}. Do not mention staging paths, conversation storage, or internal tool activity. For broad tasks, map the repository before editing. Continue through inspection, implementation, testing, and debugging until the user's coding request is actually complete. Do not stop at the first failed check: diagnose evidence-backed failures, fix them when they are in scope, and rerun the relevant validation. After modifications, inspect the resulting changes and run appropriate tests/build/lint/type checks when available before finalizing. Never claim validation passed unless it was actually run. Always return a non-empty concise final user-facing response, including for inspection-only requests or when no files change.${previousConversation}${attachmentInstruction}\n\nUser request:\n${text}`;
    const args = buildAntigravityStreamArgs({
      model: effectiveModel,
      reasoning: this.reasoning,
      yes: this.yes,
      attachments,
      conversationId: this.conversationId
    });
    this.onActivity('Working');
    this.emitEvent('phase_changed', { phase: 'Working' });
    const result = await this.captureBackend(binary, args, {
      cwd: this.workspace,
      env: googleAccountEnv(process.env),
      signal,
      input: buildAntigravityStreamInput(hiddenInstruction)
    });

    if (result.code !== 0) {
      let structuredError = '';
      try {
        const resultEvent = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
          .map((line) => JSON.parse(line)).findLast?.((event) => event?.event === 'result');
        structuredError = typeof resultEvent?.result?.error === 'string' ? resultEvent.result.error : '';
      } catch {}
      const detail = sanitizeProviderDetail(structuredError || result.stderr || result.stdout);
      if (isGoogleAuthFailure(detail)) throw googleAuthRequiredError();
      throw new Error(`Google subscription request failed${detail ? `: ${detail}` : '.'}`);
    }

    let parsed;
    try {
      parsed = parseAntigravityStreamJson(result.stdout);
    } catch (error) {
      if (isGoogleAuthFailure(error?.message)) throw googleAuthRequiredError();
      throw error;
    }
    this.conversationId = parsed.conversationId || this.conversationId;
    if (!parsed.response && this.conversationId) {
      const recoveryPrompt = 'Return the concise non-empty final user-facing response for the immediately previous request. It must be plain text. Do not make additional project changes. Do not use emojis or Markdown syntax. Do not use headings with #, emphasis markers, backticks, fenced code blocks, Markdown tables, blockquotes, or Markdown link syntax. End the response with a plain-text section titled "Summary" and make that the last section.';
      const recoveryArgs = buildAntigravityStreamArgs({
        model: effectiveModel,
        reasoning: this.reasoning,
        yes: false,
        conversationId: this.conversationId
      });
      const recovery = await this.captureBackend(binary, recoveryArgs, {
        cwd: this.workspace,
        env: googleAccountEnv(process.env),
        signal,
        input: buildAntigravityStreamInput(recoveryPrompt)
      });
      if (recovery.code !== 0) {
        const detail = sanitizeProviderDetail(recovery.stderr || recovery.stdout);
        if (isGoogleAuthFailure(detail)) throw googleAuthRequiredError();
        throw new Error(`Google Antigravity returned an empty final response and response recovery failed${detail ? `: ${detail}` : '.'}`);
      }
      try {
        parsed = parseAntigravityStreamJson(recovery.stdout);
      } catch (error) {
        if (isGoogleAuthFailure(error?.message)) throw googleAuthRequiredError();
        throw error;
      }
      this.conversationId = parsed.conversationId || this.conversationId;
    }
    if (!parsed.response) {
      throw new Error('Google Antigravity completed the request but returned no final response text.');
    }
    return parsed.response;
  }
}
