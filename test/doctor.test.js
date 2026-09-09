import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderDoctor, runDoctor } from '../src/doctor.js';

test('doctor prints plain actionable health lines without UI chrome', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-doctor-workspace-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-doctor-home-'));
  try {
    const execImpl = async (executable) => {
      if (executable === 'where.exe') return { stdout: 'C:\\npm\\agyc.cmd\r\n', stderr: '' };
      if (executable === 'cmd.exe') return { stdout: '11.6.1\r\n', stderr: '' };
      throw new Error('unexpected executable');
    };
    const report = await runDoctor({
      version: '0.1.0',
      workspace,
      home,
      env: {},
      platform: 'win32',
      nodeVersion: '20.19.0',
      execImpl,
      fetchImpl: async () => ({ status: 200 }),
      runtimeLoader: async () => ({ backend: 'ready', account: 'connected', version: '1.2.3' }),
      provenanceLoader: async () => ({ status: 'verified', sourceUrl: 'https://antigravity.google/cli/install.cmd' })
    });
    assert.equal(report.ok, true);
    const text = renderDoctor(report);
    assert.match(text, /^agyc=ok version=0\.1\.0/m);
    assert.match(text, /node=ok version=20\.19\.0/);
    assert.match(text, /provider=ok state=ready version=1\.2\.3/);
    assert.match(text, /google-account=ok state=connected/);
    assert.match(text, /provider-provenance=ok state=verified/);
    assert.match(text, /network=ok npm-registry=reachable/);
    assert.doesNotMatch(text, /[╭╮╰╯│─]/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('doctor returns a failing status for an unsupported Node runtime', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-doctor-old-node-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agyc-doctor-old-home-'));
  try {
    const report = await runDoctor({
      version: '0.1.0',
      workspace,
      home,
      env: {},
      platform: 'linux',
      nodeVersion: '18.20.0',
      execImpl: async (executable) => executable === 'npm'
        ? { stdout: '10.0.0\n', stderr: '' }
        : { stdout: '/usr/bin/agyc\n', stderr: '' },
      fetchImpl: async () => ({ status: 503 }),
      runtimeLoader: async () => ({ backend: 'missing', account: 'unknown', version: null }),
      provenanceLoader: async () => ({ status: 'missing' })
    });
    assert.equal(report.ok, false);
    assert.match(renderDoctor(report), /node=fail version=18\.20\.0/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});
