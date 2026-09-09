export function cancellationError(message = 'Canceled.') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.exitCode = 130;
  return error;
}

export function isCancellation(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.exitCode === 130;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw cancellationError();
}
