import fs from 'node:fs/promises';
import path from 'node:path';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { isCancellation, throwIfAborted } from './cancel.js';

const exec = promisify(execCallback);
const DEFAULT_IGNORES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.cache']);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_COMMAND_OUTPUT = 80_000;

function clip(text, max = MAX_COMMAND_OUTPUT) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
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

async function walkFiles(root, start, limit = 2000) {
  const output = [];
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
      output.push({ absolute, relative, entry });
      if (output.length >= limit) break;
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(absolute);
    }
  }

  return output;
}

export async function createTools({ workspace, approveCommand = async () => false }) {
  const root = path.resolve(workspace);
  const resolveSafe = await createResolver(root);

  const handlers = {
    async list_files(args) {
      const start = await resolveSafe(args.path || '.');
      const maxEntries = Math.min(Math.max(Number(args.max_entries) || 300, 1), 2000);
      const items = await walkFiles(root, start, maxEntries);
      return items.map(({ relative, entry }) => `${entry.isDirectory() ? '[dir] ' : ''}${relative}`).join('\n') || '(empty)';
    },

    async read_file(args) {
      const file = await resolveSafe(args.path);
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error('Path is not a file.');
      if (stat.size > MAX_FILE_BYTES) throw new Error(`File is larger than ${MAX_FILE_BYTES} bytes.`);

      const text = await fs.readFile(file, 'utf8');
      const lines = text.split(/\r?\n/);
      const start = Math.max((Number(args.start_line) || 1) - 1, 0);
      const end = Math.min(Number(args.end_line) || lines.length, lines.length);
      return lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join('\n');
    },

    async write_file(args) {
      const file = await resolveSafe(args.path);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, String(args.content ?? ''), 'utf8');
      return `Wrote ${path.relative(root, file)}.`;
    },

    async replace_in_file(args) {
      const file = await resolveSafe(args.path);
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

    async delete_path(args) {
      const target = await resolveSafe(args.path);
      if (target === root) throw new Error('Refusing to delete the project root.');
      await fs.rm(target, { recursive: true, force: true });
      return `Deleted ${path.relative(root, target)}.`;
    },

    async search_files(args) {
      const start = await resolveSafe(args.path || '.');
      const maxResults = Math.min(Math.max(Number(args.max_results) || 100, 1), 500);
      const entries = await walkFiles(root, start, 5000);
      let matcher;

      if (args.regex) {
        try {
          matcher = new RegExp(String(args.query), 'i');
        } catch (error) {
          throw new Error(`Invalid regular expression: ${error.message}`);
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
            if (results.length >= maxResults) return results.join('\n');
          }
        }
      }

      return results.join('\n') || '(no matches)';
    },

    async run_command(args, context = {}) {
      throwIfAborted(context.signal);
      const command = String(args.command || '').trim();
      if (!command) throw new Error('Command cannot be empty.');
      const cwd = await resolveSafe(args.cwd || '.');
      const approved = await approveCommand(command, path.relative(root, cwd) || '.');
      if (!approved) return 'Command denied by user.';

      const timeout = Math.min(Math.max(Number(args.timeout_ms) || 120000, 1000), 600000);
      try {
        const { stdout, stderr } = await exec(command, {
          cwd,
          timeout,
          windowsHide: true,
          maxBuffer: 2 * 1024 * 1024,
          env: process.env,
          signal: context.signal
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
          env: process.env
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
