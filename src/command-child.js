import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SANDBOX_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO',
  'CARGO_HTTP_CAINFO', 'REQUESTS_CA_BUNDLE', 'JAVA_TOOL_OPTIONS'
];

function decodePayloadPath(token) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(token || ''))) throw new Error('invalid payload token');
  return Buffer.from(token, 'base64url').toString('utf8');
}

function buildChildEnvironment(payload) {
  const env = { ...(payload.env || {}) };
  for (const key of SANDBOX_ENV_KEYS) {
    if (process.env[key] === undefined) delete env[key];
    else env[key] = process.env[key];
  }

  const home = path.join(payload.scratch, 'home');
  const temp = path.join(payload.scratch, 'tmp');
  env.HOME = home;
  env.USERPROFILE = home;
  env.TMP = temp;
  env.TEMP = temp;
  env.TMPDIR = temp;
  env.APPDATA = path.join(home, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  env.XDG_CACHE_HOME = path.join(home, '.cache');
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  env.NPM_CONFIG_CACHE = path.join(home, '.npm');
  env.npm_config_cache = env.NPM_CONFIG_CACHE;
  return env;
}

async function main() {
  if (process.argv[2] !== '--payload-path-b64') throw new Error('missing sandbox payload');
  const payloadFile = decodePayloadPath(process.argv[3]);
  const payload = JSON.parse(await fs.readFile(payloadFile, 'utf8'));
  if (!payload || !['command', 'process'].includes(payload.mode)) throw new Error('invalid sandbox payload');
  if (typeof payload.cwd !== 'string' || typeof payload.scratch !== 'string') throw new Error('invalid sandbox paths');

  const env = buildChildEnvironment(payload);
  await Promise.all([
    fs.mkdir(env.HOME, { recursive: true }),
    fs.mkdir(env.TMP, { recursive: true }),
    fs.mkdir(env.APPDATA, { recursive: true }),
    fs.mkdir(env.LOCALAPPDATA, { recursive: true }),
    fs.mkdir(env.XDG_CACHE_HOME, { recursive: true }),
    fs.mkdir(env.XDG_CONFIG_HOME, { recursive: true }),
    fs.mkdir(env.XDG_DATA_HOME, { recursive: true })
  ]);

  const child = payload.mode === 'process'
    ? spawn(String(payload.executable || ''), Array.isArray(payload.args) ? payload.args.map(String) : [], {
        cwd: payload.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: 'inherit'
      })
    : spawn(String(payload.command || ''), {
        cwd: payload.cwd,
        env,
        shell: true,
        windowsHide: true,
        stdio: 'inherit'
      });

  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Sandboxed command ended by signal ${signal}.`));
        return;
      }
      process.exitCode = Number.isInteger(code) ? code : 1;
      resolve();
    });
  });
}

main().catch((error) => {
  process.stderr.write(`Sandbox command launcher failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
