# Antigravity CLI for npm

A coding agent that looks and behaves like a normal command prompt.

`agyc` intentionally has no AI-style terminal interface: no startup banner, cards, panels, animated spinner, tool-call stream, model badge, reasoning display, assistant label, or live edit animation. Normal interactive startup is simply:

```text
C:\projects\my-app>
```

The agent works behind that prompt. It performs project edits in a private OS-temporary copy and publishes the completed file state only after the instruction succeeds.

> This repository is an npm implementation. It is not the proprietary Google Antigravity CLI binary.

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

- Node.js 20 or newer.
- npm.
- One authentication method:
  - a Google/Gemini subscription account through Google's official Antigravity CLI backend, or
  - a Gemini API key in `GEMINI_API_KEY`.

For Google subscription mode, `agyc` uses the official Antigravity CLI only as a hidden headless backend. A normal npm install pre-provisions that backend into a private per-user data location, even when the machine has no Antigravity installation. The provider binary is never added to PATH and never claims this package's `agyc` command. If pre-provisioning was temporarily offline, the first Google request retries the same bootstrap automatically.

## Start here: first use in 5 minutes

If you only want to get `agyc` working, follow this section in order. You do not need to understand the provider internals first.

### 1. Confirm Node.js and npm

Run:

```cmd
node --version
npm --version
```

`node --version` must report **v20 or newer**. If `node` or `npm` is not recognized, install a current Node.js 20+ release first, open a new terminal, and run the two commands again.

### 2. Install `agyc`

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

To make the short `agyc` command available from other folders:

```cmd
npm link
```

On Windows, if this is the first install/link on the machine, close that terminal and open **one new terminal** so it inherits any user-PATH update. Then verify:

```cmd
where agyc
agyc --version
```

If `agyc` is still not found, do not get stuck on PATH. You can always run the repository entry point directly from the project you want to work on:

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
npm install -g antigravity-cli-npm
agyc --version
```

Project-local install:

```cmd
npm install --save-dev antigravity-cli-npm
npx agyc --version
```

On Windows, a first global install may require one new terminal before `agyc` is found. The package adds npm's command directory only when missing; it does not reorder PATH entries.

> Use **`agyc`**, not `agy`. This package deliberately does not export `agy` or `antigravity`, because Google's official Antigravity backend or another product may already own those names.

### 3. Choose authentication

For most users with a Google/Gemini subscription, use Google mode. You do **not** need to install Antigravity separately and you do **not** need to run `agyc login` first.

```cmd
agyc --auth google
```

Then enter a normal request. On a new device, the first request may open Google's official browser sign-in once. Complete the browser consent and return to the terminal; the original request continues automatically. Later sessions reuse the provider's secure account session.

If you want to explicitly verify or renew the Google session:

```cmd
agyc login
```

If you want direct Gemini API-key mode instead, set `GEMINI_API_KEY` first.

Windows CMD:

```cmd
set GEMINI_API_KEY=your_api_key_here
agyc --auth api-key
```

PowerShell:

```powershell
$env:GEMINI_API_KEY="your_api_key_here"
agyc --auth api-key
```

macOS/Linux:

```bash
export GEMINI_API_KEY="your_api_key_here"
agyc --auth api-key
```

If a `GEMINI_API_KEY` is already present in your environment, `auth auto` prefers API-key mode. Use `agyc --auth google` when you specifically want the Google subscription backend.

### 4. Open the project you actually want to work on

`agyc` works in a Git repository **or** a normal folder. Change into the target folder first:

```cmd
cd C:\projects\my-app
agyc
```

You should see only the normal current-directory prompt:

```text
C:\projects\my-app>
```

Do not start `agyc` from the `antigravity-cli-npm` source repository unless that is the project you actually want the agent to modify.

### 5. Type a normal coding instruction

Examples:

```text
C:\projects\my-app> check this project and explain the important parts
C:\projects\my-app> find the cause of the failing tests and fix it
C:\projects\my-app> add validation to the signup endpoint and run the relevant tests
C:\projects\my-app> refactor this module without changing public behavior
```

For a request that takes more than a moment, you may briefly see one plain line such as `Preparing...`, `Inspecting...`, `Working...`, `Checking...`, or `Applying changes...`. It is erased before the final response.

### 6. Run these two checks if anything looks wrong

Inside `agyc`:

```text
C:\projects\my-app> status
C:\projects\my-app> doctor
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

Run one instruction and exit:

```cmd
agyc -p "check this project and summarize it"
```

Run autonomously in a project you trust:

```cmd
agyc --yes -p "fix the failing tests and run the relevant validation"
```

