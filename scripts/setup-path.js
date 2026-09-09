import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function envValue(env, name) {
  const key = Object.keys(env).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function expandWindowsEnv(value, env) {
  return String(value || '').replace(/%([^%]+)%/g, (match, name) => {
    const replacement = envValue(env, name);
    return replacement === undefined ? match : replacement;
  });
}

function normalizeWindowsPath(value, env = process.env) {
  const expanded = expandWindowsEnv(String(value || '').trim().replace(/^"|"$/g, ''), env);
  return expanded.replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase();
}

export function windowsNpmBinPath(env = process.env) {
  const configuredPrefix = String(envValue(env, 'npm_config_prefix') || '').trim();
  if (configuredPrefix && path.win32.isAbsolute(configuredPrefix)) {
    return path.win32.normalize(configuredPrefix);
  }

  const appData = String(envValue(env, 'APPDATA') || '').trim();
  return appData ? path.win32.join(appData, 'npm') : null;
}

export function windowsPathContains(pathValue, target, env = process.env) {
  const expected = normalizeWindowsPath(target, env);
  if (!expected) return false;
  return String(pathValue || '')
    .split(';')
    .map((entry) => normalizeWindowsPath(entry, env))
    .filter(Boolean)
    .includes(expected);
}

export function shouldConfigureWindowsPath({
  platform = process.platform,
  env = process.env,
  packageRoot = PACKAGE_ROOT
} = {}) {
  if (/^(?:1|true|yes|on)$/i.test(String(envValue(env, 'AGYC_SKIP_PATH_SETUP') || '').trim())) return false;
  if (platform !== 'win32') return false;
  if (String(envValue(env, 'npm_config_global') || '').toLowerCase() === 'true') return true;

  const initCwd = String(envValue(env, 'INIT_CWD') || '').trim();
  if (!initCwd) return false;
  return normalizeWindowsPath(path.win32.resolve(initCwd), env) ===
    normalizeWindowsPath(path.win32.resolve(packageRoot), env);
}

export function persistWindowsUserPath(target, {
  env = process.env,
  spawnImpl = spawnSync
} = {}) {
  const script = [
    '$target=$env:AGYC_NPM_BIN',
    "$current=[Environment]::GetEnvironmentVariable('Path','User')",
    "if($null -eq $current){$current=''}",
    "$parts=@($current -split ';' | ForEach-Object {$_.Trim()} | Where-Object {$_})",
    "$targetNorm=[Environment]::ExpandEnvironmentVariables($target).Trim().TrimEnd('\\').ToLowerInvariant()",
    '$exists=$false',
    "foreach($part in $parts){$expanded=[Environment]::ExpandEnvironmentVariables($part).Trim().TrimEnd('\\').ToLowerInvariant();if($expanded -eq $targetNorm){$exists=$true;break}}",
    "if($exists){Write-Output 'unchanged';exit 0}",
    "$new=if($parts.Count -gt 0){($parts + $target)-join ';'}else{$target}",
    "[Environment]::SetEnvironmentVariable('Path',$new,'User')",
    "Write-Output 'changed'"
  ].join(';');

  const result = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...env, AGYC_NPM_BIN: target },
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      changed: false,
      error: result.error || new Error(String(result.stderr || 'Unable to update user PATH.').trim())
    };
  }

  return { ok: true, changed: String(result.stdout || '').trim() === 'changed' };
}

export function configureWindowsPath({
  platform = process.platform,
  env = process.env,
  packageRoot = PACKAGE_ROOT,
  persistImpl = persistWindowsUserPath
} = {}) {
  if (!shouldConfigureWindowsPath({ platform, env, packageRoot })) {
    return { ok: true, changed: false, skipped: true };
  }

  const target = windowsNpmBinPath(env);
  if (!target) return { ok: false, changed: false, error: new Error('Could not determine the npm command directory.') };

  // The current shell may contain a temporary `set PATH=...` entry. Always
  // consult/persist the Windows user PATH so future terminals inherit it.
  return { ...persistImpl(target, { env }), target };
}

export function main() {
  const result = configureWindowsPath();
  if (result.ok && result.changed) {
    process.stdout.write(`antigyc: added ${result.target} to your user PATH. Open a new terminal once.\n`);
  } else if (!result.ok) {
    process.stderr.write(`antigyc: could not update your user PATH automatically: ${result.error?.message || 'unknown error'}\n`);
  }
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) main();
