# antigravity-cli-npm implementation rule

The normal CLI must look and behave like an ordinary command prompt, not an AI application.

- Do not add startup banners, logos, decorative headings, panels, cards, status bars, animated spinners, colors, assistant labels, tool-call labels, model badges, auth badges, reasoning indicators, or other product chrome.
- A single transient plain-text activity line such as `Working... 12s` or `Applying changes...` is allowed while an ordinary request is running. It must expose no model/tool/reasoning details, pause for permission prompts, and be erased before the final response or error is printed.
- On normal interactive startup, print nothing before the current-directory prompt.
- All controls must be plain CMD-style commands at the same prompt. Do not introduce slash commands, menus, pickers, full-screen interfaces, or custom interactive widgets.
- Model selection, reasoning effort, authentication, approvals, session clearing, status, login, explicit project initialization, and exit must remain available through terse text commands. Persistent user preferences must live outside projects under the external state root.
- Keep internal reasoning, provider selection, model/tool plumbing, coding-agent orchestration, and intermediate tool output hidden from normal terminal output.
- AI file edits and command-driven project mutations must occur in an OS-temporary staging workspace outside the repository. The real project must not change while the agent is working.
- Apply staged project changes only after the instruction finishes successfully. If the instruction fails, is canceled, or a concurrent external edit is detected, do not publish the staged changes into the real project. Ctrl+C during active work must propagate cancellation and preserve the pre-request real-project state.
- Never create real-project Git commits, branches, worktrees, stash entries, patch files, provider metadata, conversation databases, attachment caches, or other AI bookkeeping. Intermediate Git operations may only affect the disposable staging copy. A real `.git` pointer file from a linked worktree/submodule must never be copied into staging as a live pointer to external Git metadata.
- Conversation history and temporary attachment copies must live outside the repository under user-profile or OS-temporary storage. Git must only observe final project file changes.
- Images, PDFs, Office Open XML documents (DOCX/XLSX/PPTX), and text/code documents may be attached to a prompt through plain CMD-style commands. Attachment processing must remain invisible apart from explicit attachment/history inspection commands. Office archives must be bounded against unsafe expansion and must not be extracted into the real project.
- Print the final response only after the completed staged changes have been applied to the real project.
- Show only user-requested output, final responses, genuine errors, and permission prompts that are necessary for safe execution.
- Successful state changes such as clearing a session or changing a model/reasoning setting should stay quiet unless the user explicitly asks to inspect that state.
- Preserve the shell-like prompt format, for example `C:\project> `, without additional branding around it.
- Google subscription execution must use Google's official Antigravity CLI in headless/JSON mode. It may be installed automatically as a backend-only binary outside npm's PATH and must be invoked by absolute path so it never shadows this package's `agy` command.
- Google authentication may open the provider's required browser sign-in page, but `agy login` must not launch the provider's terminal TUI, folder-trust screen, IDE onboarding, banners, tips, or slash-command interface. A valid official Antigravity keyring session should be reused silently.
- Documentation may explain that the package uses AI/Gemini; the runtime must not pretend to be a human or misrepresent what it is. The goal is visual invisibility, not deception.
