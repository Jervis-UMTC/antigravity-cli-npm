# Antigravity CLI for npm

A coding agent that looks and behaves like a normal command prompt.

`agy` intentionally has no AI-style terminal interface: no startup banner, cards, panels, spinner, tool-call stream, model badge, reasoning display, assistant label, or live edit animation. Normal interactive startup is simply:

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
- Uses plain CMD-style text commands instead of slash commands or menus.

## Requirements

- Node.js 20 or newer.
- npm.
- One authentication method:
  - a Google/Gemini subscription account through Google's official Antigravity CLI backend, or
  - a Gemini API key in `GEMINI_API_KEY`.

For Google subscription mode, `agy` uses the official Antigravity CLI only as a hidden headless backend. If that backend is missing, `agy` can install it into its normal per-user location without adding the provider binary to PATH or replacing this npm package's `agy` command.

## Try it now from this repository

The package does not need to be published to npm before you test it locally.

From the `antigravity-cli-npm` repository:

```cmd
npm install
npm run check
npm test
npm link
```

On Windows, `npm install` / `npm link` now performs the PATH setup automatically. The package detects npm's command directory and adds it to the **Windows user PATH only when missing**, preserving every existing PATH entry. The operation is idempotent and is skipped on non-Windows systems.

A child npm process cannot modify the environment of an already-open parent CMD window. Therefore, after the **first** install/link on a machine, close that terminal and open one new terminal. After that, there is no repeated `set PATH=...` setup.

Verify once in the new terminal:

```cmd
where agy
agy --version
```

During that one initial terminal session, you can still invoke the generated shim directly without changing PATH:

```cmd
%APPDATA%\npm\agy.cmd --version
```

No separate Google authentication command is required. Move to **any folder** you want the agent to work on and start `agy`:

```cmd
cd C:\projects\my-app
agy
```

The target can be a Git repository:

```text
C:\projects\repo-with-git> agy
C:\projects\repo-with-git>
```

or a completely ordinary folder with no `.git` directory:

```text
C:\projects\plain-folder> agy
C:\projects\plain-folder>
```

Git is optional. Git-aware operations are useful when Git is present, but the editing transaction itself is filesystem-based and does not depend on Git.

## Test the packaged tarball before publishing

You can also test the same artifact npm would publish:

```cmd
npm pack
```

This creates a `.tgz` package in the repository. In another folder:

```cmd
mkdir C:\temp\agy-test
cd C:\temp\agy-test
npm init -y
npm install C:\path\to\antigravity-cli-npm\antigravity-cli-npm-0.1.0.tgz
npx agy --help
npx agy
```

The package exposes both command names:

```cmd
agy
antigravity
```

## Install after npm publication

Global installation:

```cmd
npm install -g antigravity-cli-npm
```

On Windows, installation automatically persists npm's command directory into the user PATH if it is missing. On the first install only, open one new terminal afterward; future terminals can run `agy` directly with no setup.

Then:

```cmd
cd C:\projects\my-app
agy
```

Project-local installation:

```cmd
npm install --save-dev antigravity-cli-npm
npx agy
```

## Zero-setup Google account bootstrap

You do **not** need to run `agy login` before using the CLI. Start `agy` normally and enter your first request. In Google mode, that request automatically ensures the official backend is installed and healthy, checks the native Antigravity secure session, and starts the official browser sign-in flow only when that device actually needs authentication.

Google subscription mode now executes through Google's **official Antigravity CLI headless client**, rather than the older Gemini CLI / Code Assist client that rejects personal accounts. The provider binary is invoked by its absolute per-user path, with JSON output captured internally, so its TUI, progress stream, slash commands, banners, and tool narration do not appear inside this wrapper.

On Windows the official backend normally lives at `%LOCALAPPDATA%\agy\bin\agy.exe`; on macOS/Linux it normally lives at `~/.local/bin/agy`. `agy` can install that backend automatically with the provider's official installer using `--skip-path --skip-aliases`, which prevents the provider binary from taking over the npm wrapper's command name. The binary is health-checked before first use in each wrapper process; an unhealthy default backend is replaced through the official installer, while an explicit `ANTIGRAVITY_CLI_BINARY` override is never silently deleted. The provider remains responsible for its own normal self-update behavior.

