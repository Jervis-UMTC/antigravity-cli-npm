import { directAttachmentParts } from './attachments.js';
import { conversationForModel } from './history.js';
import { isCancellation, throwIfAborted } from './cancel.js';

const DEFAULT_MODEL = 'gemini-3.8-flash';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_STEPS = 120;
const MAX_TOOL_RESULT_CHARS = 24_000;
const MAX_MODEL_RETRIES = 3;
const STAGNATION_NUDGE_AFTER = 3;
const STAGNATION_FAIL_AFTER = 6;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 1500, 3000];
const REASONING_BUDGETS = { low: 1024, high: 8192 };

const functionDeclarations = [
  {
    name: 'project_overview',
    description: 'Get a compact overview of the project structure, common manifests, package scripts, language/file counts, and Git status. Prefer this early for broad repository tasks.',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'discover_checks',
    description: 'Discover likely authoritative validation commands from project manifests and build files. Use this before deciding how to verify meaningful edits.',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'find_symbol',
    description: 'Find likely definitions of a named symbol across common source languages without dumping entire files.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Exact symbol name to find.' },
        path: { type: 'STRING', description: 'Optional project-relative search directory.' },
        max_results: { type: 'NUMBER', description: 'Maximum matches. Defaults to 50.' }
      },
      required: ['name']
    }
  },
  {
    name: 'find_references',
    description: 'Find exact word references to a symbol across project text files.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', description: 'Exact symbol name to find references for.' },
        path: { type: 'STRING', description: 'Optional project-relative search directory.' },
        max_results: { type: 'NUMBER', description: 'Maximum matches. Defaults to 100.' }
      },
      required: ['name']
    }
  },
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
    name: 'apply_patch',
    description: 'Apply multiple exact text hunks atomically across existing project files. Prefer this for coordinated focused edits; use write_file for new files.',
    parameters: {
      type: 'OBJECT',
      properties: {
        changes: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              path: { type: 'STRING', description: 'Project-relative file path.' },
              old_text: { type: 'STRING', description: 'Exact existing text to replace.' },
              new_text: { type: 'STRING', description: 'Replacement text.' },
              occurrence: { type: 'NUMBER', description: 'One-based occurrence when old_text appears more than once. Defaults to 1.' }
            },
            required: ['path', 'old_text', 'new_text']
          }
        }
      },
      required: ['changes']
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
    name: 'run_process',
    description: 'Run a native executable with a structured argument array in the project. Prefer this over shell text when shell syntax is not required.',
    parameters: {
      type: 'OBJECT',
      properties: {
        executable: { type: 'STRING', description: 'Executable name or path.' },
        args: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Arguments passed without shell parsing.' },
        cwd: { type: 'STRING', description: 'Optional project-relative working directory.' },
        timeout_ms: { type: 'NUMBER', description: 'Timeout in milliseconds. Defaults to 120000.' }
      },
      required: ['executable']
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
  return `Shell response rules: Never use emojis in any user-facing response. Keep terminal output plain text and professional. Every final user-facing response must end with a final section titled "Summary"; that Summary section must be the last section and briefly state the result and validation performed.\n\nYou are an autonomous coding agent operating in this project:\n${workspace}\n\nUse the provided tools to inspect, edit, test, and debug the project until the user's request is actually complete. For broad tasks, map the repository first with project_overview, find_symbol/find_references, and targeted searches rather than dumping the whole tree. Use discover_checks to identify authoritative validation commands before choosing tests. Prefer run_process with executable/argument arrays when shell syntax is unnecessary, and use run_command only when a shell is actually needed. Prefer apply_patch for coordinated focused edits across existing files and write_file for new or intentionally rewritten files. Maintain an internal plan and update it as evidence changes, but never expose private reasoning or tool-by-tool activity. Work only inside the project unless the user explicitly asks for a command that does otherwise and the command is approved. Inspect relevant files before editing. After meaningful changes, inspect the resulting diff/files and run the most relevant available checks. If a check fails, diagnose it, make evidence-backed fixes, and rerun it instead of stopping at the first failure. Never claim a command passed unless you ran it and saw the result. Do not declare completion immediately after editing without a successful post-edit verification pass. Keep the final terminal response concise and practical.`;
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

function compactToolResult(value) {
  const text = String(value ?? '');
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const tailChars = Math.floor(MAX_TOOL_RESULT_CHARS / 3);
  const headChars = MAX_TOOL_RESULT_CHARS - tailChars;
  return `${text.slice(0, headChars)}\n...[tool output truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars; showing final section below; request a narrower read/search or rerun a focused command if more detail is needed]...\n${text.slice(-tailChars)}`;
}

function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      return;
    }
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
  });
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
  constructor({ workspace, displayWorkspace, tools, apiKey, model, baseUrl, reasoning = 'auto', history = [], fetchImpl = globalThis.fetch, onActivity = () => {} }) {
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
    this.onActivity = typeof onActivity === 'function' ? onActivity : () => {};
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
      let verificationNudges = 0;
      let operationIndex = 0;
      let latestMutation = -1;
      let latestVerification = -1;
      let lastBatchSignature = null;
      let identicalBatchCount = 0;
      let stagnationNudged = false;
      for (let step = 0; step < MAX_STEPS; step += 1) {
        throwIfAborted(signal);
        if (step === 0) this.onActivity('Inspecting');
        const content = await this.#generate(signal);
        const parts = content.parts || [];
        const calls = parts.filter((part) => part.functionCall).map((part) => part.functionCall);
        this.history.push(content);

        if (calls.length === 0) {
          const answer = getText(parts);
          if (answer) {
            if (latestMutation >= 0 && latestVerification < latestMutation) {
              if (verificationNudges >= 2) {
                throw new Error('Agent edited the project but did not perform a successful post-edit verification pass.');
              }
              verificationNudges += 1;
              this.history.push({
                role: 'user',
                parts: [{ text: 'Before finalizing, perform a post-edit verification pass. Inspect the changed files or diff and run the most relevant available test, build, lint, typecheck, or other check. If no runnable check exists, inspect the changed result directly and then return the final response.' }]
              });
              continue;
            }
            return answer;
          }
          if (!emptyFinalRecoveryUsed) {
            emptyFinalRecoveryUsed = true;
            this.history.push({
              role: 'user',
              parts: [{ text: 'Return a concise non-empty final user-facing response for the immediately previous request. Do not use emojis. End the response with a final section titled "Summary" and make that the last section.' }]
            });
            continue;
          }
          throw new Error('Gemini completed the request but returned no final response text.');
        }

        const callNames = new Set(calls.map((call) => call.name));
        const mutationCalls = ['write_file', 'replace_in_file', 'apply_patch', 'delete_path'];
        const verificationCalls = ['run_command', 'run_process', 'git_diff', 'read_file'];
        if (mutationCalls.some((name) => callNames.has(name))) this.onActivity('Working');
        else if (latestMutation >= 0 && verificationCalls.some((name) => callNames.has(name))) this.onActivity('Checking');
        else this.onActivity('Inspecting');

        const responses = [];
        const batchEvidence = [];
        for (const call of calls) {
          operationIndex += 1;
          let result;
          try {
            result = await this.tools.execute(call.name, call.args || {}, { signal });
          } catch (error) {
            if (isCancellation(error) || signal?.aborted) throw error;
            result = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
          }

          const resultText = String(result ?? '');
          const toolSucceeded = !/^(?:Tool error:|Command failed\.|Command denied by user\.)/.test(resultText);
          if (toolSucceeded && ['write_file', 'replace_in_file', 'apply_patch', 'delete_path'].includes(call.name)) {
            latestMutation = operationIndex;
          } else if (toolSucceeded && ['run_command', 'run_process', 'git_diff', 'read_file'].includes(call.name) && latestMutation >= 0) {
            latestVerification = operationIndex;
          }

          responses.push({
            functionResponse: {
              name: call.name,
              response: { result: compactToolResult(result) }
            }
          });
          batchEvidence.push({ name: call.name, args: call.args || {}, result: compactToolResult(result) });
        }

        this.history.push({ role: 'user', parts: responses });
        const batchSignature = JSON.stringify(batchEvidence);
        if (batchSignature === lastBatchSignature) identicalBatchCount += 1;
        else {
          lastBatchSignature = batchSignature;
          identicalBatchCount = 1;
          stagnationNudged = false;
        }
        if (identicalBatchCount >= STAGNATION_FAIL_AFTER) {
          throw new Error('Agent repeated the same tool action without making progress.');
        }
        if (identicalBatchCount >= STAGNATION_NUDGE_AFTER && !stagnationNudged) {
          stagnationNudged = true;
          this.history.push({
            role: 'user',
            parts: [{ text: 'The same tool action has produced the same result repeatedly. Do not repeat it again unchanged. Reassess the evidence and use a different inspection, edit, command, or narrower query to make progress.' }]
          });
        }
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

    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt(this.displayWorkspace) }] },
        contents: this.history,
        tools: [{ functionDeclarations }],
        generationConfig
      }),
      signal
    };

    let lastError = null;
    for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt += 1) {
      throwIfAborted(signal);
      let response;
      try {
        response = await this.fetchImpl(url, request);
      } catch (error) {
        if (isCancellation(error) || signal?.aborted) throw error;
        lastError = error;
        if (attempt === MAX_MODEL_RETRIES) throw error;
        await waitForRetry(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)], signal);
        continue;
      }

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = body?.error?.message || `${response.status} ${response.statusText}`;
        const error = new Error(`Model request failed: ${detail}`);
        if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_MODEL_RETRIES) throw error;
        lastError = error;
        await waitForRetry(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)], signal);
        continue;
      }

      const content = body?.candidates?.[0]?.content;
      if (!content) {
        const reason = body?.promptFeedback?.blockReason || 'empty model response';
        throw new Error(`Model request failed: ${reason}`);
      }
      return content;
    }
    throw lastError || new Error('Model request failed.');
  }
}

export const defaults = {
  model: DEFAULT_MODEL,
  baseUrl: DEFAULT_BASE_URL
};
