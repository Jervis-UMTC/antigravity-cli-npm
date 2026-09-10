import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  googleRuntimeStatus,
  officialAntigravityBinaryPath,
  providerProvenanceStatus
} from './google-agent.js';
import { commandSandboxReadiness } from './command-sandbox.js';

const execFile = promisify(execFileCallback);

function parseMajor(version) {
  return Number(String(version || '').replace(/^v/, '').split('.')[0]) || 0;
}

function stateRoot({ env = process.env, home = os.homedir() } = {}) {
  return path.resolve(env.ANTIGRAVITY_HOME || path.join(home, '.antigravity-cli'));
}

async function commandPath(name, { platform = process.platform, execImpl = execFile } = {}) {
  const executable = platform === 'win32' ? 'where.exe' : 'which';
  try {
    const { stdout } = await execImpl(executable, [name], { timeout: 5_000, windowsHide: true });
    return String(stdout || '').trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

async function npmVersion({ platform = process.platform, execImpl = execFile } = {}) {
  const executable = platform === 'win32' ? 'cmd.exe' : 'npm';
  const args = platform === 'win32' ? ['/d', '/c', 'npm.cmd', '--version'] : ['--version'];
  try {
    const { stdout } = await execImpl(executable, args, { timeout: 10_000, windowsHide: true });
    return String(stdout || '').trim() || null;
  } catch {
    return null;
  }
}

async function networkReachable(url, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: 'HEAD',
      signal: controller.signal
    });
    return response.status > 0 && response.status < 600;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function runDoctor({
  version,
  workspace = process.cwd(),
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
  nodeVersion = process.versions.node,
  execImpl = execFile,
  fetchImpl = globalThis.fetch,
  runtimeLoader = googleRuntimeStatus,
  provenanceLoader = providerProvenanceStatus,
  sandboxLoader = commandSandboxReadiness,
  accessImpl = fs.access
} = {}) {
  const lines = [];
  let hardFailure = false;
  const add = (name, status, detail = '') => {
    if (status === 'fail') hardFailure = true;
    lines.push(`${name}=${status}${detail ? ` ${detail}` : ''}`);
  };

  add('antigyc', 'ok', `version=${version}`);
  const nodeOk = parseMajor(nodeVersion) >= 20;
  add('node', nodeOk ? 'ok' : 'fail', `version=${nodeVersion}`);

  const npm = await npmVersion({ platform, execImpl });
  add('npm', npm ? 'ok' : 'fail', npm ? `version=${npm}` : 'not-found');

  try {
    await accessImpl(path.resolve(workspace), fsConstants.R_OK | fsConstants.W_OK);
    add('workspace', 'ok', `path=${path.resolve(workspace)}`);
  } catch {
    add('workspace', 'fail', `not-writable path=${path.resolve(workspace)}`);
  }

  const state = stateRoot({ env, home });
  try {
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    await accessImpl(state, fsConstants.R_OK | fsConstants.W_OK);
    add('state', 'ok', `path=${state}`);
  } catch {
    add('state', 'fail', `not-writable path=${state}`);
  }

  const command = await commandPath('antigyc', { platform, execImpl });
  add('command', command ? 'ok' : 'warn', command ? `path=${command}` : 'antigyc-not-on-PATH; local/npx use can still work');

  const sandbox = await sandboxLoader({ platform }).catch((error) => ({
    ready: false,
    errors: [error instanceof Error ? error.message : String(error)]
  }));
  add('command-sandbox', sandbox.ready ? 'ok' : 'warn', sandbox.ready
    ? 'ready'
    : `not-ready${sandbox.errors?.[0] ? ` ${sandbox.errors[0]}` : ''}`);

  const runtime = await runtimeLoader().catch(() => ({ backend: 'broken', account: 'unknown', version: null }));
  const binaryPath = officialAntigravityBinaryPath({ platform, env, home });
  add('provider', runtime.backend === 'ready' ? 'ok' : 'warn', `state=${runtime.backend}${runtime.version ? ` version=${runtime.version}` : ''} path=${binaryPath}`);
  add('google-account', runtime.account === 'connected' ? 'ok' : 'warn', `state=${runtime.account}`);

  const provenance = await provenanceLoader({ binaryPath }).catch(() => ({ status: 'unknown' }));
  add('provider-provenance', provenance.status === 'verified' ? 'ok' : 'warn', `state=${provenance.status}${provenance.sourceUrl ? ` source=${provenance.sourceUrl}` : ''}`);

  const networkTargets = [
    ['network-npm', 'https://registry.npmjs.org/antigyc'],
    ['network-provider', 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app'],
    ['network-models', 'https://ai.google.dev/gemini-api/docs/models']
  ];
  for (const [name, url] of networkTargets) {
    const reachable = await networkReachable(url, fetchImpl);
    add(name, reachable ? 'ok' : 'warn', reachable ? 'reachable' : 'unreachable');
  }

  return { ok: !hardFailure, lines };
}

export function renderDoctor(report) {
  return `${report.lines.join('\n')}\n`;
}
