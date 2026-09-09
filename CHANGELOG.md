# Changelog

All notable changes to `antigravity-cli-npm` are documented here.

## 0.1.0 - 2026-09-09

Initial release candidate.

### Added

- Minimal CMD-style interactive coding shell with `agy` and `antigravity` entry points.
- Hidden transactional editing in an OS-temporary staging copy for Git and non-Git projects.
- Google subscription execution through Google's official Antigravity CLI headless backend.
- Automatic isolated provider-backend installation, health validation, and repair without provider PATH takeover.
- Persistent Google account/keyring reuse and post-login subscription verification.
- Direct Gemini API-key mode with live model discovery.
- Dynamic `auto`, `pro`, `flash`, and `flash-lite` model aliases.
- Persistent external preferences for model, reasoning, auth, and approval mode.
- External project-scoped conversation history.
- Image, PDF, text/code, DOCX, XLSX, and PPTX attachment support.
- Plain transient `Working... Ns` and `Applying changes...` request activity lines.
- Ctrl+C cancellation propagation through provider requests, direct API calls, shell commands, and transactional publication.
- Explicit `agy init` / `init` command for opt-in `AGENTS.md` creation.
- One-time automatic Windows npm PATH setup.

### Safety and isolation

- Real project files are unchanged until a request completes successfully.
- Failed/canceled work is discarded; publication conflicts are refused.
- `.git`, `.gemini`, `.agents`, and `node_modules` provider/runtime metadata is never published from staging.
- Linked-worktree/submodule `.git` pointer files are replaced by isolated disposable staging Git metadata so commands cannot mutate the real external gitdir through the staging copy.
- Conversation history, persistent preferences, credentials, and attachment staging remain outside projects by default.
- Office Open XML archives are parsed in memory with ZIP expansion limits; archives are not extracted into the project.