### 9. Packaged-tarball test before npm publication

To test the exact artifact npm would receive:

```cmd
npm pack
```

Then in another folder:

```cmd
mkdir C:\temp\agyc-test
cd C:\temp\agyc-test
npm init -y
npm install C:\path\to\antigravity-cli-npm\antigravity-cli-npm-0.1.0.tgz
npx agyc --version
npx agyc --help
npx agyc
```

The public executable names are:

```text
agyc
antigravity-cli-npm
```

Git is optional. Git-aware operations are useful when Git exists, but the editing transaction itself is filesystem-based and works in ordinary folders too.

## Zero-setup Google account bootstrap

You do **not** need to install Antigravity separately or run `agyc login` before using the CLI. npm `postinstall` pre-provisions and health-checks the official backend. Start `agyc` normally and enter your first request. In Google mode, that request re-checks/repairs the backend if needed, checks the native Antigravity secure session, and starts the official browser sign-in flow only when that device actually needs authentication.

Google subscription mode now executes through Google's **official Antigravity CLI headless client**, rather than the older Gemini CLI / Code Assist client that rejects personal accounts. The provider binary is invoked by its absolute per-user path, with JSON output captured internally, so its TUI, progress stream, slash commands, banners, and tool narration do not appear inside this wrapper.

The package-managed official backend is deliberately kept out of normal command directories: `%LOCALAPPDATA%\antigravity-cli-npm\provider\agy.exe` on Windows, `~/Library/Application Support/antigravity-cli-npm/provider/agy` on macOS, and `${XDG_DATA_HOME:-~/.local/share}/antigravity-cli-npm/provider/agy` on Linux. `agyc` installs it from Google's official HTTPS installer using `--skip-path --skip-aliases` and invokes it only by absolute path, so the provider binary cannot take over this package's command name. Managed installs record an external provenance receipt beside the binary with the official installer URL plus SHA-256 hashes of the fetched installer and installed binary. `provider`/`doctor` can detect an unrecorded or changed binary, and `provider update` performs a fresh official install, health-checks it, records the new receipt, and restores the previous managed binary if validation fails. An explicit `ANTIGRAVITY_CLI_BINARY` override remains externally managed and is never silently deleted or updated.

Authentication is persistent through the official Antigravity secure account session, including Windows Credential Manager on Windows. Normal `agyc` requests probe that native session automatically and continue silently when it is already usable. On a first use on a new device/user profile, the wrapper starts the official Antigravity binary with no arguments inside a hidden pseudo-terminal rooted in an empty OS-temporary directory. The official client itself opens its Antigravity browser sign-in flow and writes its native secure-keyring session; all provider terminal rendering remains captured and invisible. As soon as the official session becomes usable, the hidden bootstrap process is stopped and `agyc` performs one headless verification request before continuing the original request. There is no Gemini CLI/Code Assist OAuth fallback, no `oauth_creds.json`, and no credential-migration step.

Antigravity **IDE** is not required. The official Antigravity **CLI backend** is the supported Google subscription transport and is intentionally hidden behind this package's CMD-style interface.

### Agentic task execution

`agyc` is designed to run multi-step coding tasks rather than behave like a single request/response chat. Broad tasks can begin with a compact project overview, discover likely project validation commands, navigate symbol definitions/references, apply focused multi-file patches, run native executables with structured argv when a shell is unnecessary, react to failed checks, revise the implementation, and validate again before returning the final response. Direct API mode allows up to 60 model/tool iterations per instruction, retries transient model-service failures automatically, preserves useful head/tail evidence while bounding large tool/file results, requires a successful post-edit verification pass, and detects repeated identical tool loops so the model is told to change strategy instead of wasting its entire step budget. Google subscription mode delegates the coding loop to the official Antigravity agent with equivalent instructions to continue through inspection, implementation, debugging, and validation rather than stopping at the first failure.

The execution remains transactional while doing this: all autonomous file changes and project commands operate on the disposable staging copy, and only the successful completed result is applied back to the real project.

Use the Google account associated with the subscription you want Antigravity to use. A brand-new device may still require you to approve Google's browser sign-in once because the provider's secure session is device-local; that is identity consent, not CLI setup. Afterward, normal restarts and projects reuse the session automatically. `agyc login` remains available only as an explicit verification/renewal command. The wrapper never falls back to Gemini CLI or Code Assist authentication.

Some organization or Workspace environments may additionally require a Google Cloud project:

```cmd
set GOOGLE_CLOUD_PROJECT=your-project-id
```

After any required first-device browser consent completes, the original request continues and later use stays on the plain `agyc` prompt.

