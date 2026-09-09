import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverApiModels } from '../src/agent.js';
import {
  buildAntigravityArgs,
  buildReasoningDefaults,
  discoverGoogleModels,
  discoverOfficialAntigravityModels,
  discoverPublicGoogleModels,
  ensureOfficialAntigravityCli,
  GoogleAccountAgent,
  googleAccountEnv,
  googleRuntimeStatus,
  installOfficialAntigravityCli,
  loginWithGoogle,
  officialAntigravityBinaryPath,
  officialAntigravityMetadataPath,
  providerProvenanceStatus,
  probeOfficialAntigravityBinary,
  parseAntigravityJson,
  parseAntigravityModels,
  parsePublicGoogleModels,
  resolveAntigravityModel,
  runOfficialAntigravityLogin,
  updateOfficialAntigravityCli,
  verifyOfficialAntigravitySubscription
} from '../src/google-agent.js';

test('google account environment removes competing credentials but preserves cloud project', () => {
  const env = googleAccountEnv({
    GEMINI_API_KEY: 'secret',
    GOOGLE_API_KEY: 'secret-2',
    GOOGLE_GENAI_USE_VERTEXAI: 'true',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/key.json',
    GOOGLE_CLOUD_PROJECT: 'example-project',
    PATH: 'example-path'
  });

  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.GOOGLE_API_KEY, undefined);
  assert.equal(env.GOOGLE_GENAI_USE_VERTEXAI, undefined);
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(env.GOOGLE_CLOUD_PROJECT, 'example-project');
  assert.equal(env.GOOGLE_GENAI_USE_GCA, undefined);
  assert.equal(env.PATH, 'example-path');
  assert.equal(env.NO_COLOR, '1');
});

test('official Antigravity backend path is isolated from the npm agy shim', () => {
  assert.equal(
    officialAntigravityBinaryPath({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      home: 'ignored'
    }),
    'C:\\Users\\me\\AppData\\Local\\antigravity-cli-npm\\provider\\agy.exe'
  );
  assert.equal(
    officialAntigravityBinaryPath({ platform: 'linux', env: {}, home: '/home/me' }),
    path.join('/home/me', '.local', 'share', 'antigravity-cli-npm', 'provider', 'agy')
  );
  assert.equal(
    officialAntigravityBinaryPath({ platform: 'linux', env: { XDG_DATA_HOME: '/data/me' }, home: '/home/me' }),
    path.join('/data/me', 'antigravity-cli-npm', 'provider', 'agy')
  );
  assert.equal(
    officialAntigravityBinaryPath({ platform: 'darwin', env: {}, home: '/Users/me' }),
    path.join('/Users/me', 'Library', 'Application Support', 'antigravity-cli-npm', 'provider', 'agy')
  );
  assert.equal(
    officialAntigravityBinaryPath({ platform: 'win32', env: { ANTIGRAVITY_CLI_BINARY: 'D:\\provider\\agy.exe' } }),
    path.resolve('D:\\provider\\agy.exe')
  );
});

