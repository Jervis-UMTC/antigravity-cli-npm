import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureOfficialAntigravityCli } from '../src/google-agent.js';
import { configureWindowsPath } from './setup-path.js';

function enabled(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || '').trim());
}

function write(stream, text) {
  if (stream && typeof stream.write === 'function') stream.write(text);
}

export async function provisionInstall({
  platform = process.platform,
  env = process.env,
  configurePath = configureWindowsPath,
  ensureBackend = ensureOfficialAntigravityCli,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  let pathResult = { ok: true, changed: false, skipped: true };
  try {
    pathResult = configurePath({ platform, env });
    if (pathResult?.ok && pathResult.changed) {
      write(stdout, `antigyc: added ${pathResult.target} to your user PATH. Open a new terminal once.\n`);
    } else if (pathResult && !pathResult.ok) {
      write(stderr, `antigyc: could not update your user PATH automatically: ${pathResult.error?.message || 'unknown error'}\n`);
    }
  } catch (error) {
    pathResult = { ok: false, changed: false, error };
    write(stderr, `antigyc: could not update your user PATH automatically: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  if (enabled(env.AGYC_SKIP_PROVIDER_INSTALL)) {
    return { path: pathResult, backend: 'skipped', binary: null };
  }

  try {
    const binary = await ensureBackend({ platform, env });
    return { path: pathResult, backend: 'ready', binary };
  } catch (error) {
    // Keep npm installation usable for API-key/offline cases. Google mode will
    // retry the same official backend bootstrap automatically on first use.
    write(stderr, 'antigyc: Google backend preinstall was deferred; the first Google request will retry automatically.\n');
    return { path: pathResult, backend: 'deferred', binary: null, error };
  }
}

export async function main() {
  await provisionInstall();
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(`antigyc: install bootstrap could not complete: ${error instanceof Error ? error.message : String(error)}\n`);
  });
}