## API-key authentication

Windows CMD:

```cmd
set GEMINI_API_KEY=your_api_key_here
agyc --auth api-key
```

PowerShell:

```powershell
$env:GEMINI_API_KEY="your_api_key_here"
agyc --auth api-key
```

macOS/Linux:

```bash
export GEMINI_API_KEY="your_api_key_here"
agyc --auth api-key
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
agyc --auth google
agyc --auth api-key
```

Environment default:

```cmd
set ANTIGRAVITY_AUTH=google
```

## Interactive usage

Start in the project you want to modify:

```cmd
cd C:\projects\my-app
agyc
```

Then type normal instructions:

```text
C:\projects\my-app> find the cause of the failing tests and fix it

Fixed the validation bug and the affected tests now pass.

C:\projects\my-app> add input validation to the signup endpoint

Added signup validation and updated the endpoint tests.

C:\projects\my-app>
```

There is no visible tool stream while the task is running. For requests that take more than a moment, `agyc` uses one transient plain-text line with simple phases such as `Preparing... 1s`, `Inspecting... 4s`, `Working... 12s`, `Checking... 18s`, and `Applying changes... 21s`. It is not a spinner or progress UI: there are no colors, panels, tool names, model names, reasoning labels, or animations. The line pauses during permission prompts and is erased before the final response or error appears. Pressing Ctrl+C during active work cancels the request, discards/rolls back staged publication, and returns `Canceled.` without publishing a partial project state.

## One-shot usage

Run one instruction and exit:

```cmd
agyc -p "find the bug and fix it"
```

With options:

```cmd
agyc --model pro --reasoning high --yes -p "implement the feature and run the tests"
```

The same hidden transaction is used in one-shot mode.

## Commands

All interactive controls are ordinary text commands at the same project prompt.

### Help

```text
C:\project> help
```

### Status

```text
C:\project> status
model=auto reasoning=auto auth=google approval=ask backend=ready account=connected attachments=0 history=0
```

`status` is deliberately terse. It is not shown automatically. In Google mode it performs hidden provider health/account probes; in API-key mode it reports whether the key is configured. It also reports `task=pending` when an abnormal prior termination left resumable staged work.

### Doctor, provider, and interrupted tasks

```text
C:\project> doctor
C:\project> provider
C:\project> provider update
C:\project> task
C:\project> task clear
C:\project> resume
```

`doctor` prints plain `name=ok|warn|fail` health lines for the wrapper version, Node/npm, workspace/state writability, command resolution, Google backend/account state, provider provenance, and basic network reachability. `provider` reports the private backend status; `provider update` reinstalls a managed backend from the official installer with post-install validation and rollback. `task` reports whether a crash checkpoint exists, `resume` continues it only if the real-project baseline is still unchanged, and `task clear` deliberately deletes both the checkpoint and its temporary staged copy.

### Current directory

```text
C:\project> cwd
C:\project
```

### Clear terminal

```text
C:\project> cls
```

### Exit

```text
C:\project> exit
```

`quit` is accepted as an exit alias.

## Model selection

Show the current model:

```text
C:\project> model
auto
```

Discover available choices:

```text
C:\project> model list
auto
pro
flash
flash-lite
<models from Google's public catalog and the installed provider catalog>
```

`model list` is discovery-backed rather than a hard-coded release list. In Google subscription mode, `agyc` first runs the official Antigravity backend's `models` command with all provider progress captured. That makes the list reflect models actually offered to the signed-in subscription. Effort-specific provider slugs such as `gemini-3.8-flash-high` are normalized to the base model `gemini-3.8-flash`, because this wrapper keeps reasoning effort as a separate `reasoning` setting.

If official subscription discovery is unavailable, `agyc` falls back to Google's public Gemini model documentation. In API-key mode, it uses the live Gemini `/models` endpoint and keeps models that support `generateContent`. The short names `auto`, `pro`, `flash`, and `flash-lite` remain convenience choices and resolve dynamically to the newest matching model available through the active provider; an unavailable alias fails clearly instead of silently selecting another model.

Change the model silently:

```text
C:\project> model pro
C:\project>
```

Concrete provider model names may also be supplied:

```text
C:\project> model gemini-3.1-pro-preview
```

Process option:

```cmd
agyc --model pro
```

Environment default:

```cmd
set ANTIGRAVITY_MODEL=pro
```

## Reasoning effort

Reasoning controls affect provider thinking configuration without exposing model thoughts.

Show the current setting:

```text
C:\project> reasoning
auto
```

Choices:

```text
C:\project> reasoning list
auto
low
high
```

Set it:

```text
C:\project> reasoning high
C:\project>
```

Interactive changes to `model`, `reasoning`, `auth`, and `approval` are persisted globally under the external state root and reused in later `agyc` processes. Command-line flags and environment variables can still override those saved defaults for a specific launch.

Meaning:

- `auto` — leave thinking behavior to the selected provider/model.
- `low` — request a smaller reasoning budget/level where supported.
- `high` — request a larger reasoning budget/level where supported.

Thoughts and chain-of-thought are never printed in normal terminal output or stored in the conversation history maintained by this wrapper.

Process option:

```cmd
agyc --reasoning high
```

Environment default:

```cmd
set ANTIGRAVITY_REASONING=high
```

## Command approval

Show the current mode:

```text
C:\project> approval
ask
```

Choices:

```text
C:\project> approval list
ask
yes
```

Default:

```text
C:\project> approval ask
```

Autonomous mode:

```text
C:\project> approval yes
```

or at startup:

```cmd
agyc --yes
```

In direct API-key mode, `ask` requires confirmation before shell commands. In Google-account mode, the provider's print/headless path cannot surface interactive permission prompts. Normal `ask` therefore auto-permits provider tools **inside Antigravity's terminal sandbox and the wrapper's private staging copy**; `yes` removes the provider sandbox while retaining the wrapper's staging transaction.

`--yes` should still be used deliberately: staging prevents partial project-source publication, but a shell command can have effects outside the project if the command itself targets external resources.

## Attach an image or document

Attachments are queued for the **next** ordinary instruction.

```text
C:\project> attach screenshot.png
C:\project> attach requirements.pdf
C:\project> attach notes.md
C:\project> implement the change described in these files
```

Successful `attach` commands produce no confirmation line.

Inspect pending attachments:

```text
C:\project> attach
C:\project\screenshot.png
C:\project\requirements.pdf
C:\project\notes.md
```

`attach list` is equivalent:

```text
C:\project> attach list
```

Clear the queue:

```text
C:\project> attach clear
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
agyc --attach screenshot.png --attach requirements.pdf -p "fix the UI according to these files"
```

Paths containing spaces can be quoted:

```cmd
agyc --attach "C:\docs\feature spec.pdf" -p "implement this"
```

Interactive equivalent:

```text
C:\project> attach "C:\docs\feature spec.pdf"
```

## Conversation history

Conversation history persists across `agyc` restarts for each project directory.

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
C:\project> history
```

Show the exact external history path:

```text
C:\project> history path
C:\Users\you\.antigravity-cli\history\<project-key>.json
```

Clear it:

```text
C:\project> history clear
```

The general `clear` command also clears persisted conversation history and pending attachments for the current project:

```text
C:\project> clear
```

History stores user messages, final replies, timestamps, and attachment metadata such as attachment names/paths. It does not store internal reasoning or the tool-by-tool execution stream.

### Relocate external state

Set `ANTIGRAVITY_HOME` before starting `agyc`:

```cmd
set ANTIGRAVITY_HOME=D:\private\agy-state
agyc
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

Before autonomous work begins, `agyc` records a small project-scoped checkpoint outside the repository that points to the OS-temporary staged transaction. A normal success, handled failure, or Ctrl+C removes that checkpoint and staging directory. If the process is killed or crashes before cleanup runs, the checkpoint may remain. `agyc resume` reopens that exact staged copy, verifies that the real project still matches the original baseline, and continues the original request; if the baseline changed, resume refuses to publish. `agyc task clear` discards the interrupted state without touching the real project.

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
agyc
```

No `git init` is performed and no `.git` directory is created by `agyc`.

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
agyc
agyc doctor
agyc login
agyc provider [status|update]
agyc resume
agyc task [clear]
agyc init
agyc -p <prompt>
agyc --attach <path>
agyc --yes
agyc --auth auto|google|api-key
agyc --model <name>
agyc --reasoning auto|low|high
agyc --base-url <url>
agyc --help
agyc --version
```

Short forms:

```text
-p  --print
-y  --yes
-m  --model
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
| `AGYC_SKIP_PROVIDER_INSTALL` | Optional opt-out (`1`, `true`, `yes`, `on`) for npm-time provider preinstall; Google mode will still bootstrap on first use. |
| `AGYC_SKIP_PATH_SETUP` | Optional Windows install/CI opt-out for automatic user-PATH mutation. |

## Typical workflows

### Fix a failing test

```text
C:\project> fix the failing tests and run the relevant test suite
```

### Implement from a screenshot

```text
C:\project> attach C:\designs\checkout.png
C:\project> recreate this checkout behavior using the existing components
```

### Implement from a PDF specification

```text
C:\project> attach C:\specs\api-requirements.pdf
C:\project> implement the required endpoint changes and tests
```

### Continue work tomorrow

```cmd
cd C:\projects\my-app
agyc
```

The project-scoped external conversation history is loaded automatically.

### Start with a clean conversation

```text
C:\project> clear
```

### Use stronger reasoning for one session

```cmd
agyc --reasoning high --model pro
```

### Run autonomously in a trusted local project

```cmd
agyc --yes -p "apply the refactor and run all tests"
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

