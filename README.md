# antigyc

`antigyc` is an AI coding agent you run from a normal terminal. Install it once, open the folder you want it to work on, run `antigyc`, then type what you want done.

The npm package and public command are both `antigyc`. The GitHub repository remains `Jervis-UMTC/antigravity-cli-npm`.

> Use `antigyc`, not `agy`. `agy` may belong to Google's own Antigravity CLI or another installed program.

## Quick start (most important commands)

Install:

```text
npm install -g antigyc
```

Start working in your project:

```text
cd your-project-folder
antigyc
```

Inside the antigyc shell:

```text
inspect the project
fix the bugs in this project
add a feature and run the tests
explain this codebase
```

Useful commands:

```text
status     show current model/auth/backend state
doctor     check installation problems
help       show available commands
exit       close antigyc
```

One-shot usage:

```text
antigyc -m "inspect this project and fix important issues"
```

Attachments:

```text
attach C:\path\to\file.pdf
implement the requirements from the attachment
```

## Foolproof tutorial for beginners

If you only want to use `antigyc`, follow these steps exactly. You do not need to understand npm, API keys, providers, models, staging, or the rest of this README first.

### What you need

You need:

- Windows, macOS, or Linux;
- Node.js 20 or newer;
- npm, which normally comes with Node.js;
- a Google account with the Google/Gemini subscription you want to use.

For the normal setup you do **not** need:

- a Gemini API key;
- a separate Antigravity installation;
- a separate Gemini CLI installation;
- `git init`;
- a setup wizard;
- a manual `login` command before your first request.

### Step 1 — check Node.js

Open Command Prompt, PowerShell, Terminal, or your normal shell and run:

```text
node --version
npm --version
```

If both commands print versions and Node starts with `v20`, `v21`, `v22`, `v23`, `v24`, or newer, continue.

If `node` or `npm` says it is not recognized or not found, install Node.js 20 or newer, close the terminal, open a new terminal, and run the two commands again.

### Step 2 — install antigyc

Copy and run:

```text
npm install -g antigyc
```

Then check that the command works:

```text
antigyc --version
```

If that prints a version, installation is complete.

On Windows, if `antigyc` is not recognized immediately after installation, close that terminal and open one new terminal, then try `antigyc --version` again.

If it is still not recognized, run:

```text
npx antigyc --version
```

If `npx antigyc --version` works, the package is installed/available and only your global command PATH needs attention. See the troubleshooting section near the bottom of this README.

### Step 3 — go to the project you want to work on

`antigyc` works on the folder you launch it from. Always change into the correct project folder first.

Windows example:

```text
cd C:\projects\my-app
antigyc
```

macOS/Linux example:

```text
cd ~/projects/my-app
antigyc
```

You should get a plain prompt similar to:

```text
antigyc C:\projects\my-app>
```

That means you are inside the `antigyc` shell and it is working on `C:\projects\my-app`.

### Step 4 — type what you want

There are no slash commands required. Type a normal instruction after the prompt.

Examples:

```text
antigyc C:\projects\my-app> check this project and explain what it does
antigyc C:\projects\my-app> find the bug causing the tests to fail and fix it
antigyc C:\projects\my-app> add a login page using the existing project style and run the tests
antigyc C:\projects\my-app> inspect the whole project, fix important problems, and validate everything
```

The agent can inspect files, edit code, run relevant commands/tests, react to failures, and continue working until it has a final result.

### Step 5 — first use on a new computer

Fresh installs already default to Google subscription authentication. You do not need to configure a key.

The first real request on a new computer may open Google's browser sign-in. If that happens:

1. Sign in with the Google account that owns the subscription you want to use.
2. Complete the browser approval.
3. Return to the terminal.
4. The original `antigyc` request continues automatically.

Later launches reuse the saved Google session, so you normally do not repeat this.

If an old installation has saved different authentication settings, start `antigyc` and run this once:

```text
antigyc C:\projects\my-app> auth google
```

You can check the current state with:

```text
antigyc C:\projects\my-app> status
```

A fresh setup normally uses:

```text
model=gemini-3.8-flash
auth=google
turbo=off
approval=ask
```

### Step 6 — attach a screenshot, PDF, document, or code file

Inside `antigyc`, attach the file first, then type the instruction that should use it:

```text
antigyc C:\projects\my-app> attach C:\docs\requirements.pdf
antigyc C:\projects\my-app> implement the attached requirements and run the tests
```

Another example:

```text
antigyc C:\projects\my-app> attach C:\designs\checkout.png
antigyc C:\projects\my-app> recreate this checkout screen using the existing components
```

Supported first-class attachments include images, PDFs, DOCX, XLSX, PPTX, and ordinary text/code files. An attachment is queued for the next normal instruction.

### Step 7 — cancel a task

If you want to stop the current task while it is working, press Ctrl+C.

`antigyc` cancels the active request, stops the active provider/command where possible, discards unpublished staged changes, keeps earlier conversation history, and returns to the prompt.

### The three commands most beginners need

```text
status     Show the current model/auth/backend/account state
doctor     Check the installation and report what is wrong
help       Show all available commands
```

If something does not work, run:

```text
antigyc C:\projects\my-app> doctor
```

### One-shot usage (optional)

You can also send one request without entering the interactive shell:

```text
antigyc -m "inspect this project and summarize it"
```

With an attachment:

```text
antigyc --attach "C:\docs\requirements.pdf" -m "implement this specification and validate the result"
```

### What antigyc looks like while working

`antigyc` intentionally stays close to an ordinary command prompt. It does not show an AI dashboard, tool stream, model badge, reasoning panel, cards, or animated UI. A request may briefly show a single plain activity line such as `Preparing...`, `Working...`, or `Checking...`, which disappears before the final response.

