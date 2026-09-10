import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentEvent, createEventSink } from '../src/events.js';
import { renderActivityEvent } from '../src/activity.js';

test('safe agent events keep supported progress data only', () => {
  const event = createAgentEvent('file_modified', {
    path: 'src/app.js',
    secret: 'hidden',
    command: 'do not use'
  });

  assert.equal(event.type, 'file_modified');
  assert.equal(event.path, 'src/app.js');
  assert.equal('secret' in event, false);
  assert.equal('command' in event, false);

  const command = createAgentEvent('command_finished', {
    command: 'npm test',
    path: 'should-not-leak.txt',
    success: true
  });
  assert.equal(command.command, 'npm test');
  assert.equal(command.success, true);
  assert.equal('path' in command, false);
});

test('unsafe events are rejected', () => {
  assert.equal(createAgentEvent('reasoning_trace', { text: 'hidden' }), null);
});

test('event sink forwards safe events', () => {
  const events = [];
  const sink = createEventSink((event) => events.push(event));

  sink('command_started', { command: 'npm test' });

  assert.equal(events.length, 1);
  assert.equal(events[0].command, 'npm test');
});

test('activity renderer returns plain terminal output without emoji characters', () => {
  const output = renderActivityEvent({ type: 'test_finished', success: true });

  assert.equal(output, 'Tests passed');
  assert.equal(/[^\x00-\x7F]/.test(output), false);
});
