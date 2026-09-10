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
    await store.update({ model: 'gemini-3.8-flash', reasoning: 'high', auth: 'google', approval: 'yes', turbo: true });
    assert.equal(store.path, settingsPath({ baseDir: root }));
    assert.equal(path.resolve(store.path).startsWith(`${path.resolve(project)}${path.sep}`), false);
    assert.deepEqual(await store.load(), {
      model: 'gemini-3.8-flash', reasoning: 'high', auth: 'google', approval: 'yes', turbo: true
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('settings accept legacy unversioned data and reject unknown future versions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-settings-version-'));
  try {
    const store = await createSettingsStore({ baseDir: root });
    await fs.mkdir(path.dirname(store.path), { recursive: true });
    await fs.writeFile(store.path, JSON.stringify({ model: 'legacy-model', approval: 'ask' }), 'utf8');
    assert.deepEqual(await store.load(), { model: 'legacy-model', approval: 'ask' });
    await fs.writeFile(store.path, JSON.stringify({ version: 99, model: 'future-model' }), 'utf8');
    await assert.rejects(() => store.load(), /Unsupported settings file version 99/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('fresh defaults use Google subscription auth with high reasoning, approval prompts, and turbo off', () => {
  const merged = mergeRuntimePreferences({ model: null, reasoning: null, auth: null, yes: null, turbo: null }, {}, {});
  assert.deepEqual(merged, { model: 'gemini-3.8-flash', reasoning: 'high', auth: 'google', yes: false, turbo: false });
});

test('legacy approval ask without a turbo field never escalates to autonomous execution', () => {
  const merged = mergeRuntimePreferences(
    { model: null, reasoning: null, auth: null, yes: null, turbo: null },
    { approval: 'ask' },
    {}
  );
  assert.deepEqual(merged, { model: 'gemini-3.8-flash', reasoning: 'high', auth: 'google', yes: false, turbo: false });
});

test('CLI values override environment, environment overrides stored preferences', () => {
  const stored = { model: 'stored-model', reasoning: 'low', auth: 'google', approval: 'yes', turbo: true };
  const merged = mergeRuntimePreferences({ model: null, reasoning: null, auth: null, yes: null, turbo: null }, stored, {
    ANTIGRAVITY_MODEL: 'env-model', ANTIGRAVITY_REASONING: 'high', ANTIGRAVITY_AUTH: 'api-key'
  });
  assert.deepEqual(merged, { model: 'env-model', reasoning: 'high', auth: 'api-key', yes: true, turbo: true });
  const cli = mergeRuntimePreferences({ model: 'cli-model', reasoning: 'auto', auth: 'google', yes: false, turbo: false }, stored, {
    ANTIGRAVITY_MODEL: 'env-model', ANTIGRAVITY_REASONING: 'high', ANTIGRAVITY_AUTH: 'api-key'
  });
  assert.deepEqual(cli, { model: 'cli-model', reasoning: 'auto', auth: 'google', yes: false, turbo: false });
});

test('invalid authentication and reasoning environment values fail with configuration errors', () => {
  const parsed = { auth: null, model: null, reasoning: null, turbo: null, yes: null };
  assert.throws(
    () => mergeRuntimePreferences(parsed, {}, { ANTIGRAVITY_AUTH: 'broken' }),
    /ANTIGRAVITY_AUTH must be auto, google, or api-key/
  );
  assert.throws(
    () => mergeRuntimePreferences(parsed, {}, { ANTIGRAVITY_REASONING: 'extreme' }),
    /ANTIGRAVITY_REASONING must be auto, low, or high/
  );
});