The agent performs project edits in a private OS-temporary staging copy and publishes the completed file state back to the real project only after the instruction succeeds. Normal responses are instructed to avoid emojis and end with a final `Summary` section.

> This repository is an npm implementation. It is not the proprietary Google Antigravity CLI binary.

## Live agent workflow

While working, `antigyc` keeps coding-agent events internal. The terminal may show only the single transient plain activity line described above; file names, commands, tool calls, test events, model details, and private reasoning are not streamed to normal output.

The workflow is:

1. Inspect the project.
2. Make changes in the protected staging workspace.
3. Keep file, command, and tool activity internal while updating only the generic transient phase.
4. Run available checks and tests.
5. Repair failures when possible.
6. Apply completed changes only after verification succeeds.
7. Return a final response ending with `Summary`.

## Key behavior

- Works in **Git repositories and ordinary non-Git folders**.
- Does **not** require a Git worktree, Git repository, branch, or commit history.
- Keeps intermediate edits outside the real project.
- Does not create AI commits, branches, worktrees, stashes, patches, `.gemini`, or conversation databases in the real project.
- Supports Google-account Gemini authentication and direct Gemini API-key authentication.
- Supports model selection and hidden reasoning effort controls.
- Supports images, PDFs, DOCX, XLSX, PPTX, and text/code document attachments.
- Persists project conversation history and user preferences outside the repository.
- Can preserve an interrupted task only after abnormal process termination and resume it later without publishing partial work.
- Includes plain `doctor`, provider provenance/update, and interrupted-task inspection commands.
- Uses plain CMD-style text commands instead of slash commands or menus.

## Requirements

- Node.js 20.11+ on Node 20, or a current Node.js 22/24 release.
- npm.
- A Google/Gemini subscription account through Google's official Antigravity CLI backend for the default setup.
- Direct Gemini API-key mode remains available only when you explicitly select it.

Fresh installs default to **Google subscription auth + `approval ask` + turbo off**. Autonomous command execution remains available through explicit `--yes`, `--turbo`, `approval yes`, or `turbo on` choices. `antigyc` uses the official Antigravity CLI only as a hidden headless backend. A normal npm install pre-provisions that backend into a private per-user data location, even when the machine has no Antigravity installation. The provider binary is never added to PATH and never claims this package's `antigyc` command. If pre-provisioning was temporarily offline, the first Google request retries the same bootstrap automatically.

## Detailed setup and configuration

The beginner quick start above is enough for normal use. This section gives the same setup in more detail, including local-development installation, explicit authentication choices, diagnostics, and advanced options.

### 1. Confirm Node.js and npm

Run:

```cmd
node --version
npm --version
```

`node --version` must report **v20.11+**, **v22.x**, or **v24.x**. If `node` or `npm` is not recognized, install a supported current Node.js release first, open a new terminal, and run the two commands again.

### 2. Install `antigyc`

#### Option A — use this repository right now

From the `antigravity-cli-npm` repository:

```cmd
npm install
npm run check
npm test
```

You can immediately verify the CLI without relying on PATH:

```cmd
node bin\agy.js --version
node bin\agy.js --help
```

To make the short `antigyc` command available from other folders:

```cmd
npm link
```

On Windows, if this is the first install/link on the machine, close that terminal and open **one new terminal** so it inherits any user-PATH update. Then verify:

```cmd
where antigyc
antigyc --version
```

If `antigyc` is still not found, do not get stuck on PATH. You can always run the repository entry point directly from the project you want to work on:

```cmd
cd C:\projects\my-app
node C:\path\to\antigravity-cli-npm\bin\agy.js
```

On macOS/Linux, the equivalent direct fallback is:

```bash
cd ~/projects/my-app
node /path/to/antigravity-cli-npm/bin/agy.js
```

#### Option B — after the package is published to npm

Global install:

```cmd
npm install -g antigyc
antigyc --version
```

Project-local install:

```cmd
npm install --save-dev antigyc
npx antigyc --version
```

On Windows, a first global install may require one new terminal before `antigyc` is found. The package adds npm's command directory only when missing; it does not reorder PATH entries.

> Use **`antigyc`**, not `agy`. This package deliberately does not export `agy` or `antigravity`, because Google's official Antigravity backend or another product may already own those names.

### 3. Google subscription authentication is already the default

For your Google/Gemini Pro subscription, do **not** set an API key and do **not** need to install Antigravity separately or run `antigyc login` first. Just start:

```cmd
antigyc
```

A fresh profile starts with `model=gemini-3.8-flash`, `reasoning=high`, `auth=google`, `turbo=off`, and `approval=ask`. On a new device, the first real request may open Google's official browser sign-in once. Sign in with the Google account that owns your Gemini/Google AI Pro subscription, complete browser consent, and return to the terminal; the original request continues automatically. Later sessions reuse the provider's secure account session.

To verify the defaults after login, run `status`. Gemini 3.8 Flash with high reasoning is the default. Use `model pro` only when you intentionally want the Pro alias; use `reasoning low` only when you intentionally want lower reasoning effort.

If you want to explicitly verify or renew the Google session:

```cmd
antigyc login
```

If you want direct Gemini API-key mode instead, set `GEMINI_API_KEY` first.

Windows CMD:

```cmd
set GEMINI_API_KEY=your_api_key_here
antigyc --auth api-key
```

PowerShell:

```powershell
$env:GEMINI_API_KEY="your_api_key_here"
antigyc --auth api-key
```

macOS/Linux:

```bash
export GEMINI_API_KEY="your_api_key_here"
antigyc --auth api-key
```

If a `GEMINI_API_KEY` is already present in your environment, `auth auto` prefers API-key mode. Use `antigyc --auth google` when you specifically want the Google subscription backend.

### 4. Open the project you actually want to work on

`antigyc` works in a Git repository **or** a normal folder. Change into the target folder first:

