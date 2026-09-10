import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_MESSAGES = 200;
const MODEL_HISTORY_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 24_000;
const MODEL_HISTORY_CHARS = 60_000;
const MAX_MODEL_HISTORY_BYTES = 64 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 20;
const HISTORY_VERSION = 1;

function canonicalWorkspace(workspace) {
  const resolved = path.resolve(workspace);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function projectKey(workspace) {
  return crypto.createHash('sha256').update(canonicalWorkspace(workspace)).digest('hex').slice(0, 32);
}

function trimText(value) {
  const text = String(value || '');
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  const tailChars = Math.floor(MAX_MESSAGE_CHARS / 3);
  const headChars = MAX_MESSAGE_CHARS - tailChars;
  return `${text.slice(0, headChars)}\n[truncated ${text.length - MAX_MESSAGE_CHARS} chars]\n${text.slice(-tailChars)}`;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string')
    .map((item) => ({
      role: item.role,
      text: trimText(item.text),
      attachments: Array.isArray(item.attachments) ? item.attachments.map((attachment) => ({
        name: String(attachment.name || '').slice(0, 256),
        mimeType: String(attachment.mimeType || '').slice(0, 128),
        kind: String(attachment.kind || '').slice(0, 32)
      })).slice(0, MAX_ATTACHMENTS_PER_MESSAGE) : [],
      at: typeof item.at === 'string' ? item.at : new Date().toISOString()
    }))
    .slice(-MAX_MESSAGES);
}

async function writeJsonAtomic(file, body) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
}

export async function createHistoryStore(workspace, { baseDir } = {}) {
  const root = path.resolve(baseDir || process.env.ANTIGRAVITY_HOME || path.join(os.homedir(), '.antigravity-cli'));
  const file = path.join(root, 'history', `${projectKey(workspace)}.json`);
  let recoveryNotice = null;

  async function load() {
    recoveryNotice = null;
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.version !== undefined && parsed.version !== HISTORY_VERSION) {
        throw new Error(`Unsupported conversation history version ${String(parsed.version)}: ${file}`);
      }
      return normalizeMessages(parsed.messages);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      if (error instanceof SyntaxError) {
        const backup = `${file}.invalid-${Date.now()}-${crypto.randomUUID()}`;
        try {
          await fs.rename(file, backup);
        } catch (backupError) {
          throw new Error(`Conversation history is invalid and could not be quarantined: ${file}: ${backupError instanceof Error ? backupError.message : String(backupError)}`, { cause: backupError });
        }
        recoveryNotice = `Conversation history was invalid and was moved to ${backup}. Continuing with a fresh history.`;
        return [];
      }
      throw error;
    }
  }

  async function save(messages) {
    const normalized = normalizeMessages(messages);
    if (normalized.length === 0) {
      await fs.rm(file, { force: true });
      return;
    }
    await writeJsonAtomic(file, {
      version: HISTORY_VERSION,
      workspace: path.resolve(workspace),
      messages: normalized
    });
  }

  return {
    path: file,
    load,
    save,
    takeRecoveryNotice() {
      const notice = recoveryNotice;
      recoveryNotice = null;
      return notice;
    },
    async clear() {
      await fs.rm(file, { force: true });
    }
  };
}

export function appendConversationTurn(messages, text, attachments, answer) {
  return normalizeMessages([
    ...messages,
    {
      role: 'user',
      text,
      attachments: attachments || [],
      at: new Date().toISOString()
    },
    {
      role: 'assistant',
      text: answer,
      attachments: [],
      at: new Date().toISOString()
    }
  ]);
}

export function conversationForModel(messages) {
  const recent = normalizeMessages(messages).slice(-MODEL_HISTORY_MESSAGES);
  const selected = [];
  let chars = 0;
  let bytes = 0;

  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index];
    const attachmentChars = message.attachments.reduce((total, attachment) => (
      total + attachment.name.length + attachment.mimeType.length + attachment.kind.length + 16
    ), 0);
    const cost = message.text.length + attachmentChars + 32;
    const messageBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    if (selected.length && (chars + cost > MODEL_HISTORY_CHARS || bytes + messageBytes > MAX_MODEL_HISTORY_BYTES)) break;
    selected.unshift(message);
    chars += cost;
    bytes += messageBytes;
  }

  while (selected.length && selected[0].role === 'assistant') selected.shift();
  return selected;
}

export function conversationAsText(messages) {
  const recent = conversationForModel(messages);
  return recent.map((message) => {
    const attachmentNames = message.attachments.length
      ? ` [attachments: ${message.attachments.map((attachment) => attachment.name).join(', ')}]`
      : '';
    return `${message.role === 'user' ? 'USER' : 'REPLY'}${attachmentNames}: ${message.text}`;
  }).join('\n\n');
}

export function renderConversation(messages) {
  const normalized = normalizeMessages(messages);
  if (normalized.length === 0) return '(empty)';
  return normalized.map((message) => {
    const attachments = message.attachments.length
      ? ` [${message.attachments.map((attachment) => attachment.name).join(', ')}]`
      : '';
    return `${message.role === 'user' ? '>' : '<'}${attachments} ${message.text}`;
  }).join('\n\n');
}
