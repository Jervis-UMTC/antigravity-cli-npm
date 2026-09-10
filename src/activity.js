const DEFAULT_DELAY_MS = 250;
const DEFAULT_INTERVAL_MS = 1000;

function elapsedLabel(startedAt, now, phase = 'Working') {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${phase}... ${seconds}s`;
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
  let delayElapsed = false;
  let fixedMessage = null;
  let phase = 'Working';

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
    const text = fixedMessage || elapsedLabel(startedAt, now(), phase);
    const padding = Math.max(0, renderedWidth - text.length);
    stream.write(`\r${text}${' '.repeat(padding)}`);
    renderedWidth = Math.max(renderedWidth, text.length);
    visible = true;
  };

  const schedule = () => {
    if (!enabled || paused || stopped) return;
    delayElapsed = false;
    delayTimer = setTimeoutImpl(() => {
      delayTimer = null;
      delayElapsed = true;
      render();
      if (paused || stopped) return;
      intervalTimer = setIntervalImpl(render, intervalMs);
      intervalTimer?.unref?.();
    }, delayMs);
    delayTimer?.unref?.();
  };

  schedule();

  return {
    setPhase(message) {
      if (stopped) return;
      phase = String(message || '').trim().replace(/\.\.\.$/, '') || 'Working';
      fixedMessage = null;
      if (enabled && !paused && delayElapsed) render();
    },
    setMessage(message) {
      if (stopped) return;
      fixedMessage = String(message || '').trim() || null;
      if (enabled && !paused && delayElapsed) render();
    },
    emit(event) {
      if (stopped || !event) return;
      const type = String(event.type || '').trim();
      if (type === 'phase_changed') {
        const phase = String(event.phase || '').toLowerCase();
        if (phase.includes('inspect')) this.setPhase('Inspecting');
        else if (phase.includes('check') || phase.includes('verif') || phase.includes('test')) this.setPhase('Checking');
        else this.setPhase('Working');
      } else if (type === 'verification' || type === 'command_started' || type === 'command_finished' || type === 'test_started' || type === 'test_finished') this.setPhase('Checking');
      else if (type === 'file_created' || type === 'file_modified' || type === 'file_deleted') this.setPhase('Working');
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

export function renderActivityEvent(event) {
  if (!event) return '';
  if (event.type === 'phase_changed') {
    const phase = String(event.phase || '').toLowerCase();
    if (phase.includes('inspect')) return 'Inspecting';
    if (phase.includes('check') || phase.includes('verif') || phase.includes('test')) return 'Checking';
    return 'Working';
  }
  if (['verification', 'command_started', 'command_finished', 'test_started', 'test_finished'].includes(event.type)) return 'Checking';
  if (['file_created', 'file_modified', 'file_deleted'].includes(event.type)) return 'Working';
  return '';
}