```cmd
cd C:\projects\my-app
antigyc
```

You should see only the normal current-directory prompt:

```text
antigyc C:\projects\my-app>
```

Do not start `antigyc` from the `antigravity-cli-npm` source repository unless that is the project you actually want the agent to modify.

### 5. Type a normal coding instruction

Examples:

```text
antigyc C:\projects\my-app> check this project and explain the important parts
antigyc C:\projects\my-app> find the cause of the failing tests and fix it
antigyc C:\projects\my-app> add validation to the signup endpoint and run the relevant tests
antigyc C:\projects\my-app> refactor this module without changing public behavior
```

For a request that takes more than a moment, you may briefly see one plain line such as `Preparing...`, `Inspecting...`, `Working...`, `Checking...`, or `Applying changes...`. It is erased before the final response.

### 6. Run these two checks if anything looks wrong

Inside `antigyc`:

```text
antigyc C:\projects\my-app> status
antigyc C:\projects\my-app> doctor
```

`status` shows the selected model/auth/approval state and whether the backend/account are ready. `doctor` checks Node/npm, command resolution, state-directory access, provider/account health, provider provenance, and basic network reachability.

### 7. Useful commands to know immediately

```text
help                    Show all commands
status                  Show current runtime/auth state
doctor                  Diagnose the local installation
model list              Show available models
model pro               Select/persist the pro alias
reasoning high          Request stronger reasoning
approval ask            Ask before direct API shell commands
approval yes            Allow autonomous command execution
turbo on                Persist trusted autonomous execution without repeated prompts
turbo off               Disable turbo mode
attach <path>           Attach a screenshot/document to the next request
history                  Show project conversation history
clear                    Clear project conversation state
task                     Show an interrupted task, if any
resume                   Resume an abnormally interrupted staged task
task clear               Discard an interrupted staged task
provider                 Show private Google backend/provenance state
provider update          Reinstall/update the managed Google backend safely
cwd                      Print the current directory
exit                     Exit
```

### 8. One-shot mode

Run one text message/instruction and exit:

```cmd
antigyc -m "check this project and summarize it"
```

`-p` / `--print` remains an equivalent one-shot form for compatibility.

Run autonomously in a project you trust:

```cmd
antigyc --turbo -p "fix the failing tests and run the relevant validation"
```

Inside interactive mode, `turbo on` persists the same trusted no-prompt execution preference for later launches. `approval ask` disables turbo again.

### 9. Packaged-tarball test before npm publication

To test the exact artifact npm would receive:

```cmd
npm pack
```

Then in another folder:

```cmd
mkdir C:\temp\antigyc-test
cd C:\temp\antigyc-test
npm init -y
npm install C:\path\to\antigravity-cli-npm\antigyc-0.1.2.tgz
npx antigyc --version
npx antigyc --help
npx antigyc
```

The public executable name is:

```text
antigyc
```

Git is optional. Git-aware operations are useful when Git exists, but the editing transaction itself is filesystem-based and works in ordinary folders too.

## Zero-setup Google account bootstrap

You do **not** need to install Antigravity separately or run `antigyc login` before using the CLI. npm `postinstall` pre-provisions and health-checks the official backend. Start `antigyc` normally and enter your first request. In Google mode, that request re-checks/repairs the backend if needed, checks the native Antigravity secure session, and starts the official browser sign-in flow only when that device actually needs authentication.

Google subscription mode now executes through Google's **official Antigravity CLI headless client**, rather than the older Gemini CLI / Code Assist client that rejects personal accounts. The provider binary is invoked by its absolute per-user path, with JSON output captured internally, so its TUI, progress stream, slash commands, banners, and tool narration do not appear inside this wrapper.

The package-managed official backend is deliberately kept out of normal command directories: `%LOCALAPPDATA%\antigravity-cli-npm\provider\agy.exe` on Windows, `~/Library/Application Support/antigravity-cli-npm/provider/agy` on macOS, and `${XDG_DATA_HOME:-~/.local/share}/antigravity-cli-npm/provider/agy` on Linux. `antigyc` reads Google's official platform release manifest, accepts release assets only from the official `antigravity-public/antigravity-cli` Google Storage bucket, verifies the downloaded package against the manifest's SHA-512 digest, and only then writes the private provider binary. The downloaded installer/bootstrap script is never executed, and provider installation does not alter PATH or create aliases. Managed installs record the manifest URL, release URL, release SHA-512, and installed-binary SHA-256 beside the binary. Before a managed provider is executed, its current digest must match that receipt; unrecorded or changed binaries are repaired transactionally, with the prior binary/receipt restored if replacement fails. Managed trust is revalidated on each use rather than cached by path. An explicit `ANTIGRAVITY_CLI_BINARY` override must be absolute, remains externally managed, and is health-checked but never silently installed, deleted, or updated by this package.

Authentication is persistent through the official Antigravity secure account session, including Windows Credential Manager on Windows. Normal `antigyc` requests probe that native session automatically and continue silently when it is already usable. On a first use on a new device/user profile, the wrapper starts the official Antigravity binary with no arguments inside a hidden pseudo-terminal rooted in an empty OS-temporary directory. The official client itself opens its Antigravity browser sign-in flow and writes its native secure-keyring session; all provider terminal rendering remains captured and invisible. As soon as the official session becomes usable, the hidden bootstrap process is stopped and `antigyc` performs one headless verification request before continuing the original request. There is no Gemini CLI/Code Assist OAuth fallback, no `oauth_creds.json`, and no credential-migration step.

Antigravity **IDE** is not required. The official Antigravity **CLI backend** is the supported Google subscription transport and is intentionally hidden behind this package's CMD-style interface.

### Agentic task execution

