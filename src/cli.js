import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { CodingAgent, defaults, discoverApiModels } from './agent.js';
import { createActivityIndicator } from './activity.js';
import { attachmentSummary, resolveAttachment } from './attachments.js';
import { isCancellation } from './cancel.js';
import { discoverGoogleModels, GoogleAccountAgent, googleRuntimeStatus, loginWithGoogle } from './google-agent.js';
import { appendConversationTurn, createHistoryStore, renderConversation } from './history.js';
import { initializeProject } from './init.js';
import { createSettingsStore, mergeRuntimePreferences } from './settings.js';
import { createStagingWorkspace } from './staging.js';
import { createTools } from './tools.js';

const MODEL_ALIASES = ['auto', 'pro', 'flash', 'flash-lite'];

async function packageVersion() {
  const raw = await fs.readFile(new URL('../package.json', import.meta.url), 'utf8');
  return JSON.parse(raw).version;
}

function uniqueModels(models) {
  return [...new Set(models.map((model) => String(model || '').trim()).filter(Boolean))];
}

async function availableModels(options, workspace, currentModel) {
  let discovered = [];
  try {
    if (resolveAuthMode(options) === 'google') {
      discovered = await discoverGoogleModels({ workspace });
    } else if (process.env.GEMINI_API_KEY) {
      discovered = await discoverApiModels({
        apiKey: process.env.GEMINI_API_KEY,
        baseUrl: options.baseUrl
      });
    }
  } catch {
    // Model listing remains useful when provider discovery is temporarily unavailable.
  }

  return uniqueModels([
    ...MODEL_ALIASES,
    currentModel,
    ...discovered,
    ...(discovered.length ? [] : [defaults.model])
  ]);
}

function normalizeReasoning(value) {
  const level = String(value || 'auto').trim().toLowerCase();
  if (!['auto', 'low', 'high'].includes(level)) {
    throw new Error('Reasoning must be auto, low, or high.');
  }
  return level;
}

function parseArgs(argv) {
  const result = {
    command: null,
    print: null,
    attachments: [],
    yes: null,
    auth: null,
    model: null,
    reasoning: null,
    baseUrl: process.env.GEMINI_BASE_URL || defaults.baseUrl,
    help: false,
    version: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === 'login' || arg === 'init') && i === 0) result.command = arg;
    else if (arg === '-p' || arg === '--print') result.print = argv[++i] ?? '';
    else if (arg === '--attach') result.attachments.push(argv[++i] ?? '');
    else if (arg === '-y' || arg === '--yes') result.yes = true;
    else if (arg === '--auth') result.auth = argv[++i] || '';
    else if (arg === '-m' || arg === '--model') result.model = argv[++i] || '';
    else if (arg === '--reasoning') result.reasoning = normalizeReasoning(argv[++i] || '');
    else if (arg === '--base-url') result.baseUrl = argv[++i] || result.baseUrl;
    else if (arg === '-h' || arg === '--help') result.help = true;
    else if (arg === '-v' || arg === '--version') result.version = true;
    else if (!arg.startsWith('-') && result.print === null && !result.command) result.print = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (result.auth !== null && !['auto', 'google', 'api-key'].includes(result.auth)) {
    throw new Error('Invalid --auth value. Use auto, google, or api-key.');
  }

  return result;
}

function helpText(version) {
  return `agy ${version}\n\nUsage:\n  agy                            Start in the current directory\n  agy login                      Verify or renew Google sign-in\n  agy init                       Create an optional AGENTS.md template\n  agy -p "fix the tests"         Run one instruction and exit\n  agy --attach <path>            Attach a file to the next instruction\n  agy --model <name>             Choose a model\n  agy --reasoning auto|low|high  Set reasoning effort\n  agy --auth auto|google|api-key Set authentication\n  agy --yes                      Allow commands without prompts\n\nCommands:\n  help                           Show this text\n  status                         Show current settings and connection health\n  init                           Create AGENTS.md when explicitly requested\n  attach <path>                  Attach image/PDF/Office/text file to next instruction\n  attach                         List pending attachments\n  attach clear                   Clear pending attachments\n  history                        Show project conversation history\n  history clear                  Clear project conversation history\n  history path                   Show external history file path\n  model                          Show current model\n  model <name>                   Change and persist model\n  reasoning                      Show reasoning effort\n  reasoning auto|low|high        Change and persist reasoning effort\n  auth                           Show authentication mode\n  auth auto|google|api-key       Change and persist authentication mode\n  approval                       Show command approval mode\n  approval ask|yes               Change and persist approval mode\n  login                          Verify or renew Google sign-in\n  clear                          Clear conversation state\n  cwd                            Print current directory\n  cls                            Clear the terminal\n  exit                           Exit\n`;
}

