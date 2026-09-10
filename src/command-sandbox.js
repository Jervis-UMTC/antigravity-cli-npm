import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  SandboxManager,
  SandboxRuntimeConfigSchema,
  VENDORED_SRT_WIN_EXE,
  checkWindowsDependenciesAsync,
  resolveSrtWin
} from '@anthropic-ai/sandbox-runtime';
import { awaitChildProcess, processGroupOptions } from './process.js';
import { throwIfAborted } from './cancel.js';

const execFile = promisify(execFileCallback);
const LAUNCHER = fileURLToPath(new URL('./command-child.js', import.meta.url));
const PACKAGE_ROOT = path.dirname(path.dirname(LAUNCHER));
const DEFAULT_NETWORK_DOMAINS = [
  'localhost', '127.0.0.1', '[::1]',
  'registry.npmjs.org', '*.npmjs.org',
  'github.com', '*.github.com', '*.githubusercontent.com',
  'pypi.org', '*.pythonhosted.org',
  'rubygems.org', 'crates.io', '*.crates.io',
  'repo.maven.apache.org', 'services.gradle.org'
];

function uniquePaths(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text) continue;
    const absolute = path.resolve(text);
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(absolute);
  }
  return output;
}

function networkDomains(environment = process.env) {
  const extra = String(environment.AGYC_SANDBOX_NETWORK || '')
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_NETWORK_DOMAINS, ...extra])];
}

function pathDirectories(environment = process.env) {
  return String(environment.PATH || environment.Path || environment.path || '')
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
}

function denyReadRoots(platform, home) {
  if (platform === 'win32') return [];
  const resolved = path.resolve(home || os.homedir());
  if (resolved === path.parse(resolved).root) return [];
  return [resolved];
}

export function commandSandboxPolicy({
  workspace,
  scratch,
  environment = process.env,
  platform = process.platform,
  home = os.homedir(),
  extraReadPaths = []
}) {
  const allowRead = uniquePaths([
    workspace,
    scratch,
    PACKAGE_ROOT,
    path.dirname(process.execPath),
    ...pathDirectories(environment),
    ...extraReadPaths
  ]);
  const policy = {
    network: {
      allowedDomains: networkDomains(environment),
      deniedDomains: [],
      allowLocalBinding: true
    },
    filesystem: {
      denyRead: denyReadRoots(platform, home),
      allowRead,
      allowWrite: uniquePaths([workspace, scratch]),
      denyWrite: []
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false
  };
  if (platform === 'win32') policy.windows = { srtWin: { path: VENDORED_SRT_WIN_EXE } };
  return SandboxRuntimeConfigSchema.parse(policy);
}

export async function commandSandboxReadiness({ platform = process.platform, manager = SandboxManager } = {}) {
  try {
    const check = platform === 'win32'
      ? await checkWindowsDependenciesAsync({ srtWin: resolveSrtWin({ path: VENDORED_SRT_WIN_EXE }) })
      : await manager.checkDependenciesAsync();
    const errors = Array.isArray(check?.errors) ? check.errors.map(String) : [];
    const warnings = Array.isArray(check?.warnings) ? check.warnings.map(String) : [];
    return { ready: errors.length === 0, errors, warnings };
  } catch (error) {
    return { ready: false, errors: [error instanceof Error ? error.message : String(error)], warnings: [] };
  }
}

function quotePosix(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sandboxSetupError(error, platform) {
  const detail = error instanceof Error ? error.message : String(error);
  const suffix = platform === 'win32'
    ? ' Run `npx @anthropic-ai/sandbox-runtime windows-install` once from an elevated prompt, then retry.'
    : ' Install the sandbox runtime prerequisites for this OS, then retry.';
  const wrapped = new Error(`Command sandbox is unavailable: ${detail}.${suffix}`, { cause: error instanceof Error ? error : undefined });
  wrapped.code = 'COMMAND_SANDBOX_UNAVAILABLE';
  return wrapped;
}

export function createCommandSandbox({
  workspace,
  environment = process.env,
  platform = process.platform,
  home = os.homedir(),
  manager = SandboxManager,
  execFileImpl = execFile
}) {
  const root = path.resolve(workspace);

  async function run(payload, { signal, timeoutMs = 120000, display = '' } = {}) {
    throwIfAborted(signal);
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'antigyc-command-'));
    const payloadFile = path.join(scratch, 'request.json');
    const token = Buffer.from(payloadFile, 'utf8').toString('base64url');
    const extraReadPaths = payload.mode === 'process' && path.isAbsolute(payload.executable || '')
      ? [path.dirname(payload.executable)]
      : [];
    const policy = commandSandboxPolicy({ workspace: root, scratch, environment, platform, home, extraReadPaths });
    const body = { ...payload, cwd: path.resolve(payload.cwd || root), scratch, env: environment };
    await fs.writeFile(payloadFile, `${JSON.stringify(body)}\n`, { encoding: 'utf8', mode: 0o600 });

    let initialized = false;
    try {
      try {
        await manager.initialize(policy, undefined, false);
        initialized = true;
      } catch (error) {
        throw sandboxSetupError(error, platform);
      }
      throwIfAborted(signal);

      const options = { commandId: `antigyc-${process.pid}-${Date.now()}`, commandText: display || payload.command || payload.executable || 'project command' };
      let descriptor;
      if (platform === 'win32') {
        descriptor = await manager.wrapWithSandboxArgv(
          token,
          { exe: process.execPath, args: [LAUNCHER, '--payload-path-b64'] },
          undefined,
          signal,
          body.cwd,
          options
        );
      } else {
        const command = `${quotePosix(process.execPath)} ${quotePosix(LAUNCHER)} --payload-path-b64 ${token}`;
        descriptor = await manager.wrapWithSandboxArgv(command, '/bin/sh', undefined, signal, body.cwd, options);
      }

      const execution = execFileImpl(descriptor.argv[0], descriptor.argv.slice(1), {
        cwd: body.cwd,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        env: descriptor.env,
        ...processGroupOptions(platform)
      });
      return await awaitChildProcess(execution, { signal, timeoutMs });
    } finally {
      if (initialized) {
        try { manager.cleanupAfterCommand?.(); } catch {}
        try { await manager.reset(); } catch {}
      }
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }

  return {
    runProcess({ executable, args = [], cwd = root, signal, timeoutMs, display }) {
      return run({ mode: 'process', executable, args, cwd }, { signal, timeoutMs, display });
    },
    runCommand({ command, cwd = root, signal, timeoutMs, display }) {
      return run({ mode: 'command', command, cwd }, { signal, timeoutMs, display });
    }
  };
}