Hidden staging protects the project from partial source publication. It is not a complete operating-system sandbox.

A shell command can still have external effects if it deliberately targets locations, services, credentials, package registries, databases, cloud APIs, or network resources outside the project. Keep `approval ask` for unfamiliar projects or prompts and use `approval yes` only when you accept autonomous command execution.

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
npm publish --dry-run --json
```

`release:check` runs syntax validation, the full test suite, a moderate-or-higher vulnerability audit, a package dry-run, and a script-free publish dry-run. The explicit `npm publish --dry-run --json` command then exercises the normal `prepublishOnly` lifecycle exactly as a real publish would, without uploading anything.

Before the real publish, verify `npm whoami` succeeds for the intended npm account. Then inspect the package contents and only publish when the package name, metadata, license, account, and two-factor/token policy are ready. This package is configured as MIT licensed and includes `LICENSE` in the published files. Its npm metadata points to the GitHub repository, issue tracker, and README homepage.

This repository is currently configured with version `0.1.0` and `publishConfig.access = public`. Publication is a separate explicit step; running the commands above does not publish anything.

## Troubleshooting

### `agyc` is not recognized / command not found

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
where agyc
agyc --version
```

PowerShell equivalent:

```powershell
Get-Command agyc
agyc --version
```

If PATH is still wrong, bypass it completely. Change to the project you want to work on and run the CLI by absolute path:

```cmd
cd C:\projects\my-app
node C:\path\to\antigravity-cli-npm\bin\agy.js
```

The source file is still named `bin/agy.js`; the **public command is `agyc`**. Do not rename or depend on a public `agy` command.

### I accidentally ran `agy` instead of `agyc`

`agy` is not exported by this package. It may belong to Google's official Antigravity CLI or another installed product. Run:

```cmd
agyc --version
```

and use `agyc` for this npm wrapper.

### `Missing GEMINI_API_KEY`

You forced API-key mode without setting the key.

Either:

```cmd
set GEMINI_API_KEY=your_key
agyc --auth api-key
```

or switch back to Google mode:

```cmd
agyc --auth google
```

Google mode does not require a separate Antigravity install or login command. npm installation pre-provisions the official backend; your first normal request automatically repairs/retries that backend if necessary and opens the official browser sign-in only when the native secure session is missing. Once approved on that device, later requests and restarts reuse the secure session silently. The wrapper does not create or read Gemini CLI `oauth_creds.json` credentials.

### Google browser sign-in appears on a new device

This is expected once per device/user profile when the official Antigravity keyring has no usable session. Finish the provider's browser consent and the original `agyc` request continues automatically. No additional CLI command is required.

### The target folder has no `.git`

That is supported. No action is needed.

### Git-specific output fails in a non-Git folder

The core CLI still works. Only the Git-specific operation lacks a repository to inspect.

### I do not see intermediate edits

That is intentional. The real project is only updated after a successful instruction finishes.

### An external edit caused a conflict

Re-run the instruction after reviewing the external change. The wrapper refuses to overwrite a changed baseline path automatically.

### `An interrupted task is available`

A previous `agyc` process ended abnormally after its staged transaction was prepared. Inspect it with `agyc task`, continue it with `agyc resume`, or deliberately discard it with `agyc task clear`. Resume validates the original real-project baseline before publishing anything.

### Provider provenance is `unrecorded` or `changed`

`unrecorded` means the binary predates the provenance receipt or was supplied outside the current managed install flow. `changed` means its current SHA-256 no longer matches the recorded managed-binary digest. `agyc provider update` performs a fresh managed install from the official Google installer and rolls back if the replacement fails its health check. An `ANTIGRAVITY_CLI_BINARY` override is external and cannot be updated by this command.

### Where is conversation history stored?

Inside `ANTIGRAVITY_HOME\history` if configured; otherwise below your home directory in `.antigravity-cli\history`.

Use:

```text
C:\project> history path
```

### How do I erase project conversation history?

```text
C:\project> history clear
```

or:

```text
C:\project> clear
```

## License

MIT. See `LICENSE`.