function promptLabel(workspace) {
  return `${workspace}> `;
}

function resolveAuthMode(options) {
  if (options.auth !== 'auto') return options.auth;
  return process.env.GEMINI_API_KEY ? 'api-key' : 'google';
}

export function createGoogleAuthBootstrap(options, {
  login = loginWithGoogle,
  notify = () => {}
} = {}) {
  let ready = false;

  return {
    reset() {
      ready = false;
    },
    markReady() {
      ready = true;
    },
    async ensure() {
      if (resolveAuthMode(options) !== 'google') return false;
      if (ready) return true;
      await login({ notify });
      ready = true;
      return true;
    }
  };
}

async function buildAgent(options, rl, stagedWorkspace, displayWorkspace, history = [], getActivity = () => null) {
  const authMode = resolveAuthMode(options);

  if (authMode === 'google') {
    return new GoogleAccountAgent({
      workspace: stagedWorkspace,
      displayWorkspace,
      model: options.model || 'auto',
      reasoning: options.reasoning,
      yes: options.yes,
      history
    });
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY for API-key mode. Set it or switch to `auth google`; Google mode bootstraps automatically.');
  }

  const approveCommand = async (command, cwd) => {
    if (options.yes) return true;
    if (!input.isTTY || !output.isTTY || !rl) return false;
    const shownCwd = cwd === '.' ? displayWorkspace : path.join(displayWorkspace, cwd);
    getActivity()?.pause();
    try {
      const answer = await rl.question(`\n${shownCwd}> ${command}\nProceed? [y/N] `);
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      getActivity()?.resume();
    }
  };

  const tools = await createTools({ workspace: stagedWorkspace, approveCommand });
  return new CodingAgent({
    workspace: stagedWorkspace,
    displayWorkspace,
    tools,
    apiKey: process.env.GEMINI_API_KEY,
    model: options.model || defaults.model,
    reasoning: options.reasoning,
    baseUrl: options.baseUrl,
    history
  });
}

function commandArgument(line, command) {
  if (line === command) return '';
  if (line.startsWith(`${command} `)) return line.slice(command.length + 1).trim();
  return null;
}

async function resolveAttachmentList(values, workspace) {
  const attachments = [];
  for (const value of values) attachments.push(await resolveAttachment(value, workspace));
  return attachments;
}

