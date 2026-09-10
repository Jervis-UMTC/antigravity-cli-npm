import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { CodingAgent, defaults, discoverApiModels } from './agent.js';
import { createActivityIndicator } from './activity.js';
import { attachmentSummary, resolveAttachment } from './attachments.js';
import { isCancellation } from './cancel.js';
import { renderDoctor, runDoctor } from './doctor.js';
import {
  discoverGoogleModels,
  GoogleAccountAgent,
  googleRuntimeStatus,
  loginWithGoogle,
  officialAntigravityBinaryPath,
  providerProvenanceStatus,
  updateOfficialAntigravityCli
} from './google-agent.js';
import { appendConversationTurn, createHistoryStore, renderConversation } from './history.js';
import { initializeProject } from './init.js';
import { createSettingsStore, mergeRuntimePreferences } from './settings.js';
import { createStagingWorkspace } from './staging.js';
import { createTaskStore } from './task-state.js';
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
    commandArg: null,
    print: null,
    attachments: [],
    yes: null,
    turbo: null,
    auth: null,
    model: null,
    reasoning: null,
    baseUrl: process.env.GEMINI_BASE_URL || defaults.baseUrl,
    help: false,
    version: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (i === 0 && ['login', 'init', 'doctor', 'resume', 'provider', 'task'].includes(arg)) {
      result.command = arg;
      if (['provider', 'task'].includes(arg) && argv[i + 1] && !argv[i + 1].startsWith('-')) result.commandArg = argv[++i];
    }
    else if (arg === '-p' || arg === '--print' || arg === '-m' || arg === '--message') result.print = argv[++i] ?? '';
    else if (arg === '--attach') result.attachments.push(argv[++i] ?? '');
    else if (arg === '-y' || arg === '--yes') result.yes = true;
    else if (arg === '--turbo') result.turbo = true;
    else if (arg === '--no-turbo') { result.turbo = false; result.yes = false; }
    else if (arg === '--auth') result.auth = argv[++i] || '';
    else if (arg === '-M' || arg === '--model') result.model = argv[++i] || '';
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
  return `antigyc ${version}\n\nUsage:\n  antigyc                            Start in the current directory\n  antigyc doctor                     Check local installation/runtime health\n  antigyc login                      Verify or renew Google sign-in\n  antigyc provider [status|update]   Inspect or update the private Google backend\n  antigyc resume                     Resume an interrupted staged task\n  antigyc task [clear]               Inspect or discard an interrupted task\n  antigyc init                       Create an optional AGENTS.md template\n  antigyc -m "fix the tests"         Send one text message and exit\n  antigyc -p "fix the tests"         Same one-shot behavior as -m\n  antigyc --attach <path>            Attach a file to the next instruction\n  antigyc --model <name>             Choose a model\n  antigyc --reasoning auto|low|high  Set reasoning effort\n  antigyc --auth auto|google|api-key Set authentication\n  antigyc --yes                      Allow commands without prompts\n  antigyc --turbo                    Trusted autonomous execution for this launch\n  antigyc --no-turbo                 Disable turbo and restore approval prompts for this launch\n\nCommands:\n  help                           Show this text\n  status                         Show current settings and connection health\n  doctor                         Check installation/runtime health\n  provider                       Show private provider status/provenance\n  provider update                Reinstall/update provider with rollback validation\n  resume                         Resume a task left by an interrupted process\n  task                           Show whether an interrupted task exists\n  task clear                     Discard an interrupted task and staged copy\n  init                           Create AGENTS.md when explicitly requested\n  attach <path>                  Attach image/PDF/Office/text file to next instruction\n  attach                         List pending attachments\n  attach clear                   Clear pending attachments\n  history                        Show project conversation history\n  history clear                  Clear project conversation history\n  history path                   Show external history file path\n  model                          Show current model\n  model <name>                   Change and persist model\n  reasoning                      Show reasoning effort\n  reasoning auto|low|high        Change and persist reasoning effort\n  auth                           Show authentication mode\n  auth auto|google|api-key       Change and persist authentication mode\n  approval                       Show command approval mode\n  approval ask|yes               Change and persist approval mode\n  turbo                          Show turbo mode\n  turbo on|off                   Change and persist turbo mode\n  login                          Verify or renew Google sign-in\n  clear                          Clear conversation state\n  cwd                            Print current directory\n  cls                            Clear the terminal\n  exit                           Exit\n`;
}

export function promptLabel(workspace) {
  return `antigyc ${workspace}> `;
}

