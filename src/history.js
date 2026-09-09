import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_MESSAGES = 200;
const MODEL_HISTORY_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 24_000;

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
  return `${text.slice(0, MAX_MESSAGE_CHARS)}\n[truncated]`;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string')
    .map((item) => ({
      role: item.role,
      text: trimText(item.text),
      attachments: Array.isArray(item.attachments) ? item.attachments.map((attachment) => ({
        name: String(attachment.name || ''),
        path: String(attachment.path || ''),
        mimeType: String(attachment.mimeType || ''),
        kind: String(attachment.kind || '')
      })) : [],
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

  async function load() {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      return normalizeMessages(parsed.messages);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      if (error instanceof SyntaxError) throw new Error(`Conversation history is invalid: ${file}`);
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
      version: 1,
      workspace: path.resolve(workspace),
      messages: normalized
    });
  }

  return {
    path: file,
    load,
    save,
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
  return normalizeMessages(messages).slice(-MODEL_HISTORY_MESSAGES);
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
