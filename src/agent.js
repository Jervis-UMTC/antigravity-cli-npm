import { directAttachmentParts } from './attachments.js';
import { conversationForModel } from './history.js';
import { isCancellation, throwIfAborted } from './cancel.js';

const DEFAULT_MODEL = 'gemini-2.5-pro';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_STEPS = 20;
const REASONING_BUDGETS = { low: 1024, high: 8192 };

const functionDeclarations = [
  {
    name: 'list_files',
    description: 'List files and directories in the current project. Generated and dependency directories are skipped by default.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Project-relative directory. Defaults to the project root.' },
        max_entries: { type: 'NUMBER', description: 'Maximum number of entries to return. Defaults to 300.' }
      }
    }
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the current project.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Project-relative file path.' },
        start_line: { type: 'NUMBER', description: 'Optional one-based start line.' },
        end_line: { type: 'NUMBER', description: 'Optional one-based inclusive end line.' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Create or fully replace a UTF-8 text file inside the current project.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Project-relative file path.' },
        content: { type: 'STRING', description: 'Complete file content.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'replace_in_file',
    description: 'Replace one exact text occurrence in a project file. Prefer this for focused edits.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Project-relative file path.' },
        old_text: { type: 'STRING', description: 'Exact text to replace.' },
        new_text: { type: 'STRING', description: 'Replacement text.' },
        occurrence: { type: 'NUMBER', description: 'One-based occurrence when the text appears multiple times. Defaults to 1.' }
      },
      required: ['path', 'old_text', 'new_text']
    }
  },
  {
    name: 'delete_path',
    description: 'Delete a file or directory inside the current project.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Project-relative path to delete.' }
      },
      required: ['path']
    }
  },
  {
    name: 'search_files',
    description: 'Search text files in the current project for a string or regular expression.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Text or JavaScript regular expression pattern.' },
        path: { type: 'STRING', description: 'Optional project-relative directory to search.' },
        regex: { type: 'BOOLEAN', description: 'Interpret query as a case-insensitive regular expression.' },
        max_results: { type: 'NUMBER', description: 'Maximum matches to return. Defaults to 100.' }
      },
      required: ['query']
    }
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the current project. Interactive mode asks the user before execution unless --yes is active.',
    parameters: {
      type: 'OBJECT',
      properties: {
        command: { type: 'STRING', description: 'Shell command to run.' },
        cwd: { type: 'STRING', description: 'Optional project-relative working directory.' },
        timeout_ms: { type: 'NUMBER', description: 'Timeout in milliseconds. Defaults to 120000.' }
      },
      required: ['command']
    }
  },
  {
    name: 'git_diff',
    description: 'Show the current git diff for the project.',
    parameters: {
      type: 'OBJECT',
      properties: {
        staged: { type: 'BOOLEAN', description: 'Show staged changes instead of unstaged changes.' }
      }
    }
  }
];

function systemPrompt(workspace) {
  return `You are a coding agent operating in this project:\n${workspace}\n\nUse the provided tools to inspect, edit, test, and debug the project. Work only inside the project unless the user explicitly asks for a shell command that does otherwise and the command is approved. Inspect relevant files before editing. Prefer focused edits over rewriting whole files. Run appropriate checks after meaningful changes. Never claim a command passed unless you ran it and saw the result. Keep terminal responses concise and practical. Do not expose internal reasoning or tool-by-tool activity. When the task is complete, summarize the result and validation performed.`;
}