Authentication is persistent through the official Antigravity secure account session, including Windows Credential Manager on Windows. Normal `agy` requests probe that native session automatically and continue silently when it is already usable. On a first use on a new device/user profile, the wrapper starts the official Antigravity binary with no arguments inside a hidden pseudo-terminal rooted in an empty OS-temporary directory. The official client itself opens its Antigravity browser sign-in flow and writes its native secure-keyring session; all provider terminal rendering remains captured and invisible. As soon as the official session becomes usable, the hidden bootstrap process is stopped and `agy` performs one headless verification request before continuing the original request. There is no Gemini CLI/Code Assist OAuth fallback, no `oauth_creds.json`, and no credential-migration step.

Antigravity **IDE** is not required. The official Antigravity **CLI backend** is the supported Google subscription transport and is intentionally hidden behind this package's CMD-style interface.

Use the Google account associated with the subscription you want Antigravity to use. A brand-new device may still require you to approve Google's browser sign-in once because the provider's secure session is device-local; that is identity consent, not CLI setup. Afterward, normal restarts and projects reuse the session automatically. `agy login` remains available only as an explicit verification/renewal command. The wrapper never falls back to Gemini CLI or Code Assist authentication.

Some organization or Workspace environments may additionally require a Google Cloud project:

```cmd
set GOOGLE_CLOUD_PROJECT=your-project-id
```

After any required first-device browser consent completes, the original request continues and later use stays on the plain `agy` prompt.

## API-key authentication

Windows CMD:

```cmd
set GEMINI_API_KEY=your_api_key_here
agy --auth api-key
```

PowerShell:

```powershell
$env:GEMINI_API_KEY="your_api_key_here"
agy --auth api-key
```

macOS/Linux:

```bash
export GEMINI_API_KEY="your_api_key_here"
agy --auth api-key
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
agy --auth google
agy --auth api-key
```

Environment default:

```cmd
set ANTIGRAVITY_AUTH=google
```

## Interactive usage

Start in the project you want to modify:

```cmd
cd C:\projects\my-app
agy
```

Then type normal instructions:

```text
C:\projects\my-app> find the cause of the failing tests and fix it

Fixed the validation bug and the affected tests now pass.

C:\projects\my-app> add input validation to the signup endpoint

Added signup validation and updated the endpoint tests.

C:\projects\my-app>
```

There is no visible tool stream while the task is running. For requests that take more than a moment, interactive mode shows one transient native-looking line such as `Working... 12s`. When the finished staged state is being published it briefly becomes `Applying changes...`. The line pauses during permission prompts and is erased before the final response or error appears. Pressing Ctrl+C during active work cancels the request, discards/rolls back staged publication, and returns `Canceled.` without publishing a partial project state.

## One-shot usage

Run one instruction and exit:

```cmd
agy -p "find the bug and fix it"
```

With options:

```cmd
agy --model pro --reasoning high --yes -p "implement the feature and run the tests"
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

`status` is deliberately terse. It is not shown automatically. In Google mode it performs hidden provider health/account probes; in API-key mode it reports whether the key is configured.

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

`model list` is discovery-backed rather than a hard-coded release list. In Google subscription mode, `agy` first runs the official Antigravity backend's `models` command with all provider progress captured. That makes the list reflect models actually offered to the signed-in subscription. Effort-specific provider slugs such as `gemini-3.8-flash-high` are normalized to the base model `gemini-3.8-flash`, because this wrapper keeps reasoning effort as a separate `reasoning` setting.

If official subscription discovery is unavailable, `agy` falls back to Google's public Gemini model documentation. In API-key mode, it uses the live Gemini `/models` endpoint and keeps models that support `generateContent`. The short names `auto`, `pro`, `flash`, and `flash-lite` remain convenience choices and resolve dynamically to the newest matching model available through the active provider; an unavailable alias fails clearly instead of silently selecting another model.

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
agy --model pro
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

Interactive changes to `model`, `reasoning`, `auth`, and `approval` are persisted globally under the external state root and reused in later `agy` processes. Command-line flags and environment variables can still override those saved defaults for a specific launch.

Meaning:

- `auto` — leave thinking behavior to the selected provider/model.
- `low` — request a smaller reasoning budget/level where supported.
- `high` — request a larger reasoning budget/level where supported.

Thoughts and chain-of-thought are never printed in normal terminal output or stored in the conversation history maintained by this wrapper.

Process option:

```cmd
agy --reasoning high
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
agy --yes
```

In direct API-key mode, `ask` requires confirmation before shell commands. In Google-account mode, normal hidden execution uses the official provider's edit-friendly approval path; `yes` maps to its fully automatic tool path inside the private staging workspace.

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
agy --attach screenshot.png --attach requirements.pdf -p "fix the UI according to these files"
```

