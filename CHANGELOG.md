# Changelog

All notable changes to `antigravity-cli-npm` are documented here.

## 0.1.0 - 2026-09-09

Initial release candidate.

### Added

- Minimal CMD-style interactive coding shell with `agyc` and `antigravity-cli-npm` entry points.
- Hidden transactional editing in an OS-temporary staging copy for Git and non-Git projects.
- Google subscription execution through Google's official Antigravity CLI headless backend.
- Automatic isolated provider-backend installation, health validation, and repair without provider PATH takeover.
- Persistent Google account/keyring reuse and post-login subscription verification.
- Automated first-run Google sign-in driven exclusively by the official Antigravity CLI in a hidden temporary pseudo-terminal; the provider opens its own browser flow and stores its native secure keyring session.
- Zero-setup normal Google requests: `agyc` automatically ensures the backend and native account session before the first request, so `agyc login` is optional rather than a required setup step.
- Direct Gemini API-key mode with live model discovery.
- Dynamic `auto`, `pro`, `flash`, and `flash-lite` model aliases.
- Persistent external preferences for model, reasoning, auth, and approval mode.
- External project-scoped conversation history.
- Image, PDF, text/code, DOCX, XLSX, and PPTX attachment support.
- Plain transient `Working... Ns` and `Applying changes...` request activity lines.
- Ctrl+C cancellation propagation through provider requests, direct API calls, shell commands, and transactional publication.
- Explicit `agyc init` / `init` command for opt-in `AGENTS.md` creation.
- One-time automatic Windows npm PATH setup.
- Removed the legacy `@google/gemini-cli`/Code Assist OAuth dependency and `oauth_creds.json` migration path from Google subscription authentication.
- Added npm repository/bugs/homepage metadata and a script-free `npm publish --dry-run --json` release gate.
- Renamed the public short command from `agy` to conflict-free `agyc`; `antigravity-cli-npm` remains as a package-name alias, while `agy` and `antigravity` are no longer exported by this package.
- Moved the package-managed official Antigravity backend into a private per-user data directory instead of a public `agy` command directory.
- Removed the `(no response)` placeholder. Empty successful provider replies now trigger a same-conversation final-response recovery request and fail explicitly if Google still returns no text.
- Fixed headless project inspection/tool denial by running normal Google provider tools with auto-permission inside Antigravity's terminal sandbox; explicit `approval yes` retains unrestricted provider auto-permission inside the wrapper's disposable staging workspace.

### Safety and isolation

- Real project files are unchanged until a request completes successfully.
- Failed/canceled work is discarded; publication conflicts are refused.
- `.git`, `.gemini`, `.agents`, and `node_modules` provider/runtime metadata is never published from staging.
- Linked-worktree/submodule `.git` pointer files are replaced by isolated disposable staging Git metadata so commands cannot mutate the real external gitdir through the staging copy.
- Conversation history, persistent preferences, credentials, and attachment staging remain outside projects by default.
- Office Open XML archives are parsed in memory with ZIP expansion limits; archives are not extracted into the project.
