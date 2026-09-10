import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyAuthMode, createGoogleAuthBootstrap, plainTerminalText, promptLabel, runWithGoogleAuthRecovery } from '../src/cli.js';
import { commandSandboxReadiness } from '../src/command-sandbox.js';
import { appendConversationTurn, createHistoryStore } from '../src/history.js';
import { createStagingWorkspace } from '../src/staging.js';
import { createTaskStore } from '../src/task-state.js';

const CLI = fileURLToPath(new URL('../bin/agy.js', import.meta.url));
const COMMAND_SANDBOX_READY = (await commandSandboxReadiness()).ready;

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

function runCliCommand(workspace, stateRoot, baseUrl, command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, command, '--auth', 'api-key', '--base-url', baseUrl, ...args], {
      cwd: workspace,
      windowsHide: true,
      env: { ...process.env, GEMINI_API_KEY: 'test-key', ANTIGRAVITY_HOME: stateRoot },
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

test('interactive prompt uses a minimal antigyc shell indicator', () => {
  assert.equal(promptLabel('C:\\projects\\my-app'), 'antigyc C:\\projects\\my-app> ');
});

test('one-shot CLI quarantines corrupt history and continues with a fresh saved turn', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-cli-corrupt-history-project-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-cli-corrupt-history-state-'));
  const fake = await startFakeGemini(async () => modelText('Recovered session.\n\nSummary\nRecovered.'));
  try {
    const store = await createHistoryStore(workspace, { baseDir: stateRoot });
    await fs.mkdir(path.dirname(store.path), { recursive: true });
    await fs.writeFile(store.path, '{"messages":[', 'utf8');

    const result = await runCli(workspace, stateRoot, fake.baseUrl, ['--turbo', '-p', 'continue after corrupt history']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Conversation history was invalid and was moved to/);
    assert.match(result.stdout, /Recovered session/);
    assert.equal(result.stderr, '');

    const saved = await store.load();
    assert.equal(saved.length, 2);
    assert.match(saved[0].text, /continue after corrupt history/);
    assert.match(saved[1].text, /Recovered session/);
  } finally {
    await fake.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test('one-shot CLI keeps a very large persisted conversation within the model request budget', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-cli-long-history-project-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-cli-long-history-state-'));
  let requestChars = 0;
  let requestText = '';
  const fake = await startFakeGemini(async (_index, body) => {
    requestText = JSON.stringify(body.contents);
    requestChars = requestText.length;
    return modelText('Long history continued.\n\nSummary\nContinued.');
  });
  try {
    const store = await createHistoryStore(workspace, { baseDir: stateRoot });
    let history = [];
    for (let index = 0; index < 100; index += 1) {
      history = appendConversationTurn(
        history,
        `request-${index} ${'u'.repeat(12_000)}`,
        [],
        `reply-${index} ${'a'.repeat(12_000)}`
      );
    }
    await store.save(history);

    const result = await runCli(workspace, stateRoot, fake.baseUrl, ['--turbo', '-p', 'continue this long conversation']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Long history continued/);
    assert.ok(requestChars < 70_000);
    assert.match(requestText, /request-99/);
    assert.doesNotMatch(requestText, /request-0\b/);

    const saved = await store.load();
    assert.equal(saved.length, 200);
    assert.match(saved.at(-2).text, /continue this long conversation/);
    assert.match(saved.at(-1).text, /Long history continued/);
  } finally {
    await fake.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test('terminal response rendering removes Markdown syntax without corrupting fenced code', () => {
  const rendered = plainTerminalText([
    '# Result',
    '',
    '**Fixed** `src/app.js` and [docs](https://example.com).',
    '',
    '```js',
    '# literal code comment',
    'const value = "**literal**";',
    '```',
    '',
    '| Check | Result |',
    '| --- | --- |',
    '| tests | passed |',
    '',
    'Summary',
    '__Done__.'
  ].join('\n'));

  assert.equal(rendered, [
    'Result',
    '',
    'Fixed src/app.js and docs (https://example.com).',
    '',
    '# literal code comment',
    'const value = "**literal**";',
    '',
    'Check | Result',
    'tests | passed',
    '',
    'Summary',
    'Done.'
  ].join('\n'));
  assert.doesNotMatch(rendered, /```|__|^# Result$/m);
});

test('normal Google use bootstraps authentication once without a separate login command', async () => {
  const options = { auth: 'google' };
  const notices = [];
  let loginCalls = 0;
  const forceValues = [];
  const bootstrap = createGoogleAuthBootstrap(options, {
    notify: (message) => notices.push(message),
    login: async ({ notify, force }) => {
      loginCalls += 1;
      forceValues.push(force);
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
  assert.deepEqual(forceValues, [false, false]);

  assert.equal(await bootstrap.ensure({ force: true }), true);
  assert.equal(loginCalls, 3);
  assert.deepEqual(forceValues, [false, false, true]);
});

test('Google auth bootstrap forwards the request AbortSignal to login', async () => {
  const options = { auth: 'google' };
  const controller = new AbortController();
  let receivedSignal = null;
  const bootstrap = createGoogleAuthBootstrap(options, {
    login: async ({ signal }) => {
      receivedSignal = signal;
    }
  });

  assert.equal(await bootstrap.ensure({ signal: controller.signal }), true);
  assert.equal(receivedSignal, controller.signal);
});

test('auth google persists the mode and authenticates immediately', async () => {
  const options = { auth: 'api-key' };
  const updates = [];
  let resets = 0;
  let ensures = 0;
  const controller = new AbortController();

  await applyAuthMode('google', {
    options,
    settingsStore: { update: async (value) => updates.push(value) },
    authBootstrap: {
      reset() { resets += 1; },
      async ensure({ signal, force }) {
        ensures += 1;
        assert.equal(signal, controller.signal);
        assert.equal(force, true);
        return true;
      }
    },
    signal: controller.signal
  });

  assert.equal(options.auth, 'google');
  assert.deepEqual(updates, [{ auth: 'google' }]);
  assert.equal(resets, 1);
  assert.equal(ensures, 1);
});

test('Google request transparently reauthenticates and retries once after an auth-expiry error', async () => {
  const options = { auth: 'google' };
  let ensures = 0;
  let resets = 0;
  let actions = 0;
  const forceValues = [];
  const authBootstrap = {
    async ensure({ force = false } = {}) { ensures += 1; forceValues.push(force); return true; },
    reset() { resets += 1; }
  };

  const result = await runWithGoogleAuthRecovery(options, authBootstrap, async () => {
    actions += 1;
    if (actions === 1) {
      const error = new Error('sign in required');
      error.code = 'GOOGLE_AUTH_REQUIRED';
      throw error;
    }
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(actions, 2);
  assert.equal(ensures, 2);
  assert.equal(resets, 1);
  assert.deepEqual(forceValues, [false, true]);
});

test('resume does not discard and restart preserved work after an auth-expiry error', async () => {
  const options = { auth: 'google' };
  let actions = 0;
  let resets = 0;
  const error = new Error('sign in required');
  error.code = 'GOOGLE_AUTH_REQUIRED';

  await assert.rejects(
    () => runWithGoogleAuthRecovery(options, {
      async ensure() { return true; },
      reset() { resets += 1; }
    }, async () => {
      actions += 1;
      throw error;
    }, { resume: true }),
    (caught) => caught === error
  );

  assert.equal(actions, 1);
  assert.equal(resets, 0);
});

test('message shorthand sends one-shot text and capital M selects a model', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-message-cli-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-message-state-'));
  const fake = await startFakeGemini((_index, body, request) => {
    assert.match(request.url, /models\/gemini-3\.8-flash:generateContent/);
    assert.match(JSON.stringify(body.contents), /hello from message flag/);
    return modelText('message received');
  });

  try {
    const result = await runCli(workspace, stateRoot, fake.baseUrl, ['-M', 'gemini-3.8-flash', '-m', 'hello from message flag']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'message received');
  } finally {
    await fake.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test('one-shot editing works in a folder with no Git repository', { skip: !COMMAND_SANDBOX_READY }, async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-nogit-cli-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-nogit-state-'));
  await fs.writeFile(path.join(workspace, 'app.txt'), 'before\n', 'utf8');
  const fake = await startFakeGemini((index) => {
    if (index === 0) return writeFileCall('app.txt', 'after\n');
    if (index === 1) return modelText('updated');
    if (index === 2) {
      return {
        body: {
          candidates: [{ content: { role: 'model', parts: [{ functionCall: {
            name: 'run_process',
            args: { executable: process.execPath, args: ['-e', 'process.exit(0)'] }
          } }] } }]
        }
      };
    }
    return modelText('updated');
  });

  try {
    await assert.rejects(() => fs.stat(path.join(workspace, '.git')), /ENOENT/);
    const result = await runCli(workspace, stateRoot, fake.baseUrl, ['--yes', '-p', 'update app.txt']);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'updated');
    assert.equal(await fs.readFile(path.join(workspace, 'app.txt'), 'utf8'), 'after\n');
    await assert.rejects(() => fs.stat(path.join(workspace, '.git')), /ENOENT/);
    await assert.rejects(() => fs.stat(path.join(workspace, '.gemini')), /ENOENT/);
    await assert.rejects(() => fs.stat(path.join(workspace, '.antigravity-cli')), /ENOENT/);
    assert.equal(fake.requests.length, 4);

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

test('turbo flag allows one-shot command execution without an approval prompt', { skip: !COMMAND_SANDBOX_READY }, async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-turbo-cli-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-turbo-state-'));
  const fake = await startFakeGemini((index) => {
    if (index === 0) {
      return {
        body: {
          candidates: [{ content: { role: 'model', parts: [{ functionCall: {
            name: 'run_command',
            args: { command: 'node -e "require(\'fs\').writeFileSync(\'turbo.txt\',\'enabled\')"' }
          } }] } }]
        }
      };
    }
    return modelText('turbo complete');
  });

  try {
    const result = await runCli(workspace, stateRoot, fake.baseUrl, ['--turbo', '-p', 'run the trusted command']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'turbo complete');
    assert.equal(await fs.readFile(path.join(workspace, 'turbo.txt'), 'utf8'), 'enabled');
  } finally {
    await fake.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test('persisted global preferences control model, reasoning, and auth on a later process', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-settings-cli-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-settings-cli-state-'));
  await fs.writeFile(path.join(stateRoot, 'settings.json'), JSON.stringify({
    version: 1,
    model: 'gemini-3.8-flash',
    reasoning: 'high',
    auth: 'api-key',
    approval: 'yes'
  }), 'utf8');
  const fake = await startFakeGemini((_index, body, request) => {
    assert.match(request.url, /models\/gemini-3\.8-flash:generateContent/);
    assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 8192);
    return modelText('preferences applied');
  });

  try {
    const result = await runCli(workspace, stateRoot, fake.baseUrl, ['-p', 'use saved settings'], { explicitAuth: false });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'preferences applied');
  } finally {
    await fake.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test('an interrupted staged task can resume safely and publish its preserved changes', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-resume-cli-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-resume-state-'));
  await fs.writeFile(path.join(workspace, 'app.txt'), 'before\n', 'utf8');
  const staging = await createStagingWorkspace(workspace);
  await staging.begin();
  await fs.writeFile(path.join(staging.workspace, 'app.txt'), 'partial from interrupted task\n', 'utf8');
  const taskStore = await createTaskStore(workspace, { baseDir: stateRoot });
  await taskStore.save({ prompt: 'update app.txt after interruption', container: staging.container, attachments: [] });
  await staging.close({ preserve: true });

  const fake = await startFakeGemini((index) => index === 0
    ? { body: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'app.txt' } } }] } }] } }
    : modelText('resumed and verified'));
  try {
    const result = await runCliCommand(workspace, stateRoot, fake.baseUrl, 'resume');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'resumed and verified');
    assert.equal(await fs.readFile(path.join(workspace, 'app.txt'), 'utf8'), 'partial from interrupted task\n');
    assert.equal(await taskStore.load(), null);
    const historyFiles = await fs.readdir(path.join(stateRoot, 'history'));
    assert.equal(historyFiles.length, 1);
  } finally {
    await fake.close();
    await taskStore.clear({ removeStage: true }).catch(() => {});
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test('a new task is blocked while an interrupted staged task is waiting for resume or clear', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-resume-block-cli-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-resume-block-state-'));
  await fs.writeFile(path.join(workspace, 'app.txt'), 'before\n', 'utf8');
  const staging = await createStagingWorkspace(workspace);
  await staging.begin();
  await fs.writeFile(path.join(staging.workspace, 'app.txt'), 'pending\n', 'utf8');
  const taskStore = await createTaskStore(workspace, { baseDir: stateRoot });
  await taskStore.save({ prompt: 'pending task', container: staging.container, attachments: [] });
  await staging.close({ preserve: true });
  const fake = await startFakeGemini(() => modelText('should not run'));
  try {
    const result = await runCli(workspace, stateRoot, fake.baseUrl, ['-p', 'start a different task']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /interrupted task is available/i);
    assert.equal(fake.requests.length, 0);
    assert.equal(await fs.readFile(path.join(workspace, 'app.txt'), 'utf8'), 'before\n');
    const status = await runStandalone(workspace, stateRoot, ['task']);
    assert.match(status.stdout, /task=pending/);
    const clear = await runStandalone(workspace, stateRoot, ['task', 'clear']);
    assert.equal(clear.code, 0, clear.stderr);
    assert.equal(await taskStore.load(), null);
  } finally {
    await fake.close();
    await taskStore.clear({ removeStage: true }).catch(() => {});
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});

test('a concurrent task claim failure never clears the checkpoint owned by another process', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-cli-concurrent-project-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-cli-concurrent-state-'));
  try {
    const taskStore = await createTaskStore(workspace, { baseDir: stateRoot });
    const staging = await createStagingWorkspace(workspace);
    await staging.begin();
    await taskStore.save({ prompt: 'first process task', container: staging.container, attachments: [] });

    const result = await runCli(workspace, stateRoot, 'http://127.0.0.1:1', ['--turbo', '-p', 'second process task']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /active or waiting to be resumed|interrupted task is available/i);
    assert.equal((await taskStore.load()).prompt, 'first process task');
    await taskStore.clear({ removeStage: true });
  } finally {
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

test('CLI options that require values do not consume the next flag accidentally', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-cli-option-value-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-cli-option-state-'));
  try {
    const result = await runStandalone(workspace, stateRoot, ['--model', '--turbo']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--model requires a value/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});