`antigyc` is designed to run multi-step coding tasks rather than behave like a single request/response chat. Broad tasks can begin with a compact project overview, discover likely project validation commands, navigate symbol definitions/references, apply focused multi-file patches, run native executables with structured argv when a shell is unnecessary, react to failed checks, revise the implementation, and validate again before returning the final response. Direct API mode allows up to 120 model/tool iterations per instruction, retries transient model-service failures automatically, preserves useful head/tail evidence while bounding large tool/file results, requires a successful post-edit verification pass, and detects repeated identical tool loops so the model is told to change strategy instead of wasting its entire step budget. Google subscription mode delegates the coding loop to the official Antigravity agent with equivalent instructions to continue through inspection, implementation, debugging, and validation rather than stopping at the first failure.

The execution remains transactional while doing this: all autonomous file changes and project commands operate on the disposable staging copy, and only the successful completed result is applied back to the real project.

In direct API-key mode, `run_command` and `run_process` are additionally placed inside an OS-level command sandbox. The sandbox process tree can write only to the disposable staged project and a disposable per-command temp/profile directory; ordinary host locations, including the real project, are not writable. Command execution fails closed when the platform sandbox is unavailable instead of falling back to an ordinary host process. The sandbox uses Seatbelt on macOS, bubblewrap on Linux, and a dedicated sandbox account plus Windows Filtering Platform/ACL boundaries on Windows.

Windows command sandboxing needs a one-time elevated machine setup before direct API command tools can run:

```cmd
npx @anthropic-ai/sandbox-runtime@0.0.75 windows-install
```

On Linux, install `bubblewrap`, `socat`, and `ripgrep`; on macOS, install `ripgrep` if it is not already available. `antigyc doctor` reports `command-sandbox=ok ready` when the required backend is usable. File-only agent work does not require this setup. The sandbox allows localhost and a conservative set of common developer package hosts by default; additional trusted destinations can be added from the launching user's environment with `AGYC_SANDBOX_NETWORK`.

Use the Google account associated with the subscription you want Antigravity to use. A brand-new device may still require you to approve Google's browser sign-in once because the provider's secure session is device-local; that is identity consent, not CLI setup. Afterward, normal restarts and projects reuse the session automatically. `antigyc login` remains available only as an explicit verification/renewal command. The wrapper never falls back to Gemini CLI or Code Assist authentication.

Some organization or Workspace environments may additionally require a Google Cloud project:

```cmd
set GOOGLE_CLOUD_PROJECT=your-project-id
```

After any required first-device browser consent completes, the original request continues and later use stays on the plain `antigyc` prompt.

## API-key authentication

Windows CMD:

```cmd
set GEMINI_API_KEY=your_api_key_here
antigyc --auth api-key
```

PowerShell:

```powershell
$env:GEMINI_API_KEY="your_api_key_here"
antigyc --auth api-key
```

macOS/Linux:

```bash
export GEMINI_API_KEY="your_api_key_here"
antigyc --auth api-key
```

Authentication modes:

```text
auth auto
auth google
auth api-key
```

`auto` selects `api-key` when `GEMINI_API_KEY` exists; otherwise it selects Google-account mode.

From the process command line:

```cmd
antigyc --auth google
antigyc --auth api-key
```

Fresh-profile default is already `google`. `ANTIGRAVITY_AUTH` is only needed when you intentionally want to override it:

```cmd
set ANTIGRAVITY_AUTH=google
```

## Interactive usage

Start in the project you want to modify:

```cmd
cd C:\projects\my-app
antigyc
```

Then type normal instructions:

```text
antigyc C:\projects\my-app> find the cause of the failing tests and fix it

Fixed the validation bug and the affected tests now pass.

antigyc C:\projects\my-app> add input validation to the signup endpoint

Added signup validation and updated the endpoint tests.

antigyc C:\projects\my-app>
```

There is no visible tool stream while the task is running. For requests that take more than a moment, `antigyc` uses one transient plain-text line with simple phases such as `Preparing... 1s`, `Inspecting... 4s`, `Working... 12s`, `Checking... 18s`, and `Applying changes... 21s`. It is not a spinner or progress UI: there are no colors, panels, tool names, model names, reasoning labels, or animations. The line pauses during permission prompts and is erased before the final response or error appears. Pressing Ctrl+C during active work cancels the whole current request—not only a child command—including first-use Google provider setup, browser sign-in polling, subscription verification, the provider call, and any active project command. The canceled turn is not appended to conversation history, staged work is discarded/rolled back, and the interactive shell returns `Canceled.` while keeping earlier conversation turns available.

## One-shot usage

Run one text message/instruction and exit:

```cmd
antigyc -m "find the bug and fix it"
```

`-p` / `--print` remains an equivalent one-shot form for compatibility.

With options:

```cmd
antigyc --model pro --reasoning high -p "implement the feature and run the tests"
```

The same hidden transaction is used in one-shot mode.

## Commands

All interactive controls are ordinary text commands at the same project prompt.

### Help

```text
antigyc C:\project> help
```

### Status

```text
antigyc C:\project> status
model=gemini-3.8-flash reasoning=high auth=google approval=ask turbo=off backend=ready account=connected attachments=0 history=0
```

`status` is deliberately terse. It is not shown automatically. In Google mode it performs hidden provider health/account probes; in API-key mode it reports whether the key is configured. It also reports `task=pending` when an abnormal prior termination left resumable staged work.

### Doctor, provider, and interrupted tasks

```text
antigyc C:\project> doctor
antigyc C:\project> provider
antigyc C:\project> provider update
antigyc C:\project> task
antigyc C:\project> task clear
antigyc C:\project> resume
```

