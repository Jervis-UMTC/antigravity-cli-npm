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

const FILE_EVENT_TYPES = new Set(['file_created', 'file_modified', 'file_deleted']);
const SUCCESS_EVENT_TYPES = new Set(['command_finished', 'test_finished']);

function cleanText(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

export function createAgentEvent(type, data = {}) {
  if (!SAFE_EVENT_TYPES.has(type)) return null;
  const event = { type, timestamp: Date.now() };
  if (FILE_EVENT_TYPES.has(type) && data.path) event.path = cleanText(data.path);
  if (type === 'phase_changed' && data.phase) event.phase = cleanText(data.phase);
  if (SUCCESS_EVENT_TYPES.has(type) && typeof data.success === 'boolean') event.success = data.success;
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
