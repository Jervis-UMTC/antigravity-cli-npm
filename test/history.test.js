import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendConversationTurn, conversationAsText, createHistoryStore } from '../src/history.js';

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