`doctor` prints plain `name=ok|warn|fail` health lines for the wrapper version, Node/npm, workspace/state writability, command resolution, Google backend/account state, provider provenance, and basic network reachability. `provider` reports the private backend status; `provider update` reinstalls a managed backend through the official manifest + SHA-512 release flow with post-install validation and rollback. `task` reports whether a crash checkpoint exists. `resume` accepts only a physically valid, current-user OS-temp staging container with a validated baseline manifest, verifies that the real-project baseline is still unchanged, and rechecks affected paths again immediately before publication. `task clear` deliberately deletes both the checkpoint and its temporary staged copy.

### Current directory

```text
antigyc C:\project> cwd
C:\project
```

### Clear terminal

```text
antigyc C:\project> cls
```

### Exit

```text
antigyc C:\project> exit
```

`quit` is accepted as an exit alias.

## Model selection

Show the current model:

```text
antigyc C:\project> model
auto
```

Discover available choices:

```text
antigyc C:\project> model list
auto
pro
flash
flash-lite
<models from Google's public catalog and the installed provider catalog>
```

`model list` is discovery-backed rather than a hard-coded release list. In Google subscription mode, `antigyc` first runs the official Antigravity backend's `models` command with all provider progress captured. That makes the list reflect models actually offered to the signed-in subscription. Effort-specific provider slugs such as `gemini-3.8-flash-high` are normalized to the base model `gemini-3.8-flash`, because this wrapper keeps reasoning effort as a separate `reasoning` setting.

If official subscription discovery is unavailable, `antigyc` falls back to Google's public Gemini model documentation. In API-key mode, it uses the live Gemini `/models` endpoint and keeps models that support `generateContent`. The short names `auto`, `pro`, `flash`, and `flash-lite` remain convenience choices and resolve dynamically to the newest matching model available through the active provider; an unavailable alias fails clearly instead of silently selecting another model.

Change the model silently:

```text
antigyc C:\project> model pro
antigyc C:\project>
```

Concrete provider model names may also be supplied:

```text
antigyc C:\project> model gemini-3.1-pro-preview
```

Process option:

```cmd
antigyc --model pro
```

Environment default:

```cmd
set ANTIGRAVITY_MODEL=pro
```

## Reasoning effort

Reasoning controls affect provider thinking configuration without exposing model thoughts.

Show the current setting:

```text
antigyc C:\project> reasoning
auto
```

Choices:

```text
antigyc C:\project> reasoning list
auto
low
high
```

Set it:

```text
antigyc C:\project> reasoning high
antigyc C:\project>
```

Interactive changes to `model`, `reasoning`, `auth`, and `approval` are persisted globally under the external state root and reused in later `antigyc` processes. Command-line flags and environment variables can still override those saved defaults for a specific launch.

Meaning:

- `auto` — leave thinking behavior to the selected provider/model.
- `low` — request a smaller reasoning budget/level where supported.
- `high` — request a larger reasoning budget/level where supported.

Thoughts and chain-of-thought are never printed in normal terminal output or stored in the conversation history maintained by this wrapper.

Process option:

```cmd
antigyc --reasoning high
```

Environment default:

```cmd
set ANTIGRAVITY_REASONING=high
```

## Turbo mode and command approval

Turbo mode and no-prompt autonomous command execution are enabled by default on a fresh profile:

```text
antigyc C:\project> turbo on
antigyc C:\project>
```

Check or disable it with `turbo` / `turbo off`. Turning turbo off also restores `approval ask`. One-shot equivalent:

```cmd
antigyc --turbo -p "finish the task, run the checks, and fix failures"
```

Turbo mode implies command approval `yes` for the launch. `--no-turbo` explicitly restores approval prompts for that launch even if turbo was previously persisted. Turbo does not remove the wrapper's transactional staging, conflict detection, cancellation rollback, or project-file path protections in direct API mode. The Google backend keeps using the existing trusted `yes` behavior, which removes its terminal sandbox while the wrapper still stages project publication.

Show the current approval mode:

```text
antigyc C:\project> approval
ask
```

Choices:

```text
antigyc C:\project> approval list
ask
yes
```

Fresh-profile default:

```text
antigyc C:\project> approval
yes
antigyc C:\project> turbo
on
```

Use `approval yes` or `turbo on` only when you intentionally want autonomous command execution without prompts.

Autonomous mode:

```text
antigyc C:\project> approval yes
```

or at startup:

```cmd
antigyc --yes
```

In direct API-key mode, `ask` requires confirmation before shell commands. In Google-account mode, the provider's print/headless path cannot surface interactive permission prompts. Normal `ask` therefore auto-permits provider tools **inside Antigravity's terminal sandbox and the wrapper's private staging copy**; `yes` removes the provider sandbox while retaining the wrapper's staging transaction.

`--yes` should still be used deliberately: staging prevents partial project-source publication, but a shell command can have effects outside the project if the command itself targets external resources.

## Attach an image or document

Attachments are queued for the **next** ordinary instruction.

```text
antigyc C:\project> attach screenshot.png
antigyc C:\project> attach requirements.pdf
antigyc C:\project> attach notes.md
antigyc C:\project> implement the change described in these files
```

Successful `attach` commands produce no confirmation line.

Inspect pending attachments:

```text
antigyc C:\project> attach
C:\project\screenshot.png
C:\project\requirements.pdf
C:\project\notes.md
```

`attach list` is equivalent:

```text
antigyc C:\project> attach list
```

Clear the queue:

```text
antigyc C:\project> attach clear
```

After a successful user instruction, the queued attachments are consumed and the queue returns to empty.

### Supported attachment types

Current first-class attachment support:

- common images: PNG, JPEG, WEBP, GIF, BMP, TIFF, SVG;
- PDF documents;
- Office Open XML documents: DOCX, XLSX, PPTX;
- text/code/configuration documents, including Markdown, TXT, JSON, CSV, HTML, XML, YAML, TOML, INI, SQL, CSS, JavaScript/TypeScript, Python, Java, C/C++, Go, Rust, shell scripts, PowerShell, BAT/CMD, and other files detected as text.