export function plainTerminalText(value) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let inFence = false;

  for (const rawLine of lines) {
    if (/^\s*(?:```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      output.push(rawLine);
      continue;
    }
    if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(rawLine)) continue;

    let line = rawLine
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      .replace(/<(https?:\/\/[^>]+)>/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/__([^_\n]+)__/g, '$1')
      .replace(/~~([^~\n]+)~~/g, '$1')
      .replace(/(^|[\s([{])\*([^*\n]+)\*(?=$|[\s)\]}.!?;,:])/g, '$1$2')
      .replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, '$1');

    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line.trim().replace(/^\|\s*/, '').replace(/\s*\|$/, '');
    }
    output.push(line);
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function resolveAuthMode(options) {
  if (options.auth !== 'auto') return options.auth;
  return process.env.GEMINI_API_KEY ? 'api-key' : 'google';
}

function currentModel(options) {
  if (options.model) return options.model;
  return resolveAuthMode(options) === 'google' ? 'auto' : defaults.model;
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

async function buildAgent(options, rl, stagedWorkspace, displayWorkspace, history = [], getActivity = () => null, onEvent = () => {}) {
  const authMode = resolveAuthMode(options);

  if (authMode === 'google') {
    return new GoogleAccountAgent({
      workspace: stagedWorkspace,
      displayWorkspace,
      model: options.model || 'auto',
      reasoning: options.reasoning,
      yes: options.yes,
      history,
      onActivity: (phase) => getActivity()?.setPhase?.(phase),
      onEvent
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
    history,
    onActivity: (phase) => getActivity()?.setPhase?.(phase),
    onEvent
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

function interruptedTaskLine(task) {
  return task ? `task=pending${task.createdAt ? ` since=${task.createdAt}` : ''}` : 'task=none';
}

async function providerStatusLine() {
  const binaryPath = officialAntigravityBinaryPath();
  const [runtime, provenance] = await Promise.all([
    googleRuntimeStatus(),
    providerProvenanceStatus({ binaryPath })
  ]);
  return `provider=${runtime.backend}${runtime.version ? ` version=${runtime.version}` : ''} account=${runtime.account} provenance=${provenance.status} path=${binaryPath}`;
}

async function runProviderCommand(argument, stream = output) {
  const command = String(argument || 'status').trim().toLowerCase() || 'status';
  if (command === 'status') {
    stream.write(`${await providerStatusLine()}\n`);
    return;
  }
  if (command !== 'update') throw new Error('Provider command must be provider or provider update.');

  const indicator = createActivityIndicator(stream);
  indicator.setPhase('Updating provider');
  try {
    const result = await updateOfficialAntigravityCli();
    indicator.stop();
    stream.write(`provider=updated version=${result.version || 'unknown'} provenance=${result.provenance.status} path=${result.binaryPath}\n`);
  } catch (error) {
    indicator.stop();
    throw error;
  }
}

function resumeAttachments(attachments = []) {
  return attachments.map((attachment) => attachment.kind === 'office'
    ? { ...attachment, kind: 'text', mimeType: 'text/plain', sourcePath: attachment.stagedPath }
    : attachment);
}

async function executeAgentTask({
  options,
  rl,
  workspace,
  conversation,
  attachments = [],
  text = null,
  resume = false,
  taskStore,
  controller,
  activity
}) {
  const pending = await taskStore.load();
  if (resume && !pending) throw new Error('No interrupted task is available in this project.');
  if (!resume && pending) {
    throw new Error('An interrupted task is available. Run `resume` to continue it or `task clear` to discard it.');
  }

  const staging = await createStagingWorkspace(workspace, pending ? { container: pending.container } : {});
  let preserveStage = false;
  try {
    activity?.setPhase('Preparing');
    let stagedAttachments;
    let modelPrompt;
    let userText;
    let historyAttachments;

    if (pending) {
      await staging.resume();
      stagedAttachments = resumeAttachments(pending.attachments);
      userText = pending.prompt;
      historyAttachments = pending.attachments.map((attachment) => ({
        sourcePath: attachment.sourcePath || attachment.stagedPath,
        name: attachment.name,
        mimeType: attachment.mimeType,
        kind: attachment.kind
      }));
      modelPrompt = `Continue the interrupted task from the existing staged project state. Reinspect any partial changes, validate the final result, and finish safely.\n\nOriginal request:\n${pending.prompt}`;
    } else {
      await staging.begin();
      stagedAttachments = await staging.stageAttachments(attachments);
      userText = String(text || '').trim();
      historyAttachments = attachments;
      modelPrompt = userText;
      await taskStore.save({ prompt: userText, container: staging.container, attachments: stagedAttachments });
    }

    activity?.setPhase('Inspecting');
    const agent = await buildAgent(options, rl, staging.workspace, workspace, conversation, () => activity, (event) => {
      activity?.emit?.(event);
    });
    const answer = plainTerminalText(await agent.prompt(modelPrompt, {
      attachments: stagedAttachments,
      signal: controller?.signal
    }));
    if (!answer) throw new Error('Agent returned no plain-text response.');
    activity?.setPhase('Applying changes');
    await staging.commit({ signal: controller?.signal });
    await taskStore.clear();
    return { answer, userText, historyAttachments };
  } catch (error) {
    if (error?.code === 'RESUME_CONFLICT') {
      preserveStage = true;
    } else {
      try { await taskStore.clear(); } catch {}
      try { await staging.discard(); } catch {}
    }
    throw error;
  } finally {
    await staging.close({ preserve: preserveStage });
  }
}
async function runInteractive(options, workspace, settingsStore) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error('Interactive mode requires a terminal. Use antigyc -p "your prompt" for non-interactive use.');
  }

  const rl = readline.createInterface({ input, output, terminal: true });
  const historyStore = await createHistoryStore(workspace);
  const taskStore = await createTaskStore(workspace);
  let conversation = await historyStore.load();
  let pendingAttachments = await resolveAttachmentList(options.attachments, workspace);
  let activeIndicator = null;
  let activeController = null;
  const authBootstrap = createGoogleAuthBootstrap(options, {
    notify: (message) => output.write(`${message}\n`)
  });

  const clearConversation = async () => {
    conversation = [];
    pendingAttachments = [];
    await historyStore.clear();
  };

  const onSigint = () => {
    if (activeController) activeController.abort();
  };
  rl.on('SIGINT', onSigint);

  const processRequest = async (text, { resume = false } = {}) => {
    const existing = await taskStore.load();
    if (resume && !existing) throw new Error('No interrupted task is available in this project.');
    if (!resume && existing) {
      throw new Error('An interrupted task is available. Run `resume` to continue it or `task clear` to discard it.');
    }
    await authBootstrap.ensure();
    activeIndicator = createActivityIndicator(output);
    activeIndicator.setPhase('Preparing');
    activeController = new AbortController();
    try {
      return await executeAgentTask({
        options,
        rl,
        workspace,
        conversation,
        attachments: pendingAttachments,
        text,
        resume,
        taskStore,
        controller: activeController,
        activity: activeIndicator
      });
    } finally {
      activeIndicator?.stop();
      activeIndicator = null;
      activeController = null;
    }
  };

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
        try { await clearConversation(); }
        catch (error) { output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`); }
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
      if (line === 'doctor') {
        try {
          const report = await runDoctor({ version: await packageVersion(), workspace });
          output.write(`${renderDoctor(report)}\n`);
        } catch (error) {
          output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`);
        }
        continue;
      }

      const provider = commandArgument(line, 'provider');
      if (provider !== null) {
        try {
          await runProviderCommand(provider, output);
          output.write('\n');
          authBootstrap.reset();
        } catch (error) {
          output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`);
        }
        continue;
      }

      const taskCommand = commandArgument(line, 'task');
      if (taskCommand !== null) {
        try {
          if (!taskCommand || taskCommand === 'status') {
            output.write(`${interruptedTaskLine(await taskStore.load())}\n\n`);
          } else if (taskCommand === 'clear') {
            await taskStore.clear({ removeStage: true });
          } else {
            throw new Error('Task command must be task or task clear.');
          }
        } catch (error) {
          output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`);
        }
        continue;
      }

      const turbo = commandArgument(line, 'turbo');
      if (turbo !== null) {
        if (!turbo) output.write(`${options.turbo ? 'on' : 'off'}\n\n`);
        else if (!['on', 'off'].includes(turbo)) {
          output.write('\nError: Turbo must be on or off.\n\n');
        } else {
          try {
            const enabled = turbo === 'on';
            await settingsStore.update(enabled ? { turbo: true, approval: 'yes' } : { turbo: false, approval: 'ask' });
            options.turbo = enabled;
            options.yes = enabled;
          } catch (error) {
            output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`);
          }
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
        const task = await taskStore.load().catch(() => null);
        output.write(`model=${currentModel(options)} reasoning=${options.reasoning} auth=${authMode} approval=${options.yes ? 'yes' : 'ask'} turbo=${options.turbo ? 'on' : 'off'} backend=${backend} account=${account} attachments=${pendingAttachments.length} history=${turns} task=${task ? 'pending' : 'none'}\n\n`);
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
        if (!model) output.write(`${currentModel(options)}\n\n`);
        else if (model === 'list') {
          const models = await availableModels(options, workspace, currentModel(options));
          output.write(`${models.join('\n')}\n\n`);
        } else {
          try {
            if (!model.trim()) throw new Error('Model name cannot be empty.');
            await settingsStore.update({ model });
            options.model = model;
          } catch (error) {
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
            if (auth === 'api-key' && !process.env.GEMINI_API_KEY) {
              throw new Error('Missing GEMINI_API_KEY for API-key mode.');
            }
            await settingsStore.update({ auth });
            options.auth = auth;
            authBootstrap.reset();
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
            await settingsStore.update(approval === 'ask' ? { approval, turbo: false } : { approval });
            options.yes = approval === 'yes';
            if (approval === 'ask') options.turbo = false;
          } catch (error) {
            output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`);
          }
        }
        continue;
      }

      const isResume = line === 'resume';
      let result;
      try {
        result = await processRequest(isResume ? null : line, { resume: isResume });
      } catch (error) {
        if (error?.code === 'GOOGLE_AUTH_REQUIRED') authBootstrap.reset();
        if (isCancellation(error)) output.write('\nCanceled.\n\n');
        else output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`);
        continue;
      }

      conversation = appendConversationTurn(
        conversation,
        result.userText,
        attachmentSummary(result.historyAttachments),
        result.answer
      );
      pendingAttachments = [];
      let historyError = null;
      try { await historyStore.save(conversation); }
      catch (error) { historyError = error; }

      output.write(`\n${result.answer}\n\n`);
      if (historyError) {
        output.write(`Error: Conversation history was not saved: ${historyError instanceof Error ? historyError.message : String(historyError)}\n\n`);
      }
    }
  } finally {
    activeController?.abort();
    activeIndicator?.stop();
    rl.off('SIGINT', onSigint);
    rl.close();
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

  if (parsedOptions.command === 'doctor') {
    const report = await runDoctor({ version, workspace });
    output.write(renderDoctor(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (parsedOptions.command === 'provider') {
    await runProviderCommand(parsedOptions.commandArg, output);
    return;
  }

  if (parsedOptions.command === 'task') {
    const taskStore = await createTaskStore(workspace);
    const command = String(parsedOptions.commandArg || 'status').toLowerCase();
    if (command === 'status') {
      output.write(`${interruptedTaskLine(await taskStore.load())}\n`);
    } else if (command === 'clear') {
      await taskStore.clear({ removeStage: true });
    } else {
      throw new Error('Task command must be task or task clear.');
    }
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
  options.turbo = Boolean(options.turbo);
  options.yes = Boolean(options.yes || options.turbo);

  const authBootstrap = createGoogleAuthBootstrap(options, {
    notify: (message) => output.write(`${message}\n`)
  });

  const shouldResume = parsedOptions.command === 'resume';
  if (shouldResume || options.print !== null) {
    if (!shouldResume && !String(options.print || '').trim()) throw new Error('Prompt cannot be empty.');
    if (shouldResume && options.attachments.length) throw new Error('Resume uses the attachments saved with the interrupted task.');

    const historyStore = await createHistoryStore(workspace);
    const taskStore = await createTaskStore(workspace);
    const conversation = await historyStore.load();
    const pending = await taskStore.load();
    if (shouldResume && !pending) throw new Error('No interrupted task is available in this project.');
    if (!shouldResume && pending) {
      throw new Error('An interrupted task is available. Run `antigyc resume` to continue it or `antigyc task clear` to discard it.');
    }

    await authBootstrap.ensure();
    const attachments = shouldResume ? [] : await resolveAttachmentList(options.attachments, workspace);
    const controller = new AbortController();
    const indicator = createActivityIndicator(output);
    indicator.setPhase('Preparing');
    const onSigint = () => controller.abort();
    process.once('SIGINT', onSigint);
    try {
      const result = await executeAgentTask({
        options,
        rl: null,
        workspace,
        conversation,
        attachments,
        text: shouldResume ? null : options.print,
        resume: shouldResume,
        taskStore,
        controller,
        activity: indicator
      });
      indicator.stop();
      const updated = appendConversationTurn(
        conversation,
        result.userText,
        attachmentSummary(result.historyAttachments),
        result.answer
      );
      let historyError = null;
      try { await historyStore.save(updated); }
      catch (error) { historyError = error; }
      output.write(`${result.answer}\n`);
      if (historyError) {
        output.write(`Error: Conversation history was not saved: ${historyError instanceof Error ? historyError.message : String(historyError)}\n`);
      }
    } finally {
      indicator.stop();
      process.off('SIGINT', onSigint);
    }
    return;
  }

  await runInteractive(options, workspace, settingsStore);
}
