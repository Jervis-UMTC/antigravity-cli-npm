import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGoogleAuthBootstrap } from '../src/cli.js';

const CLI = fileURLToPath(new URL('../bin/agy.js', import.meta.url));

async function startFakeGemini(responder) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ url: request.url, body });

    const reply = await responder(requests.length - 1, body, request);
    response.statusCode = reply.status ?? 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(reply.body));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1beta`,
    requests,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

function runCli(workspace, stateRoot, baseUrl, args, { explicitAuth = true, extraEnv = {} } = {}) {
  return new Promise((resolve, reject) => {
    const cliArgs = [CLI, ...(explicitAuth ? ['--auth', 'api-key'] : []), '--base-url', baseUrl, ...args];
    const child = spawn(process.execPath, cliArgs, {
      cwd: workspace,
      windowsHide: true,
      env: {
        ...process.env,
        GEMINI_API_KEY: 'test-key',
        ANTIGRAVITY_HOME: stateRoot,
        ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runStandalone(workspace, stateRoot, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: workspace,
      windowsHide: true,
      env: { ...process.env, ANTIGRAVITY_HOME: stateRoot },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function modelText(text) {
  return {
    body: {
      candidates: [{
        content: { role: 'model', parts: [{ text }] }
      }]
    }
  };
}

function writeFileCall(file, content) {
  return {
    body: {
      candidates: [{
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'write_file', args: { path: file, content } } }]
        }
      }]
    }
  };
}

test('normal Google use bootstraps authentication once without a separate login command', async () => {
  const options = { auth: 'google' };
  const notices = [];
  let loginCalls = 0;
  const bootstrap = createGoogleAuthBootstrap(options, {
    notify: (message) => notices.push(message),
    login: async ({ notify }) => {
      loginCalls += 1;
      notify('browser sign-in');
    }
  });

  assert.equal(await bootstrap.ensure(), true);
  assert.equal(await bootstrap.ensure(), true);
  assert.equal(loginCalls, 1);
  assert.deepEqual(notices, ['browser sign-in']);

  options.auth = 'api-key';
  bootstrap.reset();
  assert.equal(await bootstrap.ensure(), false);
  assert.equal(loginCalls, 1);

  options.auth = 'google';
  assert.equal(await bootstrap.ensure(), true);
  assert.equal(loginCalls, 2);
});

test('one-shot editing works in a folder with no Git repository', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-nogit-cli-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-nogit-state-'));
  await fs.writeFile(path.join(workspace, 'app.txt'), 'before\n', 'utf8');
  const fake = await startFakeGemini((index) => index === 0
    ? writeFileCall('app.txt', 'after\n')
    : modelText('updated'));

  try {
    await assert.rejects(() => fs.stat(path.join(workspace, '.git')), /ENOENT/);
    const result = await runCli(workspace, stateRoot, fake.baseUrl, ['-p', 'update app.txt']);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'updated');
    assert.equal(await fs.readFile(path.join(workspace, 'app.txt'), 'utf8'), 'after\n');
    await assert.rejects(() => fs.stat(path.join(workspace, '.git')), /ENOENT/);
    await assert.rejects(() => fs.stat(path.join(workspace, '.gemini')), /ENOENT/);
    await assert.rejects(() => fs.stat(path.join(workspace, '.antigravity-cli')), /ENOENT/);
    assert.equal(fake.requests.length, 2);

    const historyFiles = await fs.readdir(path.join(stateRoot, 'history'));
    assert.equal(historyFiles.length, 1);
  } finally {
    await fake.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test('failed agent work is discarded in a non-Git folder', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-nogit-fail-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-nogit-fail-state-'));
  await fs.writeFile(path.join(workspace, 'app.txt'), 'before\n', 'utf8');
  const fake = await startFakeGemini((index) => index === 0
    ? writeFileCall('app.txt', 'staged-only\n')
    : { status: 500, body: { error: { message: 'forced failure' } } });

  try {
    const result = await runCli(workspace, stateRoot, fake.baseUrl, ['-p', 'make a change']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /forced failure/);
    assert.equal(await fs.readFile(path.join(workspace, 'app.txt'), 'utf8'), 'before\n');
    await assert.rejects(() => fs.stat(path.join(workspace, '.git')), /ENOENT/);
    await assert.rejects(() => fs.stat(path.join(stateRoot, 'history')), /ENOENT/);
  } finally {
    await fake.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test('one-shot attachments reach the model without creating project metadata', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-attach-cli-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-attach-state-'));
  await fs.writeFile(path.join(workspace, 'notes.md'), '# requirement\nuse port 8080\n', 'utf8');
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  await fs.writeFile(path.join(workspace, 'screen.png'), imageBytes);
  const fake = await startFakeGemini(() => modelText('attachments received'));

  try {
    const result = await runCli(workspace, stateRoot, fake.baseUrl, [
      '--attach', 'notes.md',
      '--attach', 'screen.png',
      '-p', 'use the attachments'
    ]);

    assert.equal(result.code, 0, result.stderr);
    const contents = fake.requests[0].body.contents;
    const userParts = contents.at(-1).parts;
    assert.match(userParts.find((part) => part.text?.includes('Attachment: notes.md')).text, /port 8080/);
    const inline = userParts.find((part) => part.inlineData);
    assert.equal(inline.inlineData.mimeType, 'image/png');
    assert.equal(inline.inlineData.data, imageBytes.toString('base64'));
    assert.deepEqual((await fs.readdir(workspace)).sort(), ['notes.md', 'screen.png']);
  } finally {
    await fake.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test('persisted conversation is restored on the next CLI launch', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-history-cli-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-history-cli-state-'));
  const first = await startFakeGemini(() => modelText('first answer'));

  try {
    const firstRun = await runCli(workspace, stateRoot, first.baseUrl, ['-p', 'first question']);
    assert.equal(firstRun.code, 0, firstRun.stderr);
    await first.close();

    const second = await startFakeGemini((_index, body) => {
      const serialized = JSON.stringify(body.contents);
      assert.match(serialized, /first question/);
      assert.match(serialized, /first answer/);
      assert.match(serialized, /second question/);
      return modelText('second answer');
    });

    try {
      const secondRun = await runCli(workspace, stateRoot, second.baseUrl, ['-p', 'second question']);
      assert.equal(secondRun.code, 0, secondRun.stderr);
      assert.equal(secondRun.stdout.trim(), 'second answer');
    } finally {
      await second.close();
    }
  } finally {
    try { await first.close(); } catch {}
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test('persisted global preferences control model, reasoning, auth, and approval on a later process', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-settings-cli-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-settings-cli-state-'));
  await fs.writeFile(path.join(stateRoot, 'settings.json'), JSON.stringify({
    version: 1,
    model: 'gemini-3.8-flash',
    reasoning: 'high',
    auth: 'api-key',
    approval: 'yes'
  }), 'utf8');
  const fake = await startFakeGemini((index, body, request) => {
    if (index === 0) {
      assert.match(request.url, /models\/gemini-3\.8-flash:generateContent/);
      assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 8192);
      return {
        body: {
          candidates: [{ content: { role: 'model', parts: [{ functionCall: {
            name: 'run_command',
            args: { command: 'node -e "require(\'fs\').writeFileSync(\'preference.txt\',\'persisted\')"' }
          } }] } }]
        }
      };
    }
    return modelText('preferences applied');
  });

  try {
    const result = await runCli(workspace, stateRoot, fake.baseUrl, ['-p', 'use saved settings'], { explicitAuth: false });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'preferences applied');
    assert.equal(await fs.readFile(path.join(workspace, 'preference.txt'), 'utf8'), 'persisted');
  } finally {
    await fake.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test('agy init is explicit, creates only AGENTS.md, and refuses overwrite', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-init-cli-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-init-cli-state-'));
  try {
    const first = await runStandalone(workspace, stateRoot, ['init']);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /Created AGENTS\.md/);
    assert.deepEqual(await fs.readdir(workspace), ['AGENTS.md']);
    const second = await runStandalone(workspace, stateRoot, ['init']);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /already exists/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});