Images and PDFs are supplied as multimodal content where the provider supports it. Text/code documents are injected as text. DOCX/XLSX/PPTX are parsed in memory as bounded Open XML ZIP containers; readable document/sheet/slide text is extracted without unpacking the archive into the project. The Google headless backend receives a temporary text representation outside the project, while direct API mode receives the extracted text directly.

### Attachment limits

- Maximum per attachment: 20 MB.
- Direct API-key mode: maximum combined attachment payload of 20 MB per request.
- Attachment source may be inside or outside the project.
- Temporary attachment copies are created in OS-temporary storage outside the project and deleted with the staging session.
- Attachments are not copied into the real project unless the user explicitly asks the agent to create a project file from their content.

### Attachments in one-shot mode

`--attach` is repeatable:

```cmd
antigyc --attach screenshot.png --attach requirements.pdf -p "fix the UI according to these files"
```

Paths containing spaces can be quoted:

```cmd
antigyc --attach "C:\docs\feature spec.pdf" -p "implement this"
```

Interactive equivalent:

```text
antigyc C:\project> attach "C:\docs\feature spec.pdf"
```

## Conversation history

Conversation history persists across `antigyc` restarts for each project directory.

It is stored **outside** the repository. Default state root:

```text
%USERPROFILE%\.antigravity-cli\
```

Global preferences are stored at `%USERPROFILE%\.antigravity-cli\settings.json` by default. History files live below:

```text
%USERPROFILE%\.antigravity-cli\history\
```

Each project is mapped to a stable hashed history filename.

Show conversation history only when requested:

```text
antigyc C:\project> history
```

Show the exact external history path:

```text
antigyc C:\project> history path
C:\Users\you\.antigravity-cli\history\<project-key>.json
```

Clear it:

```text
antigyc C:\project> history clear
```

The general `clear` command also clears persisted conversation history and pending attachments for the current project:

```text
antigyc C:\project> clear
```

History stores user messages, final replies, timestamps, and minimal attachment metadata (display name, MIME type, and kind). Original attachment filesystem paths are not persisted. Model-facing history is additionally bounded by a UTF-8 byte budget so a long project conversation cannot consume unbounded request context. It does not store internal reasoning or the tool-by-tool execution stream.

### Relocate external state

Set `ANTIGRAVITY_HOME` before starting `antigyc`:

```cmd
set ANTIGRAVITY_HOME=D:\private\agy-state
antigyc
```

No history database is placed inside the project unless you explicitly point `ANTIGRAVITY_HOME` there yourself.

## Hidden transactional editing

Every coding instruction is handled as a transaction.

Conceptually:

```text
real project
    |
    | snapshot/copy
    v
OS temporary staging directory
    |
    | read / edit / test / build
    | intermediate states stay here
    v
completed staged state
    |
    | conflict check
    v
real project receives final changed files
    |
    v
final reply is printed
```

### While the agent is working

The real project stays unchanged. This means editors, file watchers, Git status, and other processes watching the real directory do not see every intermediate edit.

### On success

The wrapper compares the final staging state with the original snapshot and applies only the completed file changes to the real project.

### On model/tool failure or cancellation

The staging changes are discarded. Ctrl+C propagates into provider/API requests and shell commands where supported. If cancellation occurs during publication, the rollback path restores affected real files. The real project remains at its previous state.

### On abnormal process termination

Before autonomous work begins, `antigyc` records a small project-scoped checkpoint outside the repository that points to the OS-temporary staged transaction. A normal success, handled failure, or Ctrl+C removes that checkpoint and staging directory. If the process is killed or crashes before cleanup runs, the checkpoint may remain. `antigyc resume` reopens that exact staged copy, verifies that the real project still matches the original baseline, and continues the original request; if the baseline changed, resume refuses to publish. `antigyc task clear` discards the interrupted state without touching the real project.

### On concurrent external edits

Before publishing a changed path, the wrapper verifies that the real path still matches the baseline captured at the beginning of the instruction. If another process changed that path, publication is refused instead of silently overwriting the external change.

### Rollback during publication

The wrapper keeps a temporary rollback copy of affected real paths while publishing the final state. If publication itself fails partway through, it attempts to restore the prior paths.

## Git behavior

Git is **not required**.

### Non-Git project

This works:

```cmd
mkdir C:\projects\scratch-app
cd C:\projects\scratch-app
antigyc
```

No `git init` is performed and no `.git` directory is created by `antigyc`.

### Existing Git repository

When `.git` is a normal directory, it is copied into the disposable staging workspace so Git-aware commands can inspect the staged project naturally. However `.git` is excluded from final publication. If `.git` is a pointer file (as in linked worktrees and some submodules), that live pointer is never retained in staging; the wrapper removes it and creates isolated disposable Git metadata when Git is available. This prevents staged commands from following the pointer into the real repository's external Git metadata.

Therefore Git mutations made by the agent inside the disposable copy—such as temporary commits, branch changes, index changes, or stash operations—do not replace the real repository metadata.

The wrapper itself does not create in the real project:

- commits;
- branches;
- worktrees;
- stash entries;
- patch files;
- AI metadata directories;
- provider settings directories;
- conversation databases.

Git in the real project sees only the final filesystem changes published after a successful instruction.

If **you** later run `git add` and `git commit`, that final source diff naturally becomes part of your normal Git history. The intermediate AI editing sequence does not.

### `.gemini` and `node_modules`

`.gemini`, `.agents`, `.git`, and `node_modules` are excluded from staging publication. Provider/session metadata and dependency-cache mutations in the temporary copy do not replace those directories in the real project.

## What the agent can do

Depending on provider permissions and approval mode, the agent can:

