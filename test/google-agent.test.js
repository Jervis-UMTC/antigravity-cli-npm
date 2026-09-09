import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverApiModels } from '../src/agent.js';
import {
  browserLaunchCommand,
  buildAntigravityArgs,
  buildGoogleAuthUrl,
  buildReasoningDefaults,
  discoverBundledGoogleModels,
  discoverGoogleModels,
  discoverOfficialAntigravityModels,
  discoverPublicGoogleModels,
  ensureOfficialAntigravityCli,
  ensureGoogleCredentials,
  geminiOAuthCredentialsPath,
  GoogleAccountAgent,
  googleAccountEnv,
  googleRuntimeStatus,
  installOfficialAntigravityCli,
  loadGeminiOAuthMetadata,
  loginWithGoogle,
  officialAntigravityBinaryPath,
  probeOfficialAntigravityBinary,
  parseAntigravityJson,
  parseAntigravityModels,
  parseGeminiJson,
  parsePublicGoogleModels,
  resolveAntigravityModel,
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
    'C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe'
  );
  assert.equal(
    officialAntigravityBinaryPath({ platform: 'linux', env: {}, home: '/home/me' }),
    path.join('/home/me', '.local', 'bin', 'agy')
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
    assert.match(invocation.args.at(-1), /--skip-path --skip-aliases/);
    assert.match(invocation.args.at(-1), /--dir/);

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
  assert.deepEqual(args.slice(args.indexOf('--conversation'), args.indexOf('--conversation') + 2), ['--conversation', 'conversation-1']);
  assert.equal(args.filter((item) => item === '--add-dir').length, 1);
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

test('provider bundle exposes OAuth metadata used by browser-only login', async () => {
  const metadata = await loadGeminiOAuthMetadata();
  assert.match(metadata.clientId, /\.apps\.googleusercontent\.com$/);
  assert.ok(metadata.clientSecret.length > 0);
  assert.ok(metadata.scopes.includes('https://www.googleapis.com/auth/cloud-platform'));
  assert.match(metadata.successUrl, /gemini-code-assist\/auth_success_gemini/);
});

test('OAuth credentials use the same user-profile location as Gemini CLI', () => {
  assert.equal(
    geminiOAuthCredentialsPath({ env: {}, home: path.join('home', 'user') }),
    path.join('home', 'user', '.gemini', 'oauth_creds.json')
  );
  assert.equal(
    geminiOAuthCredentialsPath({ env: { GEMINI_CLI_HOME: path.join('custom', 'home') }, home: 'ignored' }),
    path.join('custom', 'home', '.gemini', 'oauth_creds.json')
  );
});

test('Windows browser launch is native and does not use a shell', () => {
  const launch = browserLaunchCommand('https://example.test/a?b=1&c=2', 'win32');
  assert.equal(launch.command, 'rundll32.exe');
  assert.deepEqual(launch.args, ['url.dll,FileProtocolHandler', 'https://example.test/a?b=1&c=2']);
});

test('authorization URL requests offline access and explicit account consent', () => {
  const url = new URL(buildGoogleAuthUrl({
    clientId: 'client-id',
    scopes: ['scope-one', 'scope-two'],
    authorizationUrl: 'https://accounts.example.test/auth'
  }, 'http://127.0.0.1:4321/oauth2callback', 'state-123'));

  assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:4321/oauth2callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('scope'), 'scope-one scope-two');
  assert.equal(url.searchParams.get('state'), 'state-123');
  assert.equal(url.searchParams.get('prompt'), 'consent select_account');
});

test('login owns the browser callback and writes Gemini-compatible credentials without provider TUI', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-google-login-'));
  const credentialsPath = path.join(root, '.gemini', 'oauth_creds.json');
  const notices = [];
  let tokenRequest = null;

  const metadata = {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    scopes: ['scope-one', 'scope-two'],
    authorizationUrl: 'https://accounts.example.test/auth',
    tokenUrl: 'https://tokens.example.test/token',
    successUrl: 'https://success.example.test/',
    failureUrl: 'https://failure.example.test/'
  };

  try {
    let officialProbeCount = 0;
    let verified = 0;
    await loginWithGoogle({
      metadataLoader: async () => metadata,
      credentialsPath,
      callbackPort: 0,
      timeoutMs: 2000,
      notify: (message) => notices.push(message),
      officialProbe: async () => {
        officialProbeCount += 1;
        return officialProbeCount > 1;
      },
      officialVerify: async () => { verified += 1; return true; },
      fetchImpl: async (url, options) => {
        tokenRequest = { url, options };
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              access_token: 'access-token',
              refresh_token: 'refresh-token',
              expires_in: 3600,
              scope: 'scope-one scope-two',
              token_type: 'Bearer'
            });
          }
        };
      },
      openBrowser: async (authUrl) => {
        const auth = new URL(authUrl);
        const callback = new URL(auth.searchParams.get('redirect_uri'));
        callback.searchParams.set('code', 'code-123');
        callback.searchParams.set('state', auth.searchParams.get('state'));
        const response = await fetch(callback, { redirect: 'manual' });
        assert.equal(response.status, 302);
      }
    });

    assert.deepEqual(notices, ['Complete sign-in in your browser.']);
    assert.equal(verified, 1);
    assert.equal(tokenRequest.url, metadata.tokenUrl);
    assert.equal(tokenRequest.options.body.get('code'), 'code-123');
    assert.equal(tokenRequest.options.body.get('client_id'), 'test-client');
    assert.equal(tokenRequest.options.body.get('client_secret'), 'test-secret');
    assert.match(tokenRequest.options.body.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);

    const credentials = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
    assert.equal(credentials.access_token, 'access-token');
    assert.equal(credentials.refresh_token, 'refresh-token');
    assert.equal(credentials.token_type, 'Bearer');
    assert.equal('expires_in' in credentials, false);
    assert.ok(credentials.expiry_date > Date.now());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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

