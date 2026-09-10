const SAFE_EVENT_TYPES = new Set([
  'file_created',
  'file_modified',
  'file_deleted',
  'command_started',
  'command_finished',
  'test_started',
  'test_finished',
  'verification',
  'phase_changed'
]);
const EVENT_FIELDS = {
  file_created: new Set(['path']),
  file_modified: new Set(['path']),
  file_deleted: new Set(['path']),
  command_started: new Set(['command']),
  command_finished: new Set(['command', 'success']),
  test_started: new Set(),
  test_finished: new Set(['success']),
  verification: new Set(['phase']),
  phase_changed: new Set(['phase'])
};

function cleanText(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

export function createAgentEvent(type, data = {}) {
  if (!SAFE_EVENT_TYPES.has(type)) return null;
  const event = { type, timestamp: Date.now() };
  const fields = EVENT_FIELDS[type];
  if (fields.has('path') && data.path) event.path = cleanText(data.path);
  if (fields.has('command') && data.command) event.command = cleanText(data.command).slice(0, 160);
  if (fields.has('phase') && data.phase) event.phase = cleanText(data.phase);
  if (fields.has('success') && typeof data.success === 'boolean') event.success = data.success;
  return event;
}

export function createEventSink(listener = () => {}) {
  return (type, data = {}) => {
    const event = createAgentEvent(type, data);
    if (event) listener(event);
    return event;
  };
}

export const safeEventTypes = [...SAFE_EVENT_TYPES];
