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
    assert.match(conversationAsText(loaded), /inspect this/);

    await store.clear();
    assert.deepEqual(await store.load(), []);
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