test('official Antigravity backend auto-install stays outside PATH and honors its isolated target', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-official-install-'));
  const binaryPath = path.join(root, 'provider', 'agy.exe');
  let invocation = null;
  try {
    const installed = await installOfficialAntigravityCli({
      platform: 'win32',
      binaryPath,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async text() { return '@echo off\r\n'; }
      }),
      captureImpl: async (executable, args) => {
        invocation = { executable, args };
        await fs.mkdir(path.dirname(binaryPath), { recursive: true });
        await fs.writeFile(binaryPath, 'provider', 'utf8');
        return { code: 0, stdout: '', stderr: '' };
      }
    });
    assert.equal(installed, binaryPath);
    assert.equal(invocation.executable, 'cmd.exe');
    assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/c', invocation.args[2]]);
    assert.match(invocation.args[2], /agy-google-backend-.*\.cmd$/);
    assert.deepEqual(invocation.args.slice(3), ['--dir', path.dirname(binaryPath), '--skip-path', '--skip-aliases']);
    const provenance = await providerProvenanceStatus({ binaryPath });
    assert.equal(provenance.status, 'verified');
    assert.equal(provenance.sourceUrl, 'https://antigravity.google/cli/install.cmd');
    assert.match(provenance.installerSha256, /^[a-f0-9]{64}$/);
    assert.equal(path.basename(officialAntigravityMetadataPath({ binaryPath })), 'provider.json');

    let installs = 0;
    assert.equal(await ensureOfficialAntigravityCli({
      platform: 'win32',
      binaryPath,
      installImpl: async () => { installs += 1; return binaryPath; },
      probeImpl: async () => ({ ready: true, version: '1.2.3', error: null })
    }), binaryPath);
    assert.equal(installs, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an unhealthy default backend is replaced and revalidated automatically', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-backend-repair-'));
  const binaryPath = path.join(root, 'agy.exe');
  await fs.writeFile(binaryPath, 'broken', 'utf8');
  let probes = 0;
  let installs = 0;
  try {
    const result = await ensureOfficialAntigravityCli({
      platform: 'win32',
      binaryPath,
      env: {},
      probeImpl: async () => {
        probes += 1;
        return probes === 1
          ? { ready: false, version: null, error: 'unhealthy' }
          : { ready: true, version: '1.2.4', error: null };
      },
      installImpl: async () => {
        installs += 1;
        await fs.writeFile(binaryPath, 'repaired', 'utf8');
        return binaryPath;
      }
    });
    assert.equal(result, binaryPath);
    assert.equal(installs, 1);
    assert.equal(probes, 2);
    assert.equal(await fs.readFile(binaryPath, 'utf8'), 'repaired');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('provider update validates the new binary and rolls back on failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-provider-update-'));
  const binaryPath = path.join(root, 'provider', 'agy.exe');
  await fs.mkdir(path.dirname(binaryPath), { recursive: true });
  await fs.writeFile(binaryPath, 'old-provider', 'utf8');
  try {
    const updated = await updateOfficialAntigravityCli({
      platform: 'win32',
      env: {},
      binaryPath,
      installImpl: async ({ binaryPath: target }) => {
        await fs.writeFile(target, 'new-provider', 'utf8');
        return target;
      },
      probeImpl: async () => ({ ready: true, version: '9.9.9', error: null })
    });
    assert.equal(updated.version, '9.9.9');
    assert.equal(await fs.readFile(binaryPath, 'utf8'), 'new-provider');

    await assert.rejects(() => updateOfficialAntigravityCli({
      platform: 'win32',
      env: {},
      binaryPath,
      installImpl: async ({ binaryPath: target }) => {
        await fs.writeFile(target, 'broken-provider', 'utf8');
        return target;
      },
      probeImpl: async () => ({ ready: false, version: null, error: 'broken' })
    }), /not usable/);
    assert.equal(await fs.readFile(binaryPath, 'utf8'), 'new-provider');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('provider update refuses to take ownership of an externally configured backend', async () => {
  await assert.rejects(() => updateOfficialAntigravityCli({
    platform: 'linux',
    env: { ANTIGRAVITY_CLI_BINARY: '/opt/agy' },
    binaryPath: '/opt/agy'
  }), /externally managed backend/);
});

test('backend health probe validates the official binary version without exposing provider output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-backend-health-'));
  const binaryPath = path.join(root, 'agy.exe');
  await fs.writeFile(binaryPath, 'placeholder', 'utf8');
  try {
    let call = null;
    const status = await probeOfficialAntigravityBinary({
      binaryPath,
      captureImpl: async (binary, args, options) => {
        call = { binary, args, options };
        return { code: 0, stdout: '1.2.3\n', stderr: 'provider noise' };
      }
    });
    assert.deepEqual(status, { ready: true, version: '1.2.3', error: null });
    assert.equal(call.binary, binaryPath);
    assert.deepEqual(call.args, ['--version']);
    assert.equal(call.options.timeoutMs, 10_000);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Google runtime status reports backend readiness and account connectivity from hidden probes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-runtime-status-'));
  const binaryPath = path.join(root, 'agy.exe');
  await fs.writeFile(binaryPath, 'placeholder', 'utf8');
  try {
    const status = await googleRuntimeStatus({
      binaryPath,
      captureImpl: async (_binary, args) => args[0] === '--version'
        ? { code: 0, stdout: '1.2.3\n', stderr: '' }
        : { code: 0, stdout: 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n', stderr: 'Fetching...' }
    });
    assert.deepEqual(status, { backend: 'ready', account: 'connected', version: '1.2.3' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('official Antigravity model output is normalized to base Gemini model IDs', () => {
  assert.deepEqual(parseAntigravityModels(`
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
`), ['gemini-3.8-flash', 'gemini-3.1-pro', 'claude-sonnet-4-6']);
});

test('official Antigravity model discovery hides provider progress and returns subscription models', async () => {
  let call = null;
  const models = await discoverOfficialAntigravityModels({
    ensureImpl: async () => 'provider-agy',
    captureImpl: async (binary, args) => {
      call = { binary, args };
      return {
        code: 0,
        stdout: 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6\n',
        stderr: 'Fetching available models...'
      };
    }
  });
  assert.deepEqual(call, { binary: 'provider-agy', args: ['models'] });
  assert.deepEqual(models, ['gemini-3.8-flash', 'claude-sonnet-4-6']);
});

test('Antigravity request args preserve model, reasoning, permissions, attachments, and conversation', () => {
  const args = buildAntigravityArgs({
    prompt: 'inspect project',
    model: 'gemini-3.8-flash',
    reasoning: 'high',
    yes: true,
    attachments: [
      { stagedPath: path.join('C:\\tmp', 'inputs', 'one.png') },
      { stagedPath: path.join('C:\\tmp', 'inputs', 'two.pdf') }
    ],
    conversationId: 'conversation-1'
  });
  assert.deepEqual(args.slice(0, 6), [
    '-p', 'inspect project', '--output-format', 'json', '--disable-slash-commands', '--print-timeout'
  ]);
  assert.ok(args.includes('10m'));
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'gemini-3.8-flash']);
  assert.deepEqual(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2), ['--effort', 'high']);
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.equal(args.includes('--sandbox'), false);
  assert.deepEqual(args.slice(args.indexOf('--conversation'), args.indexOf('--conversation') + 2), ['--conversation', 'conversation-1']);
  assert.equal(args.filter((item) => item === '--add-dir').length, 1);
});

test('normal Google mode permits project tools inside the provider sandbox', () => {
  const args = buildAntigravityArgs({ prompt: 'check the project', yes: false });
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(args.includes('--sandbox'));
});

test('Antigravity aliases resolve against models actually available to the subscription', async () => {
  const modelsLoader = async () => ['gemini-3.7-flash', 'gemini-3.1-pro', 'gemini-3.8-flash', 'claude-sonnet-4-6'];
  assert.equal(await resolveAntigravityModel('flash', { modelsLoader }), 'gemini-3.8-flash');
  assert.equal(await resolveAntigravityModel('pro', { modelsLoader }), 'gemini-3.1-pro');
  assert.equal(await resolveAntigravityModel('gemini-3.8-flash', { modelsLoader }), 'gemini-3.8-flash');
  assert.equal(await resolveAntigravityModel('auto', { modelsLoader }), null);
  await assert.rejects(() => resolveAntigravityModel('flash-lite', { modelsLoader }), /not currently available/);
});

test('Antigravity JSON parser returns response and conversation ID', () => {
  assert.deepEqual(
    parseAntigravityJson('{"conversation_id":"abc","status":"SUCCESS","response":"done\\n"}'),
    { response: 'done', conversationId: 'abc' }
  );
  assert.throws(
    () => parseAntigravityJson('{"status":"ERROR","response":"","error":"authentication required"}'),
    /authentication required/
  );
  assert.deepEqual(
    parseAntigravityJson('{"conversation_id":"empty","status":"SUCCESS","response":""}'),
    { response: '', conversationId: 'empty' }
  );
});

test('high reasoning config covers Gemini 3 and Gemini 2.5 auto fallbacks', () => {
  const config = buildReasoningDefaults('auto', 'high');
  const overrides = config.modelConfigs.customOverrides;
  const gemini3 = overrides.find((item) => item.match.model === 'gemini-3.1-pro-preview');
  const gemini25 = overrides.find((item) => item.match.model === 'gemini-2.5-pro');

  assert.equal(gemini3.modelConfig.generateContentConfig.thinkingConfig.thinkingLevel, 'HIGH');
  assert.equal(gemini25.modelConfig.generateContentConfig.thinkingConfig.thinkingBudget, 8192);
  assert.equal(config.ui.inlineThinkingMode, 'off');
});

test('official login launches the Antigravity binary with no arguments in a hidden temporary PTY', async () => {
  let probeCount = 0;
  let spawnCall = null;
  let killed = false;
  const terminal = {
    onData(callback) { this.dataCallback = callback; },
    onExit(callback) { this.exitCallback = callback; },
    kill() { killed = true; }
  };

  const result = await runOfficialAntigravityLogin({
    ensureImpl: async () => 'C:\\provider\\agy.exe',
    accountProbe: async () => {
      probeCount += 1;
      return probeCount >= 3;
    },
    ptyLoader: async () => ({
      spawn(executable, args, options) {
        spawnCall = { executable, args, options };
        return terminal;
      }
    }),
    pollMs: 1,
    timeoutMs: 250,
    env: { PATH: 'test-path', GEMINI_API_KEY: 'must-not-leak' }
  });

  assert.equal(result, true);
  assert.equal(spawnCall.executable, 'C:\\provider\\agy.exe');
  assert.deepEqual(spawnCall.args, []);
  assert.match(path.basename(spawnCall.options.cwd), /^agy-official-login-/);
  assert.equal(spawnCall.options.env.GEMINI_API_KEY, undefined);
  assert.equal(spawnCall.options.env.NO_COLOR, '1');
  assert.equal(killed, true);
});

test('official login reports provider exit without exposing terminal escape sequences', async () => {
  const terminal = {
    onData(callback) { callback('\u001b[31mAuthentication failed\u001b[0m'); },
    onExit(callback) { callback({ exitCode: 7 }); },
    kill() {}
  };

  await assert.rejects(
    () => runOfficialAntigravityLogin({
      ensureImpl: async () => 'official-agy',
      accountProbe: async () => false,
      ptyLoader: async () => ({ spawn: () => terminal }),
      pollMs: 1,
      timeoutMs: 50
    }),
    (error) => {
      assert.match(error.message, /exit 7/);
      assert.match(error.message, /Authentication failed/);
      assert.equal(error.message.includes('\u001b'), false);
      return true;
    }
  );
});

test('agy login delegates first-run authentication to official Antigravity and verifies it', async () => {
  const notices = [];
  let connected = false;
  let loginCalls = 0;
  let verifyCalls = 0;

  await loginWithGoogle({
    notify: (message) => notices.push(message),
    officialProbe: async () => connected,
    officialLogin: async () => {
      loginCalls += 1;
      connected = true;
      return true;
    },
    officialVerify: async () => {
      verifyCalls += 1;
      return true;
    }
  });

  assert.deepEqual(notices, ['Complete sign-in in your browser.']);
  assert.equal(loginCalls, 1);
  assert.equal(verifyCalls, 1);
});

test('fresh subscription verification is headless, isolated, and checks the returned response', async () => {
  let call = null;
  await verifyOfficialAntigravitySubscription({
    ensureImpl: async () => 'official-agy',
    captureImpl: async (binary, args, options) => {
      call = { binary, args, options };
      return { code: 0, stdout: '{"status":"SUCCESS","response":"OK\\n"}', stderr: '' };
    }
  });
  assert.equal(call.binary, 'official-agy');
  assert.ok(call.args.includes('--disable-slash-commands'));
  assert.match(path.basename(call.options.cwd), /^agy-login-check-/);
});

test('login reuses an existing official Antigravity keyring session silently', async () => {
  let loginCalls = 0;
  let verifyCalls = 0;
  const notices = [];

  await loginWithGoogle({
    notify: (message) => notices.push(message),
    officialProbe: async () => true,
    officialLogin: async () => { loginCalls += 1; },
    officialVerify: async () => { verifyCalls += 1; }
  });

  assert.deepEqual(notices, []);
  assert.equal(loginCalls, 0);
  assert.equal(verifyCalls, 0);
});

test('official login times out and always terminates its hidden PTY', async () => {
  let killed = false;
  const terminal = {
    onData(callback) { callback('Waiting for browser sign-in'); },
    onExit() {},
    kill() { killed = true; }
  };

  await assert.rejects(
    () => runOfficialAntigravityLogin({
      ensureImpl: async () => 'official-agy',
      accountProbe: async () => false,
      ptyLoader: async () => ({ spawn: () => terminal }),
      pollMs: 1,
      timeoutMs: 10
    }),
    /timed out.*Waiting for browser sign-in/
  );
  assert.equal(killed, true);
});

test('public model parser keeps general Pro/Flash IDs without matching specialized suffixes', () => {
  const html = `
    <a href="/gemini-api/docs/models/gemini-3.8-flash">3.8</a>
    <a href="/gemini-api/docs/models/gemini-4-pro-preview">4 Pro</a>
    <a href="/gemini-api/docs/models/gemini-3.1-flash-tts-preview">TTS</a>
    <a href="/gemini-api/docs/models/gemini-3.1-flash-image">Image</a>
  `;
  assert.deepEqual(parsePublicGoogleModels(html), ['gemini-3.8-flash', 'gemini-4-pro-preview']);
});

test('public model discovery reads newly documented models independently of the installed provider', async () => {
  const models = await discoverPublicGoogleModels({
    platform: 'linux',
    curlLoader: null,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return '<a href="/gemini-api/docs/models/gemini-3.8-flash">Gemini 3.8 Flash</a>';
      }
    })
  });
  assert.deepEqual(models, ['gemini-3.8-flash']);
});