test('login reuses a persistent official subscription session without browser or network', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-google-persistent-'));
  const credentialsPath = path.join(root, '.gemini', 'oauth_creds.json');
  await fs.mkdir(path.dirname(credentialsPath), { recursive: true });
  await fs.writeFile(credentialsPath, JSON.stringify({
    access_token: 'cached-access',
    refresh_token: 'cached-refresh',
    expiry_date: Date.now() + 60 * 60 * 1000,
    token_type: 'Bearer'
  }), 'utf8');

  try {
    let browserOpened = false;
    let networkUsed = false;
    await loginWithGoogle({
      credentialsPath,
      officialProbe: async () => true,
      metadataLoader: async () => { throw new Error('metadata should not be loaded for a fresh cached login'); },
      openBrowser: async () => { browserOpened = true; },
      fetchImpl: async () => { networkUsed = true; throw new Error('network should not be used'); }
    });
    assert.equal(browserOpened, false);
    assert.equal(networkUsed, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('expired persistent Google credential refreshes silently and preserves refresh token', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-google-refresh-'));
  const credentialsPath = path.join(root, '.gemini', 'oauth_creds.json');
  await fs.mkdir(path.dirname(credentialsPath), { recursive: true });
  await fs.writeFile(credentialsPath, JSON.stringify({
    access_token: 'expired-access',
    refresh_token: 'persistent-refresh',
    expiry_date: 1,
    token_type: 'Bearer',
    scope: 'scope-one'
  }), 'utf8');

  let request = null;
  const now = 1_800_000_000_000;
  try {
    const credentials = await ensureGoogleCredentials({
      credentialsPath,
      now,
      metadataLoader: async () => ({
        clientId: 'test-client',
        clientSecret: 'test-secret',
        tokenUrl: 'https://tokens.example.test/token'
      }),
      fetchImpl: async (url, options) => {
        request = { url, options };
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              access_token: 'refreshed-access',
              expires_in: 3600,
              token_type: 'Bearer'
            });
          }
        };
      }
    });

    assert.equal(request.url, 'https://tokens.example.test/token');
    assert.equal(request.options.body.get('grant_type'), 'refresh_token');
    assert.equal(request.options.body.get('refresh_token'), 'persistent-refresh');
    assert.equal(credentials.access_token, 'refreshed-access');
    assert.equal(credentials.refresh_token, 'persistent-refresh');
    assert.equal(credentials.expiry_date, now + 3600 * 1000);
    const stored = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
    assert.equal(stored.access_token, 'refreshed-access');
    assert.equal(stored.refresh_token, 'persistent-refresh');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('login times out instead of appearing permanently stuck', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-google-timeout-'));
  try {
    await assert.rejects(
      () => loginWithGoogle({
        officialProbe: async () => false,
        metadataLoader: async () => ({
          clientId: 'test-client',
          clientSecret: 'test-secret',
          scopes: ['scope'],
          authorizationUrl: 'https://accounts.example.test/auth',
          tokenUrl: 'https://tokens.example.test/token'
        }),
        credentialsPath: path.join(root, 'oauth_creds.json'),
        callbackPort: 0,
        timeoutMs: 30,
        openBrowser: async () => {},
        fetchImpl: async () => { throw new Error('unexpected token request'); }
      }),
      /timed out/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('bundled model discovery uses visible definitions from the installed Gemini CLI package', async () => {
  const models = await discoverBundledGoogleModels();
  assert.ok(models.length > 0);
  assert.ok(models.some((model) => /^gemini-3/.test(model)));
  assert.ok(models.includes('gemini-2.5-flash-lite'));
  assert.equal(models.includes('gemini-3.1-pro-preview-customtools'), false);
  assert.ok(models.every((model) => /^(?:gemini|gemma)-/.test(model)));
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

test('public model discovery reads newly documented models independently of the provider bundle', async () => {
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

test('Google model discovery merges public catalog models ahead of lagging provider models', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-model-discovery-'));
  const entryPath = path.join(root, 'gemini.js');
  const catalogPath = path.join(root, 'catalog.js');
  await fs.writeFile(entryPath, `import './catalog.js';\n`, 'utf8');
  await fs.writeFile(catalogPath, `
export const DEFAULT_MODEL_CONFIGS = {
  modelDefinitions: {
    'gemini-3.5-flash': { isVisible: true },
    'gemini-hidden-internal': { isVisible: false },
    'gemma-5-test': { isVisible: true },
    auto: { isVisible: true }
  }
};
`, 'utf8');

  try {
    const models = await discoverGoogleModels({
      entryPath,
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
    assert.deepEqual(models, ['gemini-3.8-flash', 'gemini-4-pro-preview', 'gemini-3.5-flash', 'gemma-5-test']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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
  assert.equal(calls[0].options.env.GOOGLE_GENAI_USE_GCA, undefined);
  assert.deepEqual(calls[1].args.slice(calls[1].args.indexOf('--conversation'), calls[1].args.indexOf('--conversation') + 2), ['--conversation', 'conversation-123']);
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

test('parseGeminiJson returns the official CLI response field', () => {
  assert.equal(parseGeminiJson('{"response":"done","stats":{}}'), 'done');
});

test('parseGeminiJson surfaces structured errors', () => {
  assert.throws(
    () => parseGeminiJson('{"error":{"message":"not signed in"}}'),
    /not signed in/
  );
});
