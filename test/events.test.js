import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentEvent, createEventSink } from '../src/events.js';
import { renderActivityEvent } from '../src/activity.js';

test('safe agent events keep supported progress data only', () => {
  const event = createAgentEvent('file_modified', {
    path: 'src/app.js',
    secret: 'hidden',
    command: 'deploy --token super-secret'
  });

  assert.equal(event.type, 'file_modified');
  assert.equal(event.path, 'src/app.js');
  assert.equal('secret' in event, false);
  assert.equal('command' in event, false);
});

test('command events never expose command arguments', () => {
  const event = createAgentEvent('command_started', { command: 'deploy --token super-secret' });
  assert.equal(event.type, 'command_started');
  assert.equal('command' in event, false);
});

test('unsafe events are rejected', () => {
  assert.equal(createAgentEvent('reasoning_trace', { text: 'hidden' }), null);
});

test('event sink forwards safe events', () => {
  const events = [];
  const sink = createEventSink((event) => events.push(event));

  sink('command_finished', { command: 'npm test', success: false });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'command_finished');
  assert.equal(events[0].success, false);
  assert.equal('command' in events[0], false);
});

test('activity renderer keeps event output generic and plain', () => {
  assert.equal(renderActivityEvent({ type: 'file_modified', path: 'secret/project.js' }), 'Working');
  assert.equal(renderActivityEvent({ type: 'command_started', command: 'deploy --token secret' }), 'Checking');
  assert.equal(renderActivityEvent({ type: 'phase_changed', phase: 'internal provider operation' }), 'Working');
  assert.equal(/[^\x00-\x7F]/.test(renderActivityEvent({ type: 'test_finished', success: true })), false);
});
