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
