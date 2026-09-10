import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendConversationTurn, conversationAsText, conversationForModel, createHistoryStore } from '../src/history.js';

test('conversation history is stored outside the project and survives reload', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-history-project-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-history-state-'));
  try {
    const store = await createHistoryStore(workspace, { baseDir: stateRoot });
    const messages = appendConversationTurn([], 'inspect this', [{
      name: 'shot.png',
      path: 'C:\\outside\\shot.png',
      mimeType: 'image/png',
      kind: 'image'
    }], 'done');

    await store.save(messages);
    assert.equal(path.resolve(store.path).startsWith(`${path.resolve(workspace)}${path.sep}`), false);
    assert.equal(path.resolve(store.path).startsWith(`${path.resolve(stateRoot)}${path.sep}`), true);

    const loaded = await store.load();
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].attachments[0].name, 'shot.png');
    assert.equal('path' in loaded[0].attachments[0], false);
    assert.doesNotMatch(await fs.readFile(store.path, 'utf8'), /C:\\\\outside/);
    assert.match(conversationAsText(loaded), /inspect this/);

    await store.clear();
    assert.deepEqual(await store.load(), []);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test('invalid conversation history is quarantined and a fresh session can continue', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-history-corrupt-project-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-history-corrupt-state-'));
  try {
    const store = await createHistoryStore(workspace, { baseDir: stateRoot });
    await fs.mkdir(path.dirname(store.path), { recursive: true });
    await fs.writeFile(store.path, '{"messages":[', 'utf8');

    assert.deepEqual(await store.load(), []);
    const notice = store.takeRecoveryNotice();
    assert.match(notice, /Conversation history was invalid and was moved to/);
    assert.equal(store.takeRecoveryNotice(), null);
    await assert.rejects(() => fs.stat(store.path), { code: 'ENOENT' });

    const entries = await fs.readdir(path.dirname(store.path));
    const backup = entries.find((entry) => entry.startsWith(`${path.basename(store.path)}.invalid-`));
    assert.ok(backup);
    assert.equal(await fs.readFile(path.join(path.dirname(store.path), backup), 'utf8'), '{"messages":[');

    await store.save(appendConversationTurn([], 'continue', [], 'ok'));
    assert.equal((await store.load()).length, 2);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test('model history keeps the newest messages within a bounded UTF-8 byte budget', () => {
  const messages = Array.from({ length: 30 }, (_value, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    text: `${index}: ${'x'.repeat(23_000)}`,
    attachments: [],
    at: new Date(2026, 0, 1, 0, 0, index).toISOString()
  }));
  const recent = conversationForModel(messages);
  assert.ok(recent.length < 30);
  assert.match(recent.at(-1).text, /^29:/);
  assert.ok(Buffer.byteLength(JSON.stringify(recent), 'utf8') < 170 * 1024);
});

test('history accepts legacy unversioned data and rejects unknown future versions', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-history-version-project-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-history-version-state-'));
  try {
    const store = await createHistoryStore(workspace, { baseDir: stateRoot });
    await fs.mkdir(path.dirname(store.path), { recursive: true });
    await fs.writeFile(store.path, JSON.stringify({ messages: [{ role: 'user', text: 'legacy' }] }), 'utf8');
    assert.equal((await store.load())[0].text, 'legacy');
    await fs.writeFile(store.path, JSON.stringify({ version: 99, messages: [] }), 'utf8');
    await assert.rejects(() => store.load(), /Unsupported conversation history version 99/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test('long conversation history stays bounded by count and model-facing size', async () => {
  let messages = [];
  for (let index = 0; index < 180; index += 1) {
    messages = appendConversationTurn(
      messages,
      `request-${index} ${'u'.repeat(12_000)}`,
      [],
      `reply-${index} ${'a'.repeat(12_000)}`
    );
  }

  assert.equal(messages.length, 200);
  const modelHistory = conversationForModel(messages);
  assert.ok(modelHistory.length < 30);
  assert.equal(modelHistory[0].role, 'user');
  assert.match(modelHistory.at(-1).text, /reply-179/);
  assert.ok(conversationAsText(messages).length < 65_000);
});

test('oversized saved messages preserve both their beginning and ending', () => {
  const longText = `BEGIN-${'x'.repeat(30_000)}-END`;
  const messages = appendConversationTurn([], longText, [], 'reply');
  assert.match(messages[0].text, /^BEGIN-/);
  assert.match(messages[0].text, /\[truncated \d+ chars\]/);
  assert.match(messages[0].text, /-END$/);
  assert.ok(messages[0].text.length < 25_000);
});