async function runInteractive(options, workspace, settingsStore) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error('Interactive mode requires a terminal. Use agy -p "your prompt" for non-interactive use.');
  }

  const rl = readline.createInterface({ input, output, terminal: true });
  const staging = await createStagingWorkspace(workspace);
  const historyStore = await createHistoryStore(workspace);
  let conversation = await historyStore.load();
  let pendingAttachments = await resolveAttachmentList(options.attachments, workspace);
  let activeIndicator = null;
  let activeController = null;
  const getActivity = () => activeIndicator;
  const authBootstrap = createGoogleAuthBootstrap(options, {
    notify: (message) => output.write(`${message}\n`)
  });
  let agent = await buildAgent(options, rl, staging.workspace, workspace, conversation, getActivity);

  const rebuildAgent = async () => {
    agent = await buildAgent(options, rl, staging.workspace, workspace, conversation, getActivity);
  };

  const clearConversation = async () => {
    conversation = [];
    pendingAttachments = [];
    await historyStore.clear();
    await rebuildAgent();
  };

  const onSigint = () => {
    if (activeController) activeController.abort();
  };
  rl.on('SIGINT', onSigint);

  try {
    while (true) {
      const line = (await rl.question(promptLabel(workspace))).trim();
      if (!line) continue;

      if (line === 'exit' || line === 'quit') break;
      if (line === 'help') {
        output.write(`\n${helpText(await packageVersion())}\n`);
        continue;
      }
      if (line === 'clear') {
        try {
          await clearConversation();
        } catch (error) {
          output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`);
        }
        continue;
      }
      if (line === 'cwd') {
        output.write(`${workspace}\n\n`);
        continue;
      }
      if (line === 'cls') {
        output.write('\x1Bc');
        continue;
      }
      if (line === 'init') {
        try {
          const target = await initializeProject(workspace);
          output.write(`Created ${path.basename(target)}.\n\n`);
        } catch (error) {
          output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`);
        }
        continue;
      }
      if (line === 'status') {
        const turns = conversation.filter((message) => message.role === 'user').length;
        const authMode = resolveAuthMode(options);
        let backend = 'ready';
        let account = authMode === 'api-key' ? (process.env.GEMINI_API_KEY ? 'configured' : 'missing') : 'unknown';
        if (authMode === 'google') {
          const runtime = await googleRuntimeStatus();
          backend = runtime.backend;
          account = runtime.account;
        }
        output.write(`model=${agent.model} reasoning=${options.reasoning} auth=${authMode} approval=${options.yes ? 'yes' : 'ask'} backend=${backend} account=${account} attachments=${pendingAttachments.length} history=${turns}\n\n`);
        continue;
      }
      if (line === 'login') {
        try {
          await loginWithGoogle({ notify: (message) => output.write(`${message}\n`) });
          authBootstrap.markReady();
        } catch (error) {
          output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`);
        }
        continue;
      }

      const attach = commandArgument(line, 'attach');
      if (attach !== null) {
        try {
          if (!attach || attach === 'list') {
            output.write(`${pendingAttachments.length ? pendingAttachments.map((item) => item.sourcePath).join('\n') : '(none)'}\n\n`);
          } else if (attach === 'clear') {
            pendingAttachments = [];
          } else {
            pendingAttachments.push(await resolveAttachment(attach, workspace));
          }
        } catch (error) {
          output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`);
        }
        continue;
      }

      const historyCommand = commandArgument(line, 'history');
      if (historyCommand !== null) {
        try {
          if (!historyCommand || historyCommand === 'list') {
            output.write(`${renderConversation(conversation)}\n\n`);
          } else if (historyCommand === 'clear') {
            await clearConversation();
          } else if (historyCommand === 'path') {
            output.write(`${historyStore.path}\n\n`);
          } else {
            throw new Error('History command must be history, history clear, or history path.');
          }
        } catch (error) {
          output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`);
        }
        continue;
      }

      const model = commandArgument(line, 'model');
      if (model !== null) {
        if (!model) output.write(`${agent.model}\n\n`);
        else if (model === 'list') {
          const models = await availableModels(options, workspace, agent.model);
          output.write(`${models.join('\n')}\n\n`);
        } else {
          const previous = agent.model;
          try {
            agent.setModel(model);
            await settingsStore.update({ model });
            options.model = model;
          } catch (error) {
            if (previous) agent.setModel(previous);
            output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`);
          }
        }
        continue;
      }

      const reasoning = commandArgument(line, 'reasoning');
      if (reasoning !== null) {
        if (!reasoning) output.write(`${options.reasoning}\n\n`);
        else if (reasoning === 'list') output.write('auto\nlow\nhigh\n\n');
        else {
          try {
            const next = normalizeReasoning(reasoning);
            await settingsStore.update({ reasoning: next });
            options.reasoning = next;
            agent.setReasoning(next);
          } catch (error) {
            output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`);
          }
        }
        continue;
      }

      const auth = commandArgument(line, 'auth');
      if (auth !== null) {
        if (!auth) output.write(`${resolveAuthMode(options)}\n\n`);
        else if (auth === 'list') output.write('auto\ngoogle\napi-key\n\n');
        else {
          try {
            if (!['auto', 'google', 'api-key'].includes(auth)) {
              throw new Error('Authentication must be auto, google, or api-key.');
            }
            const previous = options.auth;
            options.auth = auth;
            authBootstrap.reset();
            try {
              await rebuildAgent();
              await settingsStore.update({ auth });
            } catch (error) {
              options.auth = previous;
              await rebuildAgent();
              throw error;
            }
          } catch (error) {
            output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`);
          }
        }
        continue;
      }

      const approval = commandArgument(line, 'approval');
      if (approval !== null) {
        if (!approval) output.write(`${options.yes ? 'yes' : 'ask'}\n\n`);
        else if (approval === 'list') output.write('ask\nyes\n\n');
        else if (!['ask', 'yes'].includes(approval)) {
          output.write('\nError: Approval must be ask or yes.\n\n');
        } else {
          try {
            const yes = approval === 'yes';
            await settingsStore.update({ approval });
            options.yes = yes;
            if (typeof agent.setApproval === 'function') agent.setApproval(yes);
          } catch (error) {
            output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`);
          }
        }
        continue;
      }

      let answer;
      try {
        await authBootstrap.ensure();
      } catch (error) {
        output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`);
        continue;
      }
      activeIndicator = createActivityIndicator(output);
      activeController = new AbortController();
      try {
        await staging.begin();
        const stagedAttachments = await staging.stageAttachments(pendingAttachments);
        answer = await agent.prompt(line, { attachments: stagedAttachments, signal: activeController.signal });
        activeIndicator.setMessage('Applying changes...');
        await staging.commit({ signal: activeController.signal });
      } catch (error) {
        activeIndicator.stop();
        activeIndicator = null;
        activeController = null;
        await staging.discard();
        if (error?.code === 'GOOGLE_AUTH_REQUIRED') authBootstrap.reset();
        await rebuildAgent();
        if (isCancellation(error)) output.write('\nCanceled.\n\n');
        else output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`);
        continue;
      }
      activeIndicator.stop();
      activeIndicator = null;
      activeController = null;

      conversation = appendConversationTurn(conversation, line, attachmentSummary(pendingAttachments), answer);
      pendingAttachments = [];
      let historyError = null;
      try {
        await historyStore.save(conversation);
      } catch (error) {
        historyError = error;
      }

      output.write(`\n${answer}\n\n`);
      if (historyError) {
        output.write(`Error: Conversation history was not saved: ${historyError instanceof Error ? historyError.message : String(historyError)}\n\n`);
      }
    }
  } finally {
    activeController?.abort();
    rl.off('SIGINT', onSigint);
    rl.close();
    await staging.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const parsedOptions = parseArgs(argv);
  const version = await packageVersion();
  const workspace = path.resolve(process.cwd());

  if (parsedOptions.help) {
    output.write(helpText(version));
    return;
  }
  if (parsedOptions.version) {
    output.write(`${version}\n`);
    return;
  }

  if (parsedOptions.command === 'init') {
    const target = await initializeProject(workspace);
    output.write(`Created ${path.basename(target)}.\n`);
    return;
  }

  if (parsedOptions.command === 'login') {
    await loginWithGoogle({ notify: (message) => output.write(`${message}\n`) });
    return;
  }

  const settingsStore = await createSettingsStore();
  const storedPreferences = await settingsStore.load();
  const options = mergeRuntimePreferences(parsedOptions, storedPreferences, process.env);
  options.reasoning = normalizeReasoning(options.reasoning);
  if (!['auto', 'google', 'api-key'].includes(options.auth)) {
    throw new Error('Invalid authentication setting. Use auto, google, or api-key.');
  }
  options.yes = Boolean(options.yes);

  const authBootstrap = createGoogleAuthBootstrap(options, {
    notify: (message) => output.write(`${message}\n`)
  });

  if (options.print !== null) {
    if (!options.print.trim()) throw new Error('Prompt cannot be empty.');
    await authBootstrap.ensure();
    const staging = await createStagingWorkspace(workspace);
    const historyStore = await createHistoryStore(workspace);
    const conversation = await historyStore.load();
    const attachments = await resolveAttachmentList(options.attachments, workspace);
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once('SIGINT', onSigint);
    try {
      await staging.begin();
      const stagedAttachments = await staging.stageAttachments(attachments);
      const agent = await buildAgent(options, null, staging.workspace, workspace, conversation);
      const answer = await agent.prompt(options.print, { attachments: stagedAttachments, signal: controller.signal });
      await staging.commit({ signal: controller.signal });
      const updated = appendConversationTurn(conversation, options.print, attachmentSummary(attachments), answer);
      let historyError = null;
      try {
        await historyStore.save(updated);
      } catch (error) {
        historyError = error;
      }
      output.write(`${answer}\n`);
      if (historyError) {
        output.write(`Error: Conversation history was not saved: ${historyError instanceof Error ? historyError.message : String(historyError)}\n`);
      }
    } catch (error) {
      await staging.discard();
      throw error;
    } finally {
      process.off('SIGINT', onSigint);
      await staging.close();
    }
    return;
  }

  await runInteractive(options, workspace, settingsStore);
}
