import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeProject } from '../src/init.js';

test('init creates only the explicitly requested AGENTS.md and never overwrites it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-init-'));
  try {
    const target = await initializeProject(root);
    assert.equal(target, path.join(root, 'AGENTS.md'));
    assert.match(await fs.readFile(target, 'utf8'), /Project instructions/);
    assert.deepEqual(await fs.readdir(root), ['AGENTS.md']);
    await fs.writeFile(target, 'custom\n', 'utf8');
    await assert.rejects(() => initializeProject(root), /already exists/);
    assert.equal(await fs.readFile(target, 'utf8'), 'custom\n');
    await assert.rejects(() => initializeProject(root, { fileName: '../outside.md' }), /simple file name/);
    await assert.rejects(() => initializeProject(root, { fileName: 'nested/AGENTS.md' }), /simple file name/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
