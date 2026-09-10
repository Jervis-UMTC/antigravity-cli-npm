import { spawnSync } from 'node:child_process';
import { cancellationError } from './cancel.js';

export function terminateProcessTree(child, {
  platform = process.platform,
  killImpl = process.kill,
  spawnSyncImpl = spawnSync
} = {}) {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;

  if (platform === 'win32') {
    try {
      const result = spawnSyncImpl('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      if (!result?.error && result?.status === 0) return true;
    } catch {}
    try { return child.kill('SIGKILL') !== false; } catch { return false; }
  }

  try {
    killImpl(-pid, 'SIGKILL');
    return true;
  } catch {
    try { return child.kill('SIGKILL') !== false; } catch { return false; }
  }
}

export async function awaitChildProcess(promise, {
  signal,
  timeoutMs = null,
  timeoutMessage = null,
  terminate = terminateProcessTree
} = {}) {
  const child = promise?.child;
  let aborted = false;
  let timedOut = false;
  let timer = null;

  const stop = () => {
    try { terminate(child); } catch {}
  };
  const onAbort = () => {
    aborted = true;
    stop();
  };

  if (signal?.aborted) {
    promise?.catch?.(() => {});
    stop();
    throw cancellationError();
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  if (timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timer.unref?.();
  }

  try {
    return await promise;
  } catch (error) {
    if (aborted || signal?.aborted) throw cancellationError();
    if (timedOut) {
      const timeoutError = new Error(timeoutMessage || `Process timed out after ${timeoutMs} ms.`, { cause: error });
      timeoutError.code = 'ETIMEDOUT';
      throw timeoutError;
    }
    stop();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function processGroupOptions(platform = process.platform) {
  return platform === 'win32' ? {} : { detached: true };
}
