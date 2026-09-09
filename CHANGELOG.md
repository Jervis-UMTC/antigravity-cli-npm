# Changelog

All notable changes to the `antigyc` npm package are documented here.

## 0.1.1 - 2026-09-09

### Changed

- Renamed the public npm package and shell command to `antigyc` consistently across help, prompts, diagnostics, install messages, tests, and documentation.
- Reworked the README opening into a beginner-first, copy/paste setup guide so new users can install, authenticate, open a project, send requests, attach files, cancel tasks, and diagnose problems without reading the advanced internals first.
- Kept the GitHub repository name `Jervis-UMTC/antigravity-cli-npm` unchanged.

## 0.1.0 - 2026-09-09

Initial release candidate.

### Added

- Minimal CMD-style interactive coding shell with the `antigyc` entry point.
- Hidden transactional editing in an OS-temporary staging copy for Git and non-Git projects.
- Google subscription execution through Google's official Antigravity CLI headless backend.
- Automatic isolated provider-backend installation, health validation, and repair without provider PATH takeover. npm `postinstall` now pre-provisions the official backend on a machine with no Antigravity installation; first Google use retries automatically if preinstall was offline.
- Persistent Google account/keyring reuse and post-login subscription verification.
- Automated first-run Google sign-in driven exclusively by the official Antigravity CLI in a hidden temporary pseudo-terminal; the provider opens its own browser flow and stores its native secure keyring session.
- Zero-setup normal Google requests: `antigyc` automatically ensures the backend and native account session before the first request, so `antigyc login` is optional rather than a required setup step.
- Direct Gemini API-key mode with live model discovery.
- Dynamic `auto`, `pro`, `flash`, and `flash-lite` model aliases.
- Persistent external preferences for model, reasoning, auth, and approval mode.
- External project-scoped conversation history.
- Image, PDF, text/code, DOCX, XLSX, and PPTX attachment support.
- Plain transient task-phase activity lines (`Preparing`, `Inspecting`, `Working`, `Checking`, `Applying changes`) with elapsed seconds, no spinner/design chrome, and automatic erasure before final output.
- Ctrl+C cancellation propagation through provider requests, direct API calls, shell commands, and transactional publication.
- Explicit `antigyc init` / `init` command for opt-in `AGENTS.md` creation.
- One-time automatic Windows npm PATH setup.
- Removed the legacy `@google/gemini-cli`/Code Assist OAuth dependency and `oauth_creds.json` migration path from Google subscription authentication.
- Added npm repository/bugs/homepage metadata and a script-free `npm publish --dry-run --json` release gate.
- Published the package identity and sole public executable as `antigyc`; `agy`, `antigravity`, and `antigravity-cli-npm` are not exported as public commands.
- Moved the package-managed official Antigravity backend into a private per-user data directory instead of a public `agy` command directory.
- Removed the `(no response)` placeholder. Empty successful provider replies now trigger a same-conversation final-response recovery request and fail explicitly if Google still returns no text.
- Fixed headless project inspection/tool denial by running normal Google provider tools with auto-permission inside Antigravity's terminal sandbox; explicit `approval yes` retains unrestricted provider auto-permission inside the wrapper's disposable staging workspace.
- Fixed Windows fresh-machine provider installation by passing the downloaded official `.cmd` installer to `cmd.exe` as discrete arguments instead of a nested quoted command string.
- Strengthened direct API agent autonomy with a 120-step execution budget, transient model-request retries, head/tail-preserving compact tool-result context, enforced post-edit verification, stagnant-tool-loop detection/replanning, bounded large-file reads, and a compact `project_overview` tool for repository-scale tasks.
- Strengthened Google subscription task instructions so the official Antigravity backend maps broad repositories, iterates after failed checks, and validates meaningful modifications before finalizing.
- Added `antigyc doctor` / `doctor` plain diagnostics for wrapper, Node/npm, workspace/state, command resolution, provider/account, provider provenance, and basic network health.
- Added managed-provider provenance receipts with official installer URL plus installer/binary SHA-256 hashes, `provider` status, and `provider update` with post-install health validation and rollback. External provider overrides remain externally managed.
- Added abnormal-termination recovery with external task checkpoints, preserved OS-temporary staging, `antigyc resume` / `resume`, `task`, and `task clear`; resume refuses publication when the real project changed since the saved baseline.
- Added structured native executable/argv execution for direct API mode, while keeping shell execution available only when shell syntax is needed.
- Added atomic exact multi-file patch editing, validation-command discovery, and lightweight symbol-definition/reference navigation to the direct coding agent.
- Added Windows/macOS/Linux GitHub Actions coverage on Node 20 and 22, with provider install and Windows PATH mutation explicitly disabled in CI.

### Safety and isolation

- Real project files are unchanged until a request completes successfully.
- Failed/canceled work is discarded; publication conflicts are refused. Only abnormal process termination may preserve a resumable external staged task, and resume revalidates the real-project baseline before publication.
- `.git`, `.gemini`, `.agents`, and `node_modules` provider/runtime metadata is never published from staging.
- Linked-worktree/submodule `.git` pointer files are replaced by isolated disposable staging Git metadata so commands cannot mutate the real external gitdir through the staging copy.
- Conversation history, persistent preferences, credentials, and attachment staging remain outside projects by default.
- Office Open XML archives are parsed in memory with ZIP expansion limits; archives are not extracted into the project.
