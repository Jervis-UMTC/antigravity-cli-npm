import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSettingsStore, mergeRuntimePreferences, settingsPath } from '../src/settings.js';

test('global preferences persist outside a project and survive reload', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-settings-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-settings-project-'));
  try {
    const store = await createSettingsStore({ baseDir: root });
    await store.update({ model: 'gemini-3.8-flash', reasoning: 'high', auth: 'google', approval: 'yes' });
    assert.equal(store.path, settingsPath({ baseDir: root }));
    assert.equal(path.resolve(store.path).startsWith(`${path.resolve(project)}${path.sep}`), false);
    assert.deepEqual(await store.load(), {
      model: 'gemini-3.8-flash', reasoning: 'high', auth: 'google', approval: 'yes'
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('CLI values override environment, environment overrides stored preferences', () => {
  const stored = { model: 'stored-model', reasoning: 'low', auth: 'google', approval: 'yes' };
  const merged = mergeRuntimePreferences({ model: null, reasoning: null, auth: null, yes: null }, stored, {
    ANTIGRAVITY_MODEL: 'env-model', ANTIGRAVITY_REASONING: 'high', ANTIGRAVITY_AUTH: 'api-key'
  });
  assert.deepEqual(merged, { model: 'env-model', reasoning: 'high', auth: 'api-key', yes: true });
  const cli = mergeRuntimePreferences({ model: 'cli-model', reasoning: 'auto', auth: 'google', yes: false }, stored, {
    ANTIGRAVITY_MODEL: 'env-model', ANTIGRAVITY_REASONING: 'high', ANTIGRAVITY_AUTH: 'api-key'
  });
  assert.deepEqual(cli, { model: 'cli-model', reasoning: 'auto', auth: 'google', yes: false });
});