test('Google model discovery falls back to the public catalog when official discovery is unavailable', async () => {
  const models = await discoverGoogleModels({
    platform: 'linux',
    officialModelsLoader: async () => [],
    curlLoader: null,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return `
          <a href="/gemini-api/docs/models/gemini-3.8-flash">3.8</a>
          <a href="/gemini-api/docs/models/gemini-4-pro-preview">4 Pro</a>
        `;
      }
    })
  });
  assert.deepEqual(models, ['gemini-3.8-flash', 'gemini-4-pro-preview']);
});

test('Google model discovery prefers models exposed by the signed-in Antigravity subscription', async () => {
  const models = await discoverGoogleModels({
    officialModelsLoader: async () => ['gemini-3.8-flash', 'gemini-3.1-pro', 'claude-sonnet-4-6'],
    platform: 'linux',
    curlLoader: null,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() { return '<a>gemini-9-flash</a>'; }
    })
  });
  assert.deepEqual(models, ['gemini-3.8-flash', 'gemini-3.1-pro', 'claude-sonnet-4-6']);
});

test('GoogleAccountAgent executes through official Antigravity headless mode and resumes its conversation', async () => {
  const calls = [];
  const agent = new GoogleAccountAgent({
    workspace: path.join('C:\\tmp', 'stage'),
    displayWorkspace: path.join('C:\\project'),
    model: 'gemini-3.8-flash',
    reasoning: 'high',
    yes: true,
    backend: {
      ensure: async () => 'official-agy',
      models: async () => ['gemini-3.8-flash'],
      capture: async (binary, args, options) => {
        calls.push({ binary, args, options });
        return {
          code: 0,
          stdout: JSON.stringify({
            conversation_id: 'conversation-123',
            status: 'SUCCESS',
            response: calls.length === 1 ? 'first answer' : 'second answer'
          }),
          stderr: ''
        };
      }
    }
  });

  assert.equal(await agent.prompt('first request'), 'first answer');
  assert.equal(await agent.prompt('second request'), 'second answer');
  assert.equal(calls[0].binary, 'official-agy');
  assert.ok(calls[0].args.includes('--disable-slash-commands'));
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf('--model'), calls[0].args.indexOf('--model') + 2), ['--model', 'gemini-3.8-flash']);
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf('--effort'), calls[0].args.indexOf('--effort') + 2), ['--effort', 'high']);
  assert.ok(calls[0].args.includes('--dangerously-skip-permissions'));
  const firstPrompt = calls[0].args[calls[0].args.indexOf('-p') + 1];
  assert.match(firstPrompt, /Never use emojis/);
  assert.match(firstPrompt, /final section titled "Summary"/);
  assert.match(firstPrompt, /Summary section must be the last section/);
  assert.match(firstPrompt, /Operate autonomously/);
  assert.match(firstPrompt, /Do not stop at the first failed check/);
  assert.match(firstPrompt, /run appropriate tests\/build\/lint\/type checks/);
  assert.equal(calls[0].options.env.GOOGLE_GENAI_USE_GCA, undefined);
  assert.deepEqual(calls[1].args.slice(calls[1].args.indexOf('--conversation'), calls[1].args.indexOf('--conversation') + 2), ['--conversation', 'conversation-123']);
});

