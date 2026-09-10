import assert from 'node:assert/strict';
import test from 'node:test';
import { createActivityIndicator } from '../src/activity.js';

function fakeScheduler() {
  const timeouts = [];
  const intervals = [];
  return {
    timeouts,
    intervals,
    setTimeoutImpl(callback) {
      const timer = { callback, cleared: false, unref() {} };
      timeouts.push(timer);
      return timer;
    },
    clearTimeoutImpl(timer) {
      if (timer) timer.cleared = true;
    },
    setIntervalImpl(callback) {
      const timer = { callback, cleared: false, unref() {} };
      intervals.push(timer);
      return timer;
    },
    clearIntervalImpl(timer) {
      if (timer) timer.cleared = true;
    }
  };
}

function ttyStream() {
  const writes = [];
  return {
    isTTY: true,
    writes,
    write(value) {
      writes.push(String(value));
      return true;
    }
  };
}

test('activity indicator stays quiet until its delay then shows elapsed working time', () => {
  const scheduler = fakeScheduler();
  const stream = ttyStream();
  let currentTime = 1_000;
  const activity = createActivityIndicator(stream, {
    now: () => currentTime,
    ...scheduler
  });

  activity.setPhase('Preparing');
  assert.deepEqual(stream.writes, []);
  scheduler.timeouts[0].callback();
  assert.equal(stream.writes.at(-1), '\rPreparing... 0s');

  currentTime = 2_750;
  scheduler.intervals[0].callback();
  assert.equal(stream.writes.at(-1), '\rPreparing... 1s');

  activity.stop();
  assert.equal(stream.writes.at(-1), `\r${' '.repeat('Preparing... 1s'.length)}\r`);
});

test('activity indicator pauses cleanly for interactive approval and resumes afterward', () => {
  const scheduler = fakeScheduler();
  const stream = ttyStream();
  const activity = createActivityIndicator(stream, { ...scheduler, now: () => 0 });

  scheduler.timeouts[0].callback();
  assert.equal(stream.writes.at(-1), '\rWorking... 0s');

  activity.pause();
  assert.equal(scheduler.intervals[0].cleared, true);
  assert.equal(stream.writes.at(-1), `\r${' '.repeat('Working... 0s'.length)}\r`);

  activity.resume();
  assert.equal(scheduler.timeouts.length, 2);
  scheduler.timeouts[1].callback();
  assert.equal(stream.writes.at(-1), '\rWorking... 0s');

  activity.stop();
});

test('activity indicator can switch between plain informative phases while keeping elapsed time', () => {
  const scheduler = fakeScheduler();
  const stream = ttyStream();
  let currentTime = 10_000;
  const activity = createActivityIndicator(stream, { ...scheduler, now: () => currentTime });
  scheduler.timeouts[0].callback();
  activity.setPhase('Inspecting');
  assert.equal(stream.writes.at(-1), '\rInspecting... 0s');
  currentTime = 12_200;
  scheduler.intervals[0].callback();
  assert.equal(stream.writes.at(-1), '\rInspecting... 2s');
  activity.setPhase('Checking...');
  assert.equal(stream.writes.at(-1), '\rChecking... 2s  ');
  activity.stop();
  assert.equal(stream.writes.at(-1), `\r${' '.repeat('Inspecting... 2s'.length)}\r`);
});

test('activity indicator can switch to a fixed applying phase and erase it before final output', () => {
  const scheduler = fakeScheduler();
  const stream = ttyStream();
  const activity = createActivityIndicator(stream, { ...scheduler, now: () => 0 });
  scheduler.timeouts[0].callback();
  activity.setMessage('Applying changes...');
  assert.equal(stream.writes.at(-1), '\rApplying changes...');
  activity.stop();
  assert.equal(stream.writes.at(-1), `\r${' '.repeat('Applying changes...'.length)}\r`);
});

test('activity indicator maps agent events onto generic transient phases', () => {
  const scheduler = fakeScheduler();
  const stream = ttyStream();
  const activity = createActivityIndicator(stream, { ...scheduler, now: () => 0 });
  scheduler.timeouts[0].callback();

  activity.emit({ type: 'file_modified', path: 'src/private.js' });
  assert.match(stream.writes.at(-1), /^\rWorking\.\.\. 0s/);
  activity.emit({ type: 'command_started', command: 'deploy --token secret' });
  assert.match(stream.writes.at(-1), /^\rChecking\.\.\. 0s/);
  assert.doesNotMatch(stream.writes.join(''), /private\.js|deploy|token|secret/);

  activity.stop();
});

test('activity indicator produces no output for non-TTY streams', () => {
  const scheduler = fakeScheduler();
  const writes = [];
  const activity = createActivityIndicator({ isTTY: false, write: (value) => writes.push(value) }, scheduler);

  assert.equal(scheduler.timeouts.length, 0);
  activity.pause();
  activity.resume();
  activity.stop();
  assert.deepEqual(writes, []);
});