function normalizeBaseUrl(value) {
  return (value || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function modelVersion(model) {
  const match = String(model || '').match(/^gemini-(\d+)(?:\.(\d+))?-/i);
  return match ? [Number(match[1]), Number(match[2] || 0)] : [0, 0];
}

function newestAliasModel(models, suffix) {
  return [...models]
    .filter((model) => new RegExp(`^gemini-\\d+(?:\\.\\d+)?-${suffix}(?:-preview)?$`, 'i').test(model))
    .sort((left, right) => {
      const [leftMajor, leftMinor] = modelVersion(left);
      const [rightMajor, rightMinor] = modelVersion(right);
      return rightMajor - leftMajor || rightMinor - leftMinor || Number(/-preview$/i.test(left)) - Number(/-preview$/i.test(right));
    })[0] || null;
}

export async function resolveApiModel(model, {
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  modelsLoader = discoverApiModels,
  fetchImpl = globalThis.fetch
} = {}) {
  const requested = String(model || DEFAULT_MODEL).trim().toLowerCase();
  if (!['auto', 'pro', 'flash', 'flash-lite'].includes(requested)) return requested;
  const models = await modelsLoader({ apiKey, baseUrl, fetchImpl });
  const alias = requested === 'auto' ? 'pro' : requested;
  const resolved = newestAliasModel(models, alias);
  if (!resolved) throw new Error(`The ${requested} model is not currently available for this Gemini API key.`);
  return resolved;
}

export async function discoverApiModels({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY for model discovery.');
  if (typeof fetchImpl !== 'function') throw new Error('Model discovery requires fetch support.');

  const url = `${normalizeBaseUrl(baseUrl)}/models?key=${encodeURIComponent(apiKey)}`;
  const response = await fetchImpl(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.error?.message || `${response.status} ${response.statusText}`;
    throw new Error(`Model discovery failed: ${detail}`);
  }

  const models = Array.isArray(body.models) ? body.models : [];
  const ids = models
    .filter((model) => !Array.isArray(model.supportedGenerationMethods) || model.supportedGenerationMethods.includes('generateContent'))
    .map((model) => String(model.name || '').replace(/^models\//, ''))
    .filter((model) => /^gemini-/i.test(model));
  return [...new Set(ids)];
}

function normalizeReasoning(value) {
  const level = String(value || 'auto').trim().toLowerCase();
  if (!['auto', 'low', 'high'].includes(level)) {
    throw new Error('Reasoning must be auto, low, or high.');
  }
  return level;
}

export function reasoningConfig(level) {
  const normalized = normalizeReasoning(level);
  if (normalized === 'auto') return null;
  return { thinkingBudget: REASONING_BUDGETS[normalized] };
}

function getText(parts = []) {
  return parts
    .filter((part) => typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();
}

function historyToContents(messages) {
  return conversationForModel(messages).map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{
      text: message.attachments?.length
        ? `${message.text}\n\nAttachments in that turn: ${message.attachments.map((attachment) => attachment.name).join(', ')}`
        : message.text
    }]
  }));
}

export class CodingAgent {
  constructor({ workspace, displayWorkspace, tools, apiKey, model, baseUrl, reasoning = 'auto', history = [], fetchImpl = globalThis.fetch }) {
    if (!apiKey) {
      throw new Error('Missing GEMINI_API_KEY. Set it in your environment before starting agyc.');
    }

    this.workspace = workspace;
    this.displayWorkspace = displayWorkspace || workspace;
    this.tools = tools;
    this.apiKey = apiKey;
    this.model = model || DEFAULT_MODEL;
    this.reasoning = normalizeReasoning(reasoning);
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.history = historyToContents(history);
    this.resolvedModel = null;
  }

  setModel(model) {
    if (!model || !model.trim()) throw new Error('Model name cannot be empty.');
    this.model = model.trim();
    this.resolvedModel = null;
  }

  setReasoning(reasoning) {
    this.reasoning = normalizeReasoning(reasoning);
  }

  clear() {
    this.history = [];
  }

  async prompt(text, { attachments = [], signal } = {}) {
    const checkpoint = this.history.length;
    throwIfAborted(signal);
    const parts = [{ text }, ...await directAttachmentParts(attachments)];
    this.history.push({ role: 'user', parts });

    try {
      let emptyFinalRecoveryUsed = false;
      for (let step = 0; step < MAX_STEPS; step += 1) {
        throwIfAborted(signal);
        const content = await this.#generate(signal);
        const parts = content.parts || [];
        const calls = parts.filter((part) => part.functionCall).map((part) => part.functionCall);
        this.history.push(content);

        if (calls.length === 0) {
          const answer = getText(parts);
          if (answer) return answer;
          if (!emptyFinalRecoveryUsed) {
            emptyFinalRecoveryUsed = true;
            this.history.push({
              role: 'user',
              parts: [{ text: 'Return a concise non-empty final user-facing response for the immediately previous request.' }]
            });
            continue;
          }
          throw new Error('Gemini completed the request but returned no final response text.');
        }

        const responses = [];
        for (const call of calls) {
          let result;
          try {
            result = await this.tools.execute(call.name, call.args || {}, { signal });
          } catch (error) {
            if (isCancellation(error) || signal?.aborted) throw error;
            result = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
          }

          responses.push({
            functionResponse: {
              name: call.name,
              response: { result }
            }
          });
        }

        this.history.push({ role: 'user', parts: responses });
      }

      throw new Error(`Agent exceeded ${MAX_STEPS} tool steps without finishing.`);
    } catch (error) {
      this.history.length = checkpoint;
      throw error;
    }
  }

  async #generate(signal) {
    if (!this.resolvedModel) {
      this.resolvedModel = await resolveApiModel(this.model, {
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        fetchImpl: this.fetchImpl
      });
    }
    const url = `${this.baseUrl}/models/${encodeURIComponent(this.resolvedModel)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const thinkingConfig = reasoningConfig(this.reasoning);
    const generationConfig = { temperature: 0.2 };
    if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt(this.displayWorkspace) }] },
        contents: this.history,
        tools: [{ functionDeclarations }],
        generationConfig
      }),
      signal
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = body?.error?.message || `${response.status} ${response.statusText}`;
      throw new Error(`Model request failed: ${detail}`);
    }

    const content = body?.candidates?.[0]?.content;
    if (!content) {
      const reason = body?.promptFeedback?.blockReason || 'empty model response';
      throw new Error(`Model request failed: ${reason}`);
    }

    return content;
  }
}

export const defaults = {
  model: DEFAULT_MODEL,
  baseUrl: DEFAULT_BASE_URL
};