- inspect project files and directory structure;
- search source text and find likely symbol definitions/references;
- discover likely authoritative test/build/lint/type-check commands from project manifests;
- create files;
- replace/edit file content and apply coordinated exact multi-file patches;
- delete project paths;
- run native executables with structured argument arrays, or shell commands when shell syntax is actually required;
- run tests, builds, linters, formatters, and type checks;
- inspect Git diffs when Git is available;
- use attached screenshots/images and documents as task context;
- carry conversation context across restarts.

The direct API-key implementation constrains its built-in file tools to the current project path, including checks against path traversal and symlink escape.

## CLI options

```text
antigyc
antigyc doctor
antigyc login
antigyc provider [status|update]
antigyc resume
antigyc task [clear]
antigyc init
antigyc -m <message>
antigyc -p <prompt>
antigyc --attach <path>
antigyc --yes
antigyc --turbo
antigyc --no-turbo
antigyc --auth auto|google|api-key
antigyc --model <name>
antigyc --reasoning auto|low|high
antigyc --base-url <url>
antigyc --help
antigyc --version
```

Short forms:

```text
-m  --message
-p  --print
-M  --model
-y  --yes
-h  --help
-v  --version
```

`--base-url` is mainly for the direct API-key provider and development/testing against a compatible Gemini endpoint.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Direct Gemini API-key authentication. |
| `ANTIGRAVITY_AUTH` | Default auth mode: `auto`, `google`, or `api-key`. |
| `ANTIGRAVITY_MODEL` | Default model/model alias. |
| `ANTIGRAVITY_REASONING` | Default reasoning mode: `auto`, `low`, or `high`. |
| `ANTIGRAVITY_HOME` | External state root for persistent preferences and conversation history. |
| `GEMINI_BASE_URL` | Base URL for direct API-key mode. |
| `GOOGLE_CLOUD_PROJECT` | Optional/required for some organization or Workspace Google-account environments. |
| `ANTIGRAVITY_CLI_BINARY` | Optional absolute path override for the official Google Antigravity CLI backend. |
| `AGYC_PASSTHROUGH_ENV` | Optional comma/space-separated environment-variable names to expose to project/provider subprocesses when they would otherwise be filtered as secret-like. |
| `AGYC_SANDBOX_NETWORK` | Optional comma/space-separated additional domains allowed for direct API command subprocesses. The built-in list covers localhost and common package/repository hosts. |
| `AGYC_SKIP_PROVIDER_INSTALL` | Optional opt-out (`1`, `true`, `yes`, `on`) for npm-time provider preinstall; Google mode will still bootstrap on first use. |
| `AGYC_SKIP_PATH_SETUP` | Optional Windows install/CI opt-out for automatic user-PATH mutation. |

## Typical workflows

### Fix a failing test

```text
antigyc C:\project> fix the failing tests and run the relevant test suite
```

### Implement from a screenshot

```text
antigyc C:\project> attach C:\designs\checkout.png
antigyc C:\project> recreate this checkout behavior using the existing components
```

### Implement from a PDF specification

```text
antigyc C:\project> attach C:\specs\api-requirements.pdf
antigyc C:\project> implement the required endpoint changes and tests
```

### Continue work tomorrow

```cmd
cd C:\projects\my-app
antigyc
```

The project-scoped external conversation history is loaded automatically.

### Start with a clean conversation

```text
antigyc C:\project> clear
```

### Use stronger reasoning for one session

```cmd
antigyc --reasoning high --model pro
```

### Run autonomously in a trusted local project

```cmd
antigyc --yes -p "apply the refactor and run all tests"
```

## Failure behavior

Expected failure behavior is conservative:

- invalid attachment path -> request does not run;
- unsupported attachment -> request does not run;
- model/API error -> staged project changes and the task checkpoint are discarded;
- Ctrl+C during active work -> request is canceled and staged changes/checkpoint are discarded/rolled back;
- abnormal process termination -> staged work may remain resumable outside the project; a new task is blocked until `resume` or `task clear`;
- command denial -> command is reported to the model as denied;
- external concurrent edit to a path the agent wants to publish -> publication is refused;
- invalid history JSON -> explicit history error rather than silently replacing it;
- no Git repository -> normal filesystem operation continues; Git-specific commands may simply report that Git is unavailable.

## Privacy and visibility boundaries

The runtime goal is visual invisibility, not deception.

Normal terminal output hides:

- chain-of-thought/reasoning traces;
- provider plumbing;
- tool-by-tool execution;
- intermediate file edits;
- staging paths;
- automatic state persistence.

Normal terminal output may show:

- your project prompt;
- final model response;
- one transient plain task-phase line while work is active;
- explicit `status`, `doctor`, `provider`, `task`, `history`, `attach`, model/auth/reasoning queries;
- real errors;
- permission prompts required for safe execution;
- the official provider authentication UI while logging in.

Documentation is explicit that the command uses AI/Gemini; the shell-like appearance is an interface choice, not an attempt to represent the software as human.

## Safety notes

Hidden staging protects the project from partial source publication. In direct API-key mode, shell/process tools also run inside the OS-level command sandbox described above, which fails closed and restricts filesystem writes to the staged project plus disposable command scratch space. Network destinations are separately allowlisted, and secret-like environment variables stay filtered unless the launching user explicitly opts them in.

`approval yes` and turbo mode skip the interactive approval question; they do **not** disable the direct API command sandbox. Google subscription mode uses the official provider's own sandbox in normal `approval ask` operation; explicit Google `approval yes` retains its separately documented provider behavior and should be used only for trusted tasks.

Keep important work backed up or under version control even though Git is not required.

## Development and validation

Install dependencies:

```cmd
npm install
```

Syntax validation:

```cmd
npm run check
```

Test suite:

```cmd
npm test
```

Package preview:

```cmd
npm pack --dry-run
```

Release guard:

```cmd
npm run prepublishOnly
```

