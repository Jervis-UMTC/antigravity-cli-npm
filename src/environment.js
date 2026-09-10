const PASSTHROUGH_ENV = 'AGYC_PASSTHROUGH_ENV';

const SENSITIVE_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|COOKIE|CONNECTION_STRING)/i;
const SENSITIVE_EXACT = new Set([
  'DATABASE_URL',
  'MONGODB_URI',
  'REDIS_URL',
  'MYSQL_PWD',
  'PGPASSWORD',
  'PGPASSFILE',
  'DOCKER_AUTH_CONFIG'
]);

function requestedPassthrough(source) {
  return new Set(
    String(source?.[PASSTHROUGH_ENV] || '')
      .split(/[\s,;]+/)
      .map((name) => name.trim())
      .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      .map((name) => name.toUpperCase())
  );
}

export function isSensitiveEnvironmentName(name) {
  const key = String(name || '').trim().toUpperCase();
  return Boolean(key && (SENSITIVE_EXACT.has(key) || SENSITIVE_NAME.test(key)));
}

export function subprocessEnvironment(source = process.env, { allow = [] } = {}) {
  const permitted = requestedPassthrough(source);
  for (const name of allow) {
    const key = String(name || '').trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) permitted.add(key.toUpperCase());
  }

  const env = {};
  for (const [name, value] of Object.entries(source || {})) {
    if (value == null || name === PASSTHROUGH_ENV) continue;
    if (isSensitiveEnvironmentName(name) && !permitted.has(name.toUpperCase())) continue;
    env[name] = String(value);
  }
  return env;
}

export const subprocessEnvironmentPassthroughVariable = PASSTHROUGH_ENV;
