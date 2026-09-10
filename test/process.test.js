import assert from 'node:assert/strict';
import test from 'node:test';
import { terminateProcessTree } from '../src/process.js';

test('Windows process-tree termination uses taskkill with descendant and force flags', () => {
  let call = null;
  const child = { pid: 1234, kill() { throw new Error('fallback should not run'); } };
  assert.equal(terminateProcessTree(child, {
    platform: 'win32',
    spawnSyncImpl(executable, args, options) {
      call = { executable, args, options };
      return { status: 0 };
    }
  }), true);
  assert.equal(call.executable, 'taskkill.exe');
  assert.deepEqual(call.args, ['/pid', '1234', '/t', '/f']);
});

test('POSIX process-tree termination targets the detached process group', () => {
  let killed = null;
  const child = { pid: 4321, kill() { throw new Error('fallback should not run'); } };
  assert.equal(terminateProcessTree(child, {
    platform: 'linux',
    killImpl(pid, signal) { killed = { pid, signal }; }
  }), true);
  assert.deepEqual(killed, { pid: -4321, signal: 'SIGKILL' });
});
