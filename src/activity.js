const DEFAULT_DELAY_MS = 250;
const DEFAULT_INTERVAL_MS = 1000;

function elapsedLabel(startedAt, now) {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `Working... ${seconds}s`;
}

export function createActivityIndicator(stream, {
  delayMs = DEFAULT_DELAY_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval
} = {}) {
  const enabled = Boolean(stream?.isTTY && typeof stream.write === 'function');
  const startedAt = now();
  let delayTimer = null;
  let intervalTimer = null;
  let visible = false;
  let renderedWidth = 0;
  let paused = false;
  let stopped = false;
  let fixedMessage = null;

  const clearTimers = () => {
    if (delayTimer) clearTimeoutImpl(delayTimer);
    if (intervalTimer) clearIntervalImpl(intervalTimer);
    delayTimer = null;
    intervalTimer = null;
  };

  const erase = () => {
    if (!enabled || !visible) return;
    stream.write(`\r${' '.repeat(renderedWidth)}\r`);
    visible = false;
    renderedWidth = 0;
  };

  const render = () => {
    if (!enabled || paused || stopped) return;
    const text = fixedMessage || elapsedLabel(startedAt, now());
    const padding = Math.max(0, renderedWidth - text.length);
    stream.write(`\r${text}${' '.repeat(padding)}`);
    renderedWidth = Math.max(renderedWidth, text.length);
    visible = true;
  };

  const schedule = () => {
    if (!enabled || paused || stopped) return;
    delayTimer = setTimeoutImpl(() => {
      delayTimer = null;
      render();
      if (paused || stopped) return;
      intervalTimer = setIntervalImpl(render, intervalMs);
      intervalTimer?.unref?.();
    }, delayMs);
    delayTimer?.unref?.();
  };

  schedule();

  return {
    setMessage(message) {
      if (stopped) return;
      fixedMessage = String(message || '').trim() || null;
      if (enabled && !paused) render();
    },
    pause() {
      if (!enabled || paused || stopped) return;
      paused = true;
      clearTimers();
      erase();
    },
    resume() {
      if (!enabled || !paused || stopped) return;
      paused = false;
      schedule();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimers();
      erase();
    }
  };
}

export const activityDefaults = {
  delayMs: DEFAULT_DELAY_MS,
  intervalMs: DEFAULT_INTERVAL_MS
};
