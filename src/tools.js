import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { isCancellation, throwIfAborted } from './cancel.js';
import { createCommandSandbox } from './command-sandbox.js';
import { subprocessEnvironment } from './environment.js';

const exec = promisify(execCallback);
const DEFAULT_IGNORES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.cache']);
const SENSITIVE_DIRECTORIES = new Set(['.ssh', '.aws', '.gnupg']);
const SENSITIVE_FILES = new Set([
  '.env', '.envrc', '.npmrc', '.pypirc', '.netrc', '.git-credentials',
  'credentials.json', 'service-account.json', 'id_rsa', 'id_ed25519'
]);
const SAFE_ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILE_OUTPUT = 120_000;
const MAX_COMMAND_OUTPUT = 80_000;

function clip(text, max = MAX_COMMAND_OUTPUT, suffix = null) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n${suffix || `...[truncated ${text.length - max} chars]`}`;
}

async function readLineRange(file, startLine, endLine) {
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const output = [];
  let number = 0;
  let chars = 0;
  let truncated = false;
  try {
    for await (const line of lines) {
      number += 1;
      if (number < startLine) continue;
      if (number > endLine) break;
      const rendered = `${number}: ${line}`;
      if (chars + rendered.length + 1 > MAX_FILE_OUTPUT) {
        const remaining = Math.max(0, MAX_FILE_OUTPUT - chars);
        if (remaining) output.push(rendered.slice(0, remaining));
        truncated = true;
        break;
      }
      output.push(rendered);
      chars += rendered.length + 1;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  const text = output.join('\n');
  return truncated ? `${text}\n...[file read truncated; request a narrower line range]` : text;
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isSensitiveProjectPath(relative) {
  const normalized = String(relative || '').replace(/\\/g, '/').toLowerCase();
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => SENSITIVE_DIRECTORIES.has(part))) return true;
  const base = parts.at(-1) || '';
  if (SAFE_ENV_TEMPLATES.has(base)) return false;
  if (SENSITIVE_FILES.has(base) || base.startsWith('.env.')) return true;
  return /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(base);
}

async function nearestExisting(target) {
  let current = target;
  while (true) {
    try {
      await fs.access(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

async function createResolver(workspace) {
  const root = path.resolve(workspace);
  const realRoot = await fs.realpath(root);

  return async (relative = '.') => {
    const resolved = path.resolve(root, relative);
    if (!inside(root, resolved)) {
      throw new Error(`Path is outside the project: ${relative}`);
    }

    const existing = await nearestExisting(resolved);
    const realExisting = await fs.realpath(existing);
    if (!inside(realRoot, realExisting)) {
      throw new Error(`Path escapes the project through a symlink: ${relative}`);
    }

    return resolved;
  };
}

async function fileExists(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function displayProcess(executable, argv) {
  return [executable, ...argv].map((part) => /\s|"/.test(part) ? JSON.stringify(part) : part).join(' ');
}

async function discoverValidationChecks(root) {
  const checks = [];
  const add = (command, reason) => {
    if (!checks.some((item) => item.command === command)) checks.push({ command, reason });
  };

  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};
    for (const name of ['check', 'verify', 'test', 'test:unit', 'test:integration', 'test:e2e', 'lint', 'lint:ci', 'typecheck', 'build', 'ci']) {
      if (scripts[name]) add(name === 'test' ? 'npm test' : `npm run ${name}`, `package.json script: ${name}`);
    }
  } catch {}

  if (await fileExists(path.join(root, 'pyproject.toml')) || await fileExists(path.join(root, 'pytest.ini'))) {
    add('python -m pytest', 'Python project');
  }
  if (await fileExists(path.join(root, 'Cargo.toml'))) add('cargo test', 'Cargo project');
  if (await fileExists(path.join(root, 'go.mod'))) add('go test ./...', 'Go module');
  if (await fileExists(path.join(root, 'pom.xml'))) add('mvn test', 'Maven project');
  if (await fileExists(path.join(root, 'gradlew'))) add('./gradlew test', 'Gradle wrapper');
  if (await fileExists(path.join(root, 'gradlew.bat'))) add('gradlew.bat test', 'Gradle wrapper');
  try {
    const makefile = await fs.readFile(path.join(root, 'Makefile'), 'utf8');
    for (const target of ['test', 'check', 'lint']) {
      if (new RegExp(`^${target}:`, 'm').test(makefile)) add(`make ${target}`, `Makefile target: ${target}`);
    }
  } catch {}

  return checks;
}

async function walkFiles(root, start, limit = 2000) {
  const output = [];
  Object.defineProperty(output, 'truncated', { value: false, writable: true, enumerable: false });
  const queue = [start];

  while (queue.length && output.length < limit) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (DEFAULT_IGNORES.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute) || '.';
      if (isSensitiveProjectPath(relative)) continue;
      output.push({ absolute, relative, entry });
      if (output.length >= limit) {
        output.truncated = true;
        break;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(absolute);
    }
  }

  return output;
}

export async function createTools({
  workspace,
  approveCommand = async () => false,
  environment = process.env,
  commandSandbox = null,
  commandSandboxFactory = createCommandSandbox
}) {
  const root = path.resolve(workspace);
  const resolveSafe = await createResolver(root);
  const childEnv = subprocessEnvironment(environment);
  const sandbox = commandSandbox || commandSandboxFactory({ workspace: root, environment: childEnv });
  const resolveAgentPath = async (relative = '.') => {
    const resolved = await resolveSafe(relative);
    const projectRelative = path.relative(root, resolved) || '.';
    if (isSensitiveProjectPath(projectRelative)) {
      throw new Error(`Refusing agent access to sensitive project path: ${relative}. Use an explicitly approved shell command if this access is intentional.`);
    }
    return resolved;
  };

  const handlers = {
    async project_overview() {
      const topLevel = (await fs.readdir(root, { withFileTypes: true }))
        .filter((entry) => !DEFAULT_IGNORES.has(entry.name) && !isSensitiveProjectPath(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 80)
        .map((entry) => `${entry.isDirectory() ? '[dir] ' : ''}${entry.name}`);
      const entries = await walkFiles(root, root, 5000);
      const files = entries.filter(({ entry }) => entry.isFile());
      const extensions = new Map();
      for (const { relative } of files) {
        const ext = path.extname(relative).toLowerCase() || '[none]';
        extensions.set(ext, (extensions.get(ext) || 0) + 1);
      }
      const commonTypes = [...extensions.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([ext, count]) => `${ext}:${count}`)
        .join(', ');

      const validationChecks = await discoverValidationChecks(root);
      let packageInfo = '';
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
        const scripts = Object.keys(pkg.scripts || {});
        packageInfo = `package: ${pkg.name || '(unnamed)'}${pkg.version ? `@${pkg.version}` : ''}\nscripts: ${scripts.length ? scripts.join(', ') : '(none)'}`;
      } catch {}

      let git = '(not a Git repository or Git unavailable)';
      try {
        const { stdout, stderr } = await exec('git status --short --branch', {
          cwd: root,
          timeout: 10_000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
          env: childEnv
        });
        git = [stdout, stderr].filter(Boolean).join('').trim() || '(clean Git repository)';
      } catch {}

      return clip([
        `root: ${root}`,
        `files scanned: ${files.length}${entries.truncated ? '+' : ''}`,
        `common file types: ${commonTypes || '(none)'}`,
        packageInfo,
        `git:\n${git}`,
        `recommended checks:\n${validationChecks.length ? validationChecks.map((item) => `- ${item.command}`).join('\n') : '(none discovered)'}`,
        `top level:\n${topLevel.join('\n') || '(empty)'}`
      ].filter(Boolean).join('\n\n'), 20_000);
    },

    async list_files(args) {
      const start = await resolveAgentPath(args.path || '.');
      const maxEntries = Math.min(Math.max(Number(args.max_entries) || 300, 1), 2000);
      const items = await walkFiles(root, start, maxEntries);
      const rendered = items.map(({ relative, entry }) => `${entry.isDirectory() ? '[dir] ' : ''}${relative}`).join('\n') || '(empty)';
      return items.truncated ? `${rendered}\n[listing truncated at ${maxEntries} entries; use a narrower path to continue]` : rendered;
    },

    async read_file(args) {
      const file = await resolveAgentPath(args.path);
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error('Path is not a file.');
      const hasRange = args.start_line !== undefined || args.end_line !== undefined;
      const requestedStart = Math.max(Number(args.start_line) || 1, 1);
      const requestedEnd = Math.max(Number(args.end_line) || Number.MAX_SAFE_INTEGER, requestedStart);
      if (stat.size > MAX_FILE_BYTES) {
        if (!hasRange) {
          throw new Error(`File is larger than ${MAX_FILE_BYTES} bytes. Use start_line/end_line to read a bounded range.`);
        }
        return readLineRange(file, requestedStart, requestedEnd);
      }

      const text = await fs.readFile(file, 'utf8');
      const lines = text.split(/\r?\n/);
      const start = requestedStart - 1;
      const end = Math.min(requestedEnd, lines.length);
      const rendered = lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join('\n');
      return clip(rendered, MAX_FILE_OUTPUT, '...[file read truncated; use start_line/end_line to request a narrower range]');
    },

    async discover_checks() {
      const checks = await discoverValidationChecks(root);
      return checks.length
        ? checks.map((item) => `${item.command} — ${item.reason}`).join('\n')
        : '(no standard validation commands discovered; inspect project instructions/manifests)';
    },

    async find_symbol(args) {
      const name = String(args.name || '').trim();
      if (!name) throw new Error('Symbol name cannot be empty.');
      const start = await resolveAgentPath(args.path || '.');
      const maxResults = Math.min(Math.max(Number(args.max_results) || 50, 1), 200);
      const escaped = escapeRegex(name);
      const patterns = [
        new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?(?:function|class|interface|type|enum|const|let|var|def|fn|struct|trait|record|module)\\s+${escaped}\\b`),
        new RegExp(`\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^\\n]*\\)\\s*=>)`)
      ];
      const entries = await walkFiles(root, start, 5000);
      const results = [];
      for (const { absolute, relative, entry } of entries) {
        if (!entry.isFile()) continue;
        let stat;
        try { stat = await fs.stat(absolute); } catch { continue; }
        if (stat.size > MAX_FILE_BYTES) continue;
        let text;
        try { text = await fs.readFile(absolute, 'utf8'); } catch { continue; }
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (patterns.some((pattern) => pattern.test(lines[index]))) {
            results.push(`${relative}:${index + 1}: ${lines[index]}`);
            if (results.length >= maxResults) return `${results.join('\n')}\n[results truncated at ${maxResults}; narrow the search or increase max_results]`;
          }
        }
      }
      const rendered = results.join('\n') || '(no symbol definitions found in scanned entries)';
      return entries.truncated ? `${rendered}\n[scan truncated at 5000 entries; use a narrower path to continue]` : rendered;
    },

    async find_references(args) {
      const name = String(args.name || '').trim();
      if (!name) throw new Error('Reference name cannot be empty.');
      const start = await resolveAgentPath(args.path || '.');
      const maxResults = Math.min(Math.max(Number(args.max_results) || 100, 1), 500);
      const matcher = new RegExp(`\\b${escapeRegex(name)}\\b`);
      const entries = await walkFiles(root, start, 5000);
      const results = [];
      for (const { absolute, relative, entry } of entries) {
        if (!entry.isFile()) continue;
        let stat;
        try { stat = await fs.stat(absolute); } catch { continue; }
        if (stat.size > MAX_FILE_BYTES) continue;
        let text;
        try { text = await fs.readFile(absolute, 'utf8'); } catch { continue; }
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (matcher.test(lines[index])) {
            results.push(`${relative}:${index + 1}: ${lines[index]}`);
            if (results.length >= maxResults) return `${results.join('\n')}\n[results truncated at ${maxResults}; narrow the search or increase max_results]`;
          }
        }
      }
      const rendered = results.join('\n') || '(no references found in scanned entries)';
      return entries.truncated ? `${rendered}\n[scan truncated at 5000 entries; use a narrower path to continue]` : rendered;
    },

    async write_file(args) {
      const file = await resolveAgentPath(args.path);
      let existed = true;
      try {
        await fs.access(file);
      } catch (error) {
        if (error?.code === 'ENOENT') existed = false;
        else throw error;
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, String(args.content ?? ''), 'utf8');
      return `${existed ? 'Updated' : 'Created'} ${path.relative(root, file)}.`;
    },

    async replace_in_file(args) {
      const file = await resolveAgentPath(args.path);
      const oldText = String(args.old_text ?? '');
      if (!oldText) throw new Error('old_text cannot be empty.');
      const newText = String(args.new_text ?? '');
      const occurrence = Math.max(Number(args.occurrence) || 1, 1);
      const text = await fs.readFile(file, 'utf8');

      let from = 0;
      let index = -1;
      for (let count = 0; count < occurrence; count += 1) {
        index = text.indexOf(oldText, from);
        if (index < 0) throw new Error(`Could not find occurrence ${occurrence} of old_text.`);
        from = index + oldText.length;
      }

      const updated = text.slice(0, index) + newText + text.slice(index + oldText.length);
      await fs.writeFile(file, updated, 'utf8');
      return `Updated ${path.relative(root, file)}.`;
    },

    async apply_patch(args) {
      const changes = Array.isArray(args.changes) ? args.changes : [];
      if (!changes.length) throw new Error('changes must contain at least one patch hunk.');
      if (changes.length > 50) throw new Error('A patch may contain at most 50 hunks.');

      const originals = new Map();
      const updated = new Map();
      for (const change of changes) {
        const file = await resolveAgentPath(change.path);
        const oldText = String(change.old_text ?? '');
        if (!oldText) throw new Error('Patch old_text cannot be empty. Use write_file for new files.');
        const newText = String(change.new_text ?? '');
        const occurrence = Math.max(Number(change.occurrence) || 1, 1);
        let text = updated.get(file);
        if (text === undefined) {
          text = await fs.readFile(file, 'utf8');
          originals.set(file, text);
        }
        let from = 0;
        let index = -1;
        for (let count = 0; count < occurrence; count += 1) {
          index = text.indexOf(oldText, from);
          if (index < 0) throw new Error(`Could not find occurrence ${occurrence} of patch old_text in ${path.relative(root, file)}.`);
          from = index + oldText.length;
        }
        updated.set(file, text.slice(0, index) + newText + text.slice(index + oldText.length));
      }

      try {
        for (const [file, text] of updated) await fs.writeFile(file, text, 'utf8');
      } catch (error) {
        for (const [file, text] of originals) {
          try { await fs.writeFile(file, text, 'utf8'); } catch {}
        }
        throw error;
      }
      return `Applied ${changes.length} patch hunk${changes.length === 1 ? '' : 's'} across ${updated.size} file${updated.size === 1 ? '' : 's'}.`;
    },

    async delete_path(args) {
      const target = await resolveAgentPath(args.path);
      if (target === root) throw new Error('Refusing to delete the project root.');
      await fs.rm(target, { recursive: true, force: true });
      return `Deleted ${path.relative(root, target)}.`;
    },

    async search_files(args) {
      const start = await resolveAgentPath(args.path || '.');
      const maxResults = Math.min(Math.max(Number(args.max_results) || 100, 1), 500);
      const entries = await walkFiles(root, start, 5000);
      let matcher;

      if (args.regex) {
        try {
          matcher = new RegExp(String(args.query), 'i');
        } catch (error) {
          throw new Error(`Invalid regular expression: ${error.message}`, { cause: error });
        }
      }

      const query = String(args.query).toLowerCase();
      const results = [];
      for (const { absolute, relative, entry } of entries) {
        if (!entry.isFile()) continue;
        let stat;
        try {
          stat = await fs.stat(absolute);
        } catch {
          continue;
        }
        if (stat.size > MAX_FILE_BYTES) continue;

        let text;
        try {
          text = await fs.readFile(absolute, 'utf8');
        } catch {
          continue;
        }

        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          const matches = matcher ? matcher.test(line) : line.toLowerCase().includes(query);
          if (matcher) matcher.lastIndex = 0;
          if (matches) {
            results.push(`${relative}:${index + 1}: ${line}`);
            if (results.length >= maxResults) return `${results.join('\n')}\n[results truncated at ${maxResults}; narrow the search or increase max_results]`;
          }
        }
      }

      const rendered = results.join('\n') || '(no matches in scanned entries)';
      return entries.truncated ? `${rendered}\n[scan truncated at 5000 entries; use a narrower path to continue]` : rendered;
    },

    async run_process(args, context = {}) {
      throwIfAborted(context.signal);
      const executable = String(args.executable || '').trim();
      if (!executable) throw new Error('Executable cannot be empty.');
      if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
        throw new Error('run_process accepts native executables on Windows. Use run_command for .cmd/.bat scripts or invoke cmd.exe explicitly.');
      }
      const argv = Array.isArray(args.args) ? args.args.map((item) => String(item)) : [];
      if (argv.length > 100) throw new Error('run_process accepts at most 100 arguments.');
      const cwd = await resolveSafe(args.cwd || '.');
      const shown = displayProcess(executable, argv);
      const approved = await approveCommand(shown, path.relative(root, cwd) || '.');
      if (!approved) return 'Command denied by user.';
      const timeout = Math.min(Math.max(Number(args.timeout_ms) || 120000, 1000), 900000);
      try {
        const { stdout, stderr } = await sandbox.runProcess({
          executable,
          args: argv,
          cwd,
          signal: context.signal,
          timeoutMs: timeout,
          display: shown
        });
        const output = [stdout, stderr].filter(Boolean).join('');
        return clip(output || '(process completed with no output)');
      } catch (error) {
        if (isCancellation(error) || context.signal?.aborted) throw error;
        const stdout = error.stdout ? String(error.stdout) : '';
        const stderr = error.stderr ? String(error.stderr) : '';
        const details = [stdout, stderr, error.message].filter(Boolean).join('\n');
        return `Command failed.\n${clip(details)}`;
      }
    },

    async run_command(args, context = {}) {
      throwIfAborted(context.signal);
      const command = String(args.command || '').trim();
      if (!command) throw new Error('Command cannot be empty.');
      const cwd = await resolveSafe(args.cwd || '.');
      const approved = await approveCommand(command, path.relative(root, cwd) || '.');
      if (!approved) return 'Command denied by user.';

      const timeout = Math.min(Math.max(Number(args.timeout_ms) || 120000, 1000), 900000);
      try {
        const { stdout, stderr } = await sandbox.runCommand({
          command,
          cwd,
          signal: context.signal,
          timeoutMs: timeout,
          display: command
        });
        const output = [stdout, stderr].filter(Boolean).join('');
        return clip(output || '(command completed with no output)');
      } catch (error) {
        if (isCancellation(error) || context.signal?.aborted) throw error;
        const stdout = error.stdout ? String(error.stdout) : '';
        const stderr = error.stderr ? String(error.stderr) : '';
        const details = [stdout, stderr, error.message].filter(Boolean).join('\n');
        return `Command failed.\n${clip(details)}`;
      }
    },

    async git_diff(args) {
      const command = args.staged ? 'git diff --staged' : 'git diff';
      try {
        const { stdout, stderr } = await exec(command, {
          cwd: root,
          timeout: 30000,
          windowsHide: true,
          maxBuffer: 2 * 1024 * 1024,
          env: childEnv
        });
        return clip([stdout, stderr].filter(Boolean).join('') || '(no diff)');
      } catch (error) {
        return `git diff failed: ${error.message}`;
      }
    }
  };

  return {
    async execute(name, args, context = {}) {
      throwIfAborted(context.signal);
      const handler = handlers[name];
      if (!handler) throw new Error(`Unknown tool: ${name}`);
      return handler(args || {}, context);
    }
  };
}
