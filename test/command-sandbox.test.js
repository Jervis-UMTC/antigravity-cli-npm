import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  commandSandboxReadiness,
  commandSandboxPolicy,
  createCommandSandbox
} from '../src/command-sandbox.js';

const SANDBOX_READY = (await commandSandboxReadiness()).ready;

function passthroughManager(calls = {}) {
  return {
    async initialize(policy) {
      calls.policy = policy;
      calls.initialized = (calls.initialized || 0) + 1;
    },
    async wrapWithSandboxArgv(command, binShell) {
      calls.command = command;
      calls.binShell = binShell;
      if (process.platform === 'win32') {
        return {
          argv: [binShell.exe, ...binShell.args, command],
          env: process.env
        };
      }
      return { argv: ['/bin/sh', '-c', command], env: process.env };
    },
    cleanupAfterCommand() {
      calls.cleaned = (calls.cleaned || 0) + 1;
    },
    async reset() {
      calls.reset = (calls.reset || 0) + 1;
    }
  };
}

test('command sandbox policy grants writes only to staged workspace and disposable scratch', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-sandbox-policy-work-'));
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-sandbox-policy-tmp-'));
  try {
    const policy = commandSandboxPolicy({ workspace, scratch, environment: process.env });
    assert.deepEqual(new Set(policy.filesystem.allowWrite), new Set([path.resolve(workspace), path.resolve(scratch)]));
    assert.equal(policy.filesystem.allowWrite.includes(path.resolve(os.homedir())), false);
    assert.equal(policy.network.allowedDomains.includes('*'), false);
    assert.equal(policy.enableWeakerNestedSandbox, false);
    assert.equal(policy.enableWeakerNetworkIsolation, false);
    assert.equal(policy.allowAppleEvents, false);
    if (process.platform === 'win32') assert.ok(policy.windows?.srtWin?.path.endsWith('srt-win.exe'));
    else assert.ok(policy.filesystem.denyRead.includes(path.resolve(os.homedir())));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test('sandbox launcher keeps structured argv inside the sandbox trampoline', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-sandbox-run-'));
  const calls = {};
  try {
    const sandbox = createCommandSandbox({
      workspace,
      environment: { ...process.env, AGYC_SANDBOX_TEST_VISIBLE: 'visible' },
      manager: passthroughManager(calls)
    });
    const result = await sandbox.runProcess({
      executable: process.execPath,
      args: ['-e', 'console.log(`${process.argv[1]}:${process.env.AGYC_SANDBOX_TEST_VISIBLE}`)', 'ARG WITH SPACES'],
      cwd: workspace,
      timeoutMs: 10_000,
      display: 'node structured argv test'
    });
    assert.match(result.stdout, /ARG WITH SPACES:visible/);
    assert.match(calls.command, /^[A-Za-z0-9_-]+$/);
    assert.equal(calls.initialized, 1);
    assert.equal(calls.cleaned, 1);
    assert.equal(calls.reset, 1);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('sandbox initialization failure is fail-closed and never launches the command', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-sandbox-closed-'));
  let executions = 0;
  const manager = {
    async initialize() { throw new Error('sandbox backend unavailable'); },
    cleanupAfterCommand() {},
    async reset() {}
  };
  try {
    const sandbox = createCommandSandbox({
      workspace,
      manager,
      execFileImpl() {
        executions += 1;
        throw new Error('must not execute');
      }
    });
    await assert.rejects(
      () => sandbox.runCommand({ command: 'echo unsafe', cwd: workspace }),
      (error) => error?.code === 'COMMAND_SANDBOX_UNAVAILABLE' && /sandbox backend unavailable/.test(error.message)
    );
    assert.equal(executions, 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('OS sandbox blocks writes outside the staged workspace', { skip: !SANDBOX_READY }, async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-sandbox-boundary-'));
  const outside = path.join(os.tmpdir(), `agy-sandbox-escape-${process.pid}-${Date.now()}.txt`);
  try {
    const sandbox = createCommandSandbox({ workspace, environment: process.env });
    await assert.rejects(() => sandbox.runProcess({
      executable: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(outside)}, 'escaped')`],
      cwd: workspace,
      timeoutMs: 10_000,
      display: 'sandbox escape regression'
    }));
    await assert.rejects(() => fs.stat(outside), /ENOENT/);
  } finally {
    await fs.rm(outside, { force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