test('GoogleAccountAgent recovers an empty successful provider response and returns the recovery text', async () => {
  const calls = [];
  const agent = new GoogleAccountAgent({
    workspace: path.join('C:\\tmp', 'stage'),
    displayWorkspace: path.join('C:\\project'),
    model: 'gemini-3.8-flash',
    backend: {
      ensure: async () => 'official-agy',
      models: async () => ['gemini-3.8-flash'],
      capture: async (_binary, args) => {
        calls.push(args);
        if (calls.length === 1) {
          return {
            code: 0,
            stdout: JSON.stringify({ conversation_id: 'conversation-empty', status: 'SUCCESS', response: '' }),
            stderr: ''
          };
        }
        return {
          code: 0,
          stdout: JSON.stringify({ conversation_id: 'conversation-empty', status: 'SUCCESS', response: 'Project checked. No issues found.' }),
          stderr: ''
        };
      }
    }
  });

  assert.equal(await agent.prompt('check the project'), 'Project checked. No issues found.');
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[1].slice(calls[1].indexOf('--conversation'), calls[1].indexOf('--conversation') + 2),
    ['--conversation', 'conversation-empty']
  );
  const recoveryPrompt = calls[1][calls[1].indexOf('-p') + 1];
  assert.match(recoveryPrompt, /non-empty final user-facing response/);
  assert.match(recoveryPrompt, /Do not use emojis/);
  assert.match(recoveryPrompt, /Summary/);
});