The test suite covers project-bound file tooling, argv process execution, validation discovery, symbol/reference navigation, atomic multi-file patching, command approval/cancellation, transient activity phases, reasoning and dynamic model aliases, persistent external settings/history, resumable crash checkpoints, image/PDF/Office/text attachments, bounded Office ZIP parsing, hidden staging publication and rollback, conflict detection, normal and pointer-file Git metadata isolation, provider provenance/update rollback, doctor diagnostics, explicit project init, and full one-shot CLI behavior in non-Git folders using a local fake Gemini endpoint. GitHub Actions also exercises Windows, macOS, and Linux on Node 20 and 22 with provider/PATH install side effects disabled in CI.

## Package layout

```text
bin/agy.js              executable entry point
src/cli.js              CMD-style shell and command routing
src/agent.js            direct Gemini API-key coding agent
src/google-agent.js     Google subscription wrapper using official Antigravity headless backend
src/tools.js            built-in project file and command tools
src/staging.js          hidden transactional staging/publish layer
src/attachments.js      attachment validation, Office extraction, multimodal preparation
src/cancel.js           cancellation helpers and exit-code semantics
src/history.js          external project-scoped conversation persistence
src/settings.js         external persistent user preferences
src/task-state.js       external interrupted-task checkpoint persistence
src/doctor.js           plain installation/runtime diagnostics
src/init.js             explicit optional project-instructions initializer
scripts/setup-path.js    one-time Windows npm PATH bootstrap
scripts/postinstall.js   npm-time official backend pre-provisioning
test/                   automated tests
AGENTS.md                implementation invariants for future changes
```

## Before publishing to npm

Recommended local release verification:

```cmd
npm ci
npm run release:check
npm run release:publish-check
```

`release:check` runs reusable repository validation: syntax checks, the full test suite, a moderate-or-higher vulnerability audit, and a package dry-run. It remains valid even after the current package version has already been published. `release:publish-check` is separate because npm correctly rejects a publish dry-run when that exact version already exists; run it only for a new version before publishing.

Before the real publish, verify `npm whoami` succeeds for the intended npm account. Then inspect the package contents and only publish when the package name, metadata, license, account, and two-factor/token policy are ready. This package is configured as MIT licensed and includes `LICENSE` in the published files. Its npm metadata points to the GitHub repository, issue tracker, and README homepage.

This repository is currently configured with version `0.1.2` and `publishConfig.access = public`. Publication is a separate explicit step; running the commands above does not publish anything.

## Troubleshooting

### `antigyc` is not recognized / command not found

First confirm Node/npm work:

```cmd
node --version
npm --version
```

If you are using this repository directly, run:

```cmd
cd C:\path\to\antigravity-cli-npm
npm install
npm link
```

On Windows, open one new terminal after the first link/install, then check:

```cmd
where antigyc
antigyc --version
```

PowerShell equivalent:

```powershell
Get-Command antigyc
antigyc --version
```

If PATH is still wrong, bypass it completely. Change to the project you want to work on and run the CLI by absolute path:

```cmd
cd C:\projects\my-app
node C:\path\to\antigravity-cli-npm\bin\agy.js
```

The source file is still named `bin/agy.js`; the **public command is `antigyc`**. Do not rename or depend on a public `agy` command.

### I accidentally ran `agy` instead of `antigyc`

`agy` is not exported by this package. It may belong to Google's official Antigravity CLI or another installed product. Run:

```cmd
antigyc --version
```

and use `antigyc` for this npm wrapper.

### `Missing GEMINI_API_KEY`

You forced API-key mode without setting the key.

Either:

```cmd
set GEMINI_API_KEY=your_key
antigyc --auth api-key
```

or switch back to Google mode:

```cmd
antigyc --auth google
```

Google mode does not require a separate Antigravity install or login command. npm installation pre-provisions the official backend; your first normal request automatically repairs/retries that backend if necessary and opens the official browser sign-in only when the native secure session is missing. Once approved on that device, later requests and restarts reuse the secure session silently. The wrapper does not create or read Gemini CLI `oauth_creds.json` credentials.

### Google browser sign-in appears on a new device

This is expected once per device/user profile when the official Antigravity keyring has no usable session. Finish the provider's browser consent and the original `antigyc` request continues automatically. No additional CLI command is required.

### The target folder has no `.git`

That is supported. No action is needed.

### Git-specific output fails in a non-Git folder

The core CLI still works. Only the Git-specific operation lacks a repository to inspect.

### I do not see intermediate edits

That is intentional. The real project is only updated after a successful instruction finishes.

### An external edit caused a conflict

Re-run the instruction after reviewing the external change. The wrapper refuses to overwrite a changed baseline path automatically.

### `An interrupted task is available`

A previous `antigyc` process ended abnormally after its staged transaction was prepared. Inspect it with `antigyc task`, continue it with `antigyc resume`, or deliberately discard it with `antigyc task clear`. Resume validates the original real-project baseline before publishing anything.

### Provider provenance is `unrecorded` or `changed`

`unrecorded` means the managed binary predates the provenance receipt. `changed` means its current SHA-256 no longer matches the recorded managed-binary digest. Normal managed-provider use repairs either state before executing the provider, and the repair rolls back if the replacement cannot be verified and health-checked. `antigyc provider update` performs the same transactional replacement explicitly. An `ANTIGRAVITY_CLI_BINARY` override must be an absolute path, is treated as external, and is never installed or updated by this package.

### Where is conversation history stored?

Inside `ANTIGRAVITY_HOME\history` if configured; otherwise below your home directory in `.antigravity-cli\history`.

Use:

```text
antigyc C:\project> history path
```

### How do I erase project conversation history?

```text
antigyc C:\project> history clear
```

or:

```text
antigyc C:\project> clear
```

## License

MIT. See `LICENSE`.