Paths containing spaces can be quoted:

```cmd
agy --attach "C:\docs\feature spec.pdf" -p "implement this"
```

Interactive equivalent:

```text
C:\project> attach "C:\docs\feature spec.pdf"
```

## Conversation history

Conversation history persists across `agy` restarts for each project directory.

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

Set `ANTIGRAVITY_HOME` before starting `agy`:

```cmd
set ANTIGRAVITY_HOME=D:\private\agy-state
agy
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
agy
```

No `git init` is performed and no `.git` directory is created by `agy`.

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
- search source text;
- create files;
- replace/edit file content;
- delete project paths;
- run project commands;
- run tests, builds, linters, formatters, and type checks;
- inspect Git diffs when Git is available;
- use attached screenshots/images and documents as task context;
- carry conversation context across restarts.

The direct API-key implementation constrains its built-in file tools to the current project path, including checks against path traversal and symlink escape.

## CLI options

```text
agy
agy login
agy init
agy -p <prompt>
agy --attach <path>
agy --yes
agy --auth auto|google|api-key
agy --model <name>
agy --reasoning auto|low|high
agy --base-url <url>
agy --help
agy --version
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
agy
```

The project-scoped external conversation history is loaded automatically.

### Start with a clean conversation

```text
C:\project> clear
```

### Use stronger reasoning for one session

```cmd
agy --reasoning high --model pro
```

### Run autonomously in a trusted local project

```cmd
agy --yes -p "apply the refactor and run all tests"
```

## Failure behavior

Expected failure behavior is conservative:

- invalid attachment path -> request does not run;
- unsupported attachment -> request does not run;
- model/API error -> staged project changes are discarded;
- Ctrl+C during active work -> request is canceled and staged changes are discarded/rolled back;
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
- explicit `status`, `history`, `attach`, model/auth/reasoning queries;
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

The test suite covers project-bound file tooling, command approval/cancellation, reasoning and dynamic model aliases, persistent external settings/history, image/PDF/Office/text attachments, bounded Office ZIP parsing, hidden staging publication and rollback, conflict detection, normal and pointer-file Git metadata isolation, backend health/login verification, explicit project init, and full one-shot CLI behavior in non-Git folders using a local fake Gemini endpoint.

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
src/init.js             explicit optional project-instructions initializer
scripts/setup-path.js    one-time Windows npm PATH bootstrap
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

### `Missing GEMINI_API_KEY`

You forced API-key mode without setting the key.

Either:

```cmd
set GEMINI_API_KEY=your_key
agy --auth api-key
```

or switch back to Google mode:

```cmd
agy --auth google
```

Google mode does not require a separate login command. Your first normal request automatically installs/repairs the official Antigravity backend if necessary and opens the official browser sign-in only when the native secure session is missing. Once approved on that device, later requests and restarts reuse the secure session silently. The wrapper does not create or read Gemini CLI `oauth_creds.json` credentials.

### Google browser sign-in appears on a new device

This is expected once per device/user profile when the official Antigravity keyring has no usable session. Finish the provider's browser consent and the original `agy` request continues automatically. No additional CLI command is required.

### The target folder has no `.git`

That is supported. No action is needed.

### Git-specific output fails in a non-Git folder

The core CLI still works. Only the Git-specific operation lacks a repository to inspect.

### I do not see intermediate edits

That is intentional. The real project is only updated after a successful instruction finishes.

### An external edit caused a conflict

Re-run the instruction after reviewing the external change. The wrapper refuses to overwrite a changed baseline path automatically.

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