test('GoogleAccountAgent rejects a truly empty response instead of printing a placeholder', async () => {
  const agent = new GoogleAccountAgent({
    workspace: path.join('C:\\tmp', 'stage'),
    displayWorkspace: path.join('C:\\project'),
    model: 'gemini-3.8-flash',
    backend: {
      ensure: async () => 'official-agy',
      models: async () => ['gemini-3.8-flash'],
      capture: async () => ({ code: 0, stdout: '{"status":"SUCCESS","response":""}', stderr: '' })
    }
  });

  await assert.rejects(() => agent.prompt('check the project'), /returned no final response text/);
});

test('GoogleAccountAgent marks provider authentication failures for automatic CLI re-bootstrap', async () => {
  const agent = new GoogleAccountAgent({
    workspace: path.join('C:\\tmp', 'stage'),
    displayWorkspace: path.join('C:\\project'),
    model: 'gemini-3.8-flash',
    backend: {
      ensure: async () => 'official-agy',
      models: async () => ['gemini-3.8-flash'],
      capture: async () => ({
        code: 1,
        stdout: '',
        stderr: 'Authentication required. Please sign in.'
      })
    }
  });

  await assert.rejects(
    () => agent.prompt('test request'),
    (error) => {
      assert.equal(error.code, 'GOOGLE_AUTH_REQUIRED');
      assert.match(error.message, /reopen automatically/i);
      assert.doesNotMatch(error.message, /agy login/i);
      return true;
    }
  );
});

test('API-key model discovery uses the provider list endpoint and generateContent capability', async () => {
  let requested = null;
  const models = await discoverApiModels({
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1beta',
    fetchImpl: async (url) => {
      requested = url;
      return {
        ok: true,
        async json() {
          return {
            models: [
              { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
              { name: 'models/gemini-4-pro-preview', supportedGenerationMethods: ['generateContent'] }
            ]
          };
        }
      };
    }
  });

  assert.equal(requested, 'https://example.test/v1beta/models?key=test-key');
  assert.deepEqual(models, ['gemini-3.8-flash', 'gemini-4-pro-preview']);
});
