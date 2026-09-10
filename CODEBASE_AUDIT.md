# antigravity-cli-npm Codebase Audit

Audit date: 2026-09-10

This report records the findings from a read-only inspection of the `antigravity-cli-npm` codebase, including runtime code, CLI behavior, Google provider integration, transactional staging, persistence, attachments, install scripts, examples, tests, package metadata, documentation, and CI/release configuration.

## Validation baseline

Before scoring findings, the repository was validated from the actual package directory.

- `npm ci --ignore-scripts` completed successfully.
- `npm run check` passed.
- `npm test` passed: **105/105 tests**.
- `npm audit --audit-level=moderate` reported **0 vulnerabilities**.
- `npm pack --dry-run --ignore-scripts` succeeded.
- `node --test --experimental-test-coverage` passed.
- Overall built-in test coverage was approximately **78.93% lines, 63.61% branches, and 81.05% functions**.
- `npm run release:check` reached the final publish dry-run and failed only because npm version `0.1.2` is already published.
- Git was clean after the audit.

The repository therefore has a healthy basic test baseline, but several important architectural and edge-case problems are not covered by the current suite.

## Confirmed `spawn ENAMETOOLONG` issue

**Status: FIXED** — Google agent requests now use the provider's stream-JSON stdin transport, so prompt/history content is no longer placed in process argv. Regression coverage includes a 100,000-character prompt and verifies the argv remains small.

`Error: spawn ENAMETOOLONG` is directly explained by findings **#6 and #7** below.

In Google mode, `GoogleAccountAgent.prompt()` builds a single provider `-p` command-line argument containing the current request plus persisted conversation history. On the audited Windows host, a targeted process-spawn probe succeeded around 32,000 characters and failed around 33,000 characters with `ENAMETOOLONG`. The current history limits can construct arguments far beyond that size.

The correct fix is to avoid transporting large prompt/history payloads in process argv. Prefer stdin or a provider-supported input file, and independently budget or summarize persisted conversation history before invocation.

## Findings

### 1. CRITICAL / architectural — shell commands are not contained by the staging boundary

**Status: FIXED** — direct API `run_command` and `run_process` now execute through `@anthropic-ai/sandbox-runtime` rather than directly on the host. The sandbox grants write access only to the OS-temporary staged project plus a disposable per-command scratch/profile directory, keeps structured process argv behind an in-sandbox trampoline, applies to descendant processes, and fails closed when platform sandbox prerequisites are unavailable. Windows uses the runtime's dedicated sandbox user/WFP/ACL boundary and requires explicit one-time machine provisioning; Linux/macOS use their native runtime backends. A real escape regression is enabled in CI on a provisioned Linux sandbox, while unit regressions verify the write policy, structured-argv trampoline, and fail-closed behavior without requiring elevated local setup.

`src/tools.js` constrains wrapper-managed file operations to the staged workspace, but `run_command` and `run_process` start ordinary operating-system processes with the staged directory only as their working directory. Those processes can use parent paths, absolute paths, scripts, subprocesses, network access, or other filesystem locations.

This means the repository's stated guarantee that command-driven project mutations cannot affect the real project before staged publication is not technically enforceable. A command can mutate the real workspace or any other accessible path directly.

**Improvement:** enforce command execution with an OS-level filesystem/process sandbox, container, job boundary, or equivalent isolation. Path validation on the wrapper's own file tools is insufficient.

### 2. HIGH / security posture — fresh installs default to `turbo=true` and `approval=yes`

**Status: FIXED** — fresh profiles now default to `turbo=false` and `approval=ask`; autonomous execution requires an explicit opt-in.

`src/settings.js` deliberately enables turbo for a fresh configuration, which also enables command approval. The current test suite explicitly asserts this default.

Combined with finding #1, generated shell commands can execute without user confirmation by default.

**Improvement:** use `turbo=false` and `approval=ask` as safe defaults and require explicit opt-in for unrestricted autonomous commands.

### 3. HIGH / security — managed provider provenance is recorded but not enforced before execution

**Status: FIXED** — managed provider provenance is now checked before health/account execution. Missing or changed receipts trigger transactional repair, and provider status refuses to execute a changed managed binary.

The provider installer records source URL and SHA-256 metadata, but `ensureOfficialAntigravityCli()` considers an existing provider acceptable when its health probe succeeds. It does not require the provider's current digest to match the recorded provenance digest before executing it.

A replaced executable at the managed provider path can therefore be executed as long as it responds successfully to the health probe.

**Improvement:** validate managed-provider provenance before every trust transition, or at minimum before first execution in each process.

### 4. HIGH / security — provider health is cached indefinitely for the process

**Status: FIXED** — the path-only healthy-provider cache was removed. Managed provenance and health are revalidated on each ensure call.

The `healthyBackendPaths` cache records only a path. After a successful probe, later uses can skip health validation. If the executable is replaced while the process remains alive, the replacement can be used without a new probe.

**Improvement:** remove the cache or bind it to file identity data such as path, file ID/inode, size, modification time, and digest.

### 5. HIGH / supply chain — downloaded installer is executed without an externally authenticated expected digest or signature

**Status: FIXED** — managed installation no longer executes Google's downloaded bootstrap script. It fetches the platform manifest from Google's Antigravity release service, restricts the referenced asset to the official `storage.googleapis.com/antigravity-public/antigravity-cli/` release bucket, verifies the complete package against the manifest SHA-512 before writing the provider, and records both release and installed-binary digests for subsequent provenance checks.

`installOfficialAntigravityCli()` downloads the Google installer and immediately executes the returned script. A SHA-256 digest is recorded afterward, but that only records what was executed; it does not establish that the script matched a trusted expected release.

**Improvement:** verify a signed manifest, pinned expected digest, platform signature, or another independently authenticated release identity before execution. Another option is to make provider bootstrap an explicit user action instead of an npm-time side effect.

### 6. HIGH / reliability — Google mode can exceed the Windows process command-line limit

**Status: FIXED** — prompt/history transport was moved from `-p <prompt>` argv content to stream-JSON stdin.

`history.js` permits up to 30 model-history messages, each up to 24,000 characters. `GoogleAccountAgent.prompt()` serializes that history into the provider's single `-p` command-line argument.

A targeted Windows probe during the audit showed process spawning succeeding around 32,000 characters and failing around 33,000 characters with:

```text
Error: spawn ENAMETOOLONG
```

A sufficiently long conversation can therefore reliably break Google-mode requests on Windows.

**Improvement:** send the prompt through stdin or a provider-supported temporary input file and enforce a separate context/history budget.

### 7. HIGH / reliability — one large prompt can trigger the same `ENAMETOOLONG` failure without history

**Status: FIXED** — large request content is no longer transported through argv.

There is no sufficiently small provider-specific maximum on one-shot or interactive prompt text before it becomes a command-line argument.

**Improvement:** enforce a safe argv budget even after history handling is corrected. Prefer not to carry large content through argv at all.

### 8. HIGH / cancellation — first-use Google authentication is outside the active AbortController lifecycle

**Status: FIXED** — the request AbortController now exists before Google authentication begins, and the same `AbortSignal` is propagated through provider installation/health probing, account probing, hidden PTY login polling, and subscription verification. Cancellation is rethrown instead of being converted into a false "not logged in" result.

Interactive `processRequest()` performs authentication bootstrap before creating the active request controller. One-shot execution similarly bootstraps authentication before registering the controller used by the actual agent task. The login/provider bootstrap helpers also do not consistently accept an `AbortSignal`.

Ctrl+C during browser authentication, provider setup, or related probes therefore does not follow the same cancellation path promised for active agent work.

**Improvement:** create the request controller before authentication bootstrap and propagate its signal through login, account probing, provider installation, PTY polling, and backend verification.

### 9. HIGH / resume integrity — `baseline.json` paths are trusted too broadly

**Status: FIXED** — resumed baseline manifests now reject non-canonical/absolute/traversal/excluded paths, malformed fingerprint values, duplicate entries, and case-colliding paths on Windows before they are converted into a manifest map.

`loadManifest()` checks only that parsed entries are 2-element arrays. It does not validate manifest keys as safe normalized project-relative paths before later joining them with the real workspace.

A tampered preserved checkpoint could include traversal or otherwise unexpected paths.

**Improvement:** reject absolute paths, `..` traversal, excluded namespaces, malformed entries, duplicate/case-colliding paths, and unexpected fingerprint types before accepting a saved manifest.

### 10. HIGH / resume integrity — staging-container validation is lexical rather than physical

**Status: FIXED** — resumable staging containers must now be direct `agyc-stage-*` children of the configured OS temp root, be real directories rather than links, resolve physically beneath the real temp root, and (where UID information is available) be owned by the current user. Symlink/junction regression coverage verifies rejection.

Resume/container checks confirm that the path appears to be under the OS temp directory and that its basename begins with `agyc-stage-`. They do not fully validate realpath identity or guard against symlink/reparse-point redirection.

**Improvement:** resolve and validate the real container, staging root, rollback root, input root, and baseline file before using a preserved checkpoint.

### 11. HIGH / concurrency — publication has a TOCTOU window after concurrent-change verification

**Status: FIXED** — commit now revalidates the target and all relevant ancestors immediately before backup and again immediately before each destructive publication step. Directory replacement/removal also checks the expected subtree so late additions are detected. Rollback is limited to paths publication actually touched, preserving a conflict that arrives before the staged write begins.

`staging.commit()` fingerprints affected real-workspace paths, then creates backups and applies changes later. Another process can modify a verified path after the fingerprint check but before the destructive write.

**Improvement:** revalidate immediately before each replacement/removal or use stronger compare-and-swap/atomic publication semantics.

### 12. HIGH / secrets — child commands inherit the complete user environment

**Status: FIXED** — project commands, Git helper commands, provider processes, and the provider installer now use a shared filtered subprocess environment. Secret-like variables (tokens, secrets, passwords, API/private/access keys, credentials, cookies, connection strings, and common database credential variables) are removed by default. A user can explicitly opt a required variable back in by name through `AGYC_PASSTHROUGH_ENV`.

`run_command`, `run_process`, and several provider processes inherit essentially all of `process.env`. `googleAccountEnv()` removes several Google/Gemini variables but leaves unrelated credentials such as GitHub tokens, AWS credentials, database URLs, npm tokens, CI secrets, and other environment values.

**Improvement:** use an environment allowlist with explicit opt-in for additional variables needed by project commands.

### 13. HIGH / example security — `examples/title/title.sh` uses unsafe `eval`

**Status: FIXED** — the example now assigns each `jq` result through quoted command substitution and never evaluates JSON-derived text as shell source.

The example constructs shell assignments from JSON output and executes them with `eval`. Malicious or malformed values containing shell metacharacters can result in command execution.

**Improvement:** parse JSON into shell variables without `eval`.

### 14. HIGH / product invariant — normal API-key execution prints a tool/event stream

**Status: FIXED** — normal CLI execution no longer wires internal agent events to stdout. Only the generic transient activity indicator remains user-visible.

`src/cli.js` writes rendered activity events such as `Created:`, `Editing:`, `Running:`, and `Tests passed` to stdout. This conflicts with `AGENTS.md`, which requires internal tool/file activity to remain hidden and permits only one transient activity line. It also conflicts with README text stating that normal execution has no visible tool stream.

**Improvement:** keep events internal and use them only to update the single transient activity indicator.

### 15. MEDIUM-HIGH / terminal correctness — event lines interfere with the transient activity line

**Status: FIXED** — newline event rendering was removed from normal execution, leaving a single owner for transient progress output.

The activity indicator owns a carriage-return line, while event messages independently write newline-terminated output without reliably clearing or pausing the transient line first.

**Improvement:** eliminate normal event output or centralize all progress rendering through one terminal-output owner.

### 16. MEDIUM-HIGH / correctness — failed commands are emitted as successful events

**Status: FIXED** — command completion events now use the same failure classifier as tool execution, including `Command failed.` and permission denial results.

The agent currently determines `command_finished.success` and `test_finished.success` using whether the returned string starts with `Tool error:`. Normal process failures instead return strings beginning with `Command failed.`.

A targeted audit probe deliberately failed a command and observed both `command_finished` and `test_finished` emitted with `success:true`.

**Improvement:** return structured tool results such as `{ ok, exitCode, stdout, stderr }` and derive event success directly from `ok` rather than formatted text.

### 17. MEDIUM / semantics — every command is treated as a test event

**Status: FIXED** — generic process execution no longer emits synthetic `test_started`/`test_finished` events.

`run_command` and `run_process` emit `test_started`/`test_finished` even when the command is a build, formatter, Git status operation, migration, or arbitrary script.

**Improvement:** distinguish generic command execution from test/validation execution.

### 18. MEDIUM-HIGH / validation correctness — a plain file read counts as post-edit verification

**Status: FIXED** — only successful `run_command` or `run_process` execution can satisfy the post-edit verification gate. `read_file` and `git_diff` remain available for inspection but no longer count as validation.

`read_file` is one of the operations that can satisfy the agent's post-mutation verification requirement. A model can therefore modify code, reread the file, and satisfy the internal verification gate without executing a syntax check, test, build, or other meaningful validator.

**Improvement:** distinguish inspection from executable validation. When discoverable project checks exist, require an appropriate check before declaring verified completion.

### 19. MEDIUM / event correctness — `write_file` always reports `file_created`

**Status: FIXED** — `write_file` now records whether the target already existed and returns `Created` or `Updated`; file events reflect that result and are emitted only after successful mutation.

The event layer reports a write as file creation even when an existing file was overwritten.

**Improvement:** record existence before mutation or have the tool return an explicit mutation type.

### 20. MEDIUM-HIGH / settings migration — stored `approval=ask` can become `approval=yes`

**Status: FIXED** — a missing legacy `turbo` field is now interpreted as disabled, so stored `approval=ask` remains non-autonomous.

When a settings object contains `approval: "ask"` but no `turbo` field, preference merging defaults turbo to true and consequently sets approval to yes. A targeted probe confirmed this behavior.

**Improvement:** add schema migration for older settings and never let a missing turbo field silently override an explicit stored approval choice.

### 21. MEDIUM / provider repair — automatic repair deletes the old provider before a replacement succeeds

**Status: FIXED** — automatic repair and explicit update now share transactional backup/restore behavior for both the provider binary and provenance receipt.

Normal `ensureOfficialAntigravityCli()` removes an unhealthy provider and then attempts installation. The explicit update path has backup/rollback logic, but automatic repair does not.

**Improvement:** reuse transactional update/rollback logic for automatic repair.

### 22. MEDIUM / process cleanup — terminating the immediate child may leave descendants running

**Status: FIXED** — project commands and provider/curl subprocesses now use explicit process groups on POSIX and a shared tree terminator. Cancellation, timeouts, output-limit failures, and failed child execution terminate the detached POSIX process group with `SIGKILL`; Windows uses `taskkill /T /F` with direct-child fallback. Platform-specific regression tests verify the tree-termination targets and flags.

Timeout and cancellation generally call `child.kill()` on one process. Shell commands and provider processes can spawn descendants, especially on Windows.

**Improvement:** use process groups, Windows job objects, or another platform-aware process-tree termination mechanism.

### 23. MEDIUM / performance — provider output collection performs repeated whole-string work

**Status: FIXED** — provider stdout/stderr are now accumulated as buffer chunks with incremental byte counters and concatenated once when the child exits, avoiding repeated whole-output concatenation and byte-length scans.

`captureExecutable()` repeatedly concatenates strings and recomputes byte length over the full accumulated output up to a 10 MB ceiling.

**Improvement:** track byte count incrementally and collect output chunks in buffers/arrays before final concatenation.

### 24. MEDIUM / file tooling — ranged reads do not work for files larger than 1 MiB

**Status: FIXED** — files above the normal full-read limit remain rejected without a range, but explicit `start_line`/`end_line` requests now stream lines from disk and stop once the requested/bounded output is satisfied.

`read_file` rejects files above the total-size threshold before applying `start_line`/`end_line`. Its truncation guidance tells the agent to request a narrower range, but that strategy cannot work for a file whose total size exceeds the hard limit.

**Improvement:** implement streaming/ranged line reads that do not require loading the complete file.

### 25. MEDIUM / large repositories — search and symbol tooling silently stops at 5,000 entries

**Status: FIXED** — repository walks now retain a truncation flag. Listings, searches, symbol lookup, and reference lookup explicitly report when either the entry scan or result count was truncated and tell the agent to narrow the path/query or increase `max_results`.

Several repository tools use a 5,000-entry walk limit. Search/symbol/reference results do not clearly tell the caller when the scan was incomplete.

**Improvement:** return truncation metadata and support pagination or narrower continuation queries.

### 26. MEDIUM / secret privacy — sensitive project files can be uploaded to the model without a dedicated secret-file policy

**Status: FIXED** — agent-native list/read/search/symbol/edit/delete tooling now excludes common secret locations and credential files such as `.env*` (while allowing `.env.example`/sample/template), `.ssh`, `.aws`, `.gnupg`, `.npmrc`, credential JSON files, private-key stores, and key/certificate container extensions. Intentional access remains possible through an explicitly approved shell command.

`.env` is explicitly recognized as a text file, and repository search/read tooling has no configurable sensitive-path exclusion policy. Project credential files can therefore be inspected and transmitted to the remote model as normal project content.

**Improvement:** add configurable secret-file exclusions/consent rules for `.env*`, private keys, credential stores, token files, and similar paths.

### 27. MEDIUM / history scalability — history is character-counted rather than context-budgeted

**Status: FIXED** — persisted messages remain individually bounded, while model-facing history now selects the newest turns under a fixed 160 KiB UTF-8 byte budget in addition to the message-count cap. Attachment metadata is also count/field bounded.

Persisted history can grow large in characters and model tokens. This contributes to the Windows argv failure and can also consume excessive model context.

**Improvement:** budget by approximate tokens/bytes, summarize old turns, and reserve context for the current request plus tool results.

### 28. MEDIUM / history privacy — attachment history stores full source paths

**Status: FIXED** — conversation history now persists only attachment display name, MIME type, and kind. Full source paths are omitted. Interrupted-task checkpoints likewise retain only the staged temporary path required for safe resume, not the original attachment path.

Persistent conversation attachment metadata records the original full source path. This can expose usernames, private folder names, network share paths, or other local filesystem information.

**Improvement:** persist only basename/display metadata unless retaining the original path is required for a concrete feature.

### 29. MEDIUM / Office hardening — ZIP central-directory bounds are not fully enforced

**Status: FIXED** — the validator now requires the declared central directory to end exactly at the EOCD record, bounds every central-directory entry to that region, and verifies that parsing finishes exactly at the declared endpoint.

The Office ZIP validator checks broad buffer limits but does not require each parsed entry to stay strictly inside the declared central-directory region or require the final parsed offset to match the declared central-directory endpoint.

**Improvement:** validate every entry against the central-directory bounds and verify final offset consistency.

### 30. MEDIUM / Office hardening — decompression ultimately trusts advertised uncompressed sizes

**Status: FIXED** — all advertised uncompressed sizes are bounded before `fflate` is called, and the installed `fflate` implementation allocates DEFLATE output to that declared `originalSize`; extracted entry counts and actual output lengths are also checked after unzip. This prevents the wrapper from allocating beyond the prevalidated 50 MB aggregate Office limit through the normal synchronous unzip path.

The code sums central-directory uncompressed-size metadata before calling synchronous decompression. Malformed metadata could still weaken the intended expansion protection.

**Improvement:** use bounded/streaming decompression or validate actual inflated output incrementally in addition to declared sizes.

### 31. LOW-MEDIUM / attachment robustness — malformed numeric XML entities can throw

**Status: FIXED** — numeric entities are range-checked before `String.fromCodePoint()`; out-of-range values and surrogate code points are replaced with U+FFFD instead of throwing.

`String.fromCodePoint()` is called on parsed numeric XML entity values without explicitly validating the Unicode range.

**Improvement:** validate code points and replace/reject invalid entities gracefully.

### 32. LOW-MEDIUM / attachment classification — text detection is too permissive

**Status: FIXED** — unknown files must now pass NUL-byte, fatal UTF-8 decoding, and control-character-density checks before being treated as text. Known image/PDF/Office types continue to use explicit classification.

An unknown file is considered text when the first 8 KiB contains no NUL byte. Some binary formats can satisfy that heuristic and then be decoded as UTF-8 text.

**Improvement:** combine MIME/signature checks, UTF-8 validity, and control-character density.

### 33. MEDIUM / output sanitization — provider errors can expose raw provider output

**Status: FIXED** — provider error details now pass through one sanitizer that strips terminal controls and redacts Bearer tokens, common credential assignments, and URL passwords before text reaches user-facing errors or invalid-JSON diagnostics.

Several failure paths include raw stdout/stderr or invalid JSON fragments in user-facing errors. Terminal controls and sensitive strings are not uniformly sanitized/redacted.

**Improvement:** centralize provider-error sanitization, remove terminal control sequences, and redact credential/token patterns before displaying output.

### 34. LOW-MEDIUM / provider discovery — public model discovery runs even when official discovery succeeds

**Status: FIXED** — model discovery now tries the signed-in official Antigravity subscription first and only requests the public model catalog when official discovery fails or returns no models.

`discoverGoogleModels()` performs official and public discovery in parallel. This creates an unnecessary public network request and additional dependency/latency in the normal successful-provider case.

**Improvement:** try official subscription discovery first and use the public catalog only as fallback.

### 35. LOW / parsing — provider model parser accepts almost any first token

**Status: FIXED** — provider model rows now require a model-shaped ID with a supported family prefix; progress/header text such as `Fetching models...` and `Available models:` is ignored.

`parseAntigravityModels()` takes the first token from each nonempty line. Unexpected provider status/header text can be interpreted as a model ID.

**Improvement:** require a valid known model-ID pattern.

### 36. LOW-MEDIUM / diagnostics — `doctor` checks npm registry connectivity rather than normal Google-operation endpoints

**Status: FIXED** — `doctor` now reports separate unauthenticated reachability checks for the npm registry, the platform-specific official Antigravity installer endpoint, and the public Gemini model documentation endpoint in addition to the provider/account health probes.

A machine can reach npm while the provider installer, authentication service, or model endpoints are blocked.

**Improvement:** provide separate network-health checks for relevant provider endpoints without sending credentials.

### 37. MEDIUM / install side effects — Windows PATH mutation occurs during `prepare`

**Status: FIXED** — the npm `prepare` hook was removed. Persistent Windows PATH setup now has a single lifecycle owner in `postinstall` (with the existing explicit CI/install opt-out), so it no longer runs early during package preparation.

`prepare` invokes PATH configuration, and `postinstall` also performs installation bootstrap. `prepare` can run before an install fully succeeds and introduces persistent user-state mutation earlier than necessary.

**Improvement:** perform persistent PATH mutation at one clearly defined successful-install step or via an explicit setup operation.

### 38. MEDIUM / release hygiene — package `0.1.2` has no changelog entry

**Status: FIXED** — `CHANGELOG.md` now includes a dated `0.1.2` entry describing the changes that were actually present in that published release.

`package.json` and `package-lock.json` are version `0.1.2`, while `CHANGELOG.md` currently ends at `0.1.1`.

**Improvement:** add a `0.1.2` changelog entry describing the released changes.

### 39. MEDIUM / documentation correctness — README reports the wrong current version

**Status: FIXED** — the release documentation now reports package version `0.1.2`.

The README says the repository is configured with version `0.1.1`, contradicting package metadata at `0.1.2`.

**Improvement:** update the release documentation and preferably avoid manually duplicated current-version text where possible.

### 40. LOW / documentation correctness — README still references `antigyc-0.1.1.tgz`

**Status: FIXED** — the local tarball install example now references `antigyc-0.1.2.tgz`.

A local-install example is pinned to an outdated tarball filename.

**Improvement:** use `0.1.2` or a version-neutral placeholder.

### 41. MEDIUM / documentation contradiction — README both promises no visible tool stream and demonstrates one

**Status: FIXED** — the workflow section now explicitly states that file/command/tool events stay internal and shows only the allowed generic transient activity line behavior.

One README section displays `Editing:`, `Created:`, `Running: npm test`, and similar progress lines, while another section states there is no visible tool stream. `AGENTS.md` clearly requires the no-stream behavior.

**Improvement:** align the README with the implementation rule and remove contradictory visible-tool-stream examples.

### 42. LOW-MEDIUM / repository consistency — statusline/title examples conflict with the wrapper's UX rules

**Status: FIXED** — the examples are now explicitly segregated and labeled as proprietary provider-CLI reference material, with a dedicated README stating that they are not `antigyc` runtime/design examples and must not override the wrapper's plain-terminal rules.

The repository's own instructions prohibit status bars, colors, model badges, emojis, and similar product chrome, while the `examples/statusline` and `examples/title` directories demonstrate those concepts for the proprietary provider CLI.

**Improvement:** clearly segregate these as vendor/provider examples or remove them from this wrapper repository to prevent implementation drift.

### 43. LOW / activity UX — the activity delay is bypassed by phase changes

**Status: FIXED** — phase/message updates before the delay now update state only; rendering begins only after the configured initial delay. A regression sets `Preparing` immediately and verifies the TTY remains untouched until the timer fires.

The indicator has a configured initial delay, but `setPhase()` immediately renders on TTY output. Normal request startup calls `setPhase()` right away, so very fast operations can flash a progress line despite the delay feature.

**Improvement:** let phase changes update state without forcing initial rendering until the delay has elapsed.

### 44. MEDIUM / release workflow — `release:check` cannot succeed once the current version is already published

**Status: FIXED** — `release:check` now contains reusable syntax/test/audit/package validation only. Publishability is isolated in `release:publish-check` so an already-published version does not invalidate repository health checks.

The audit's `release:check` passed syntax checks, tests, audit, and package dry-run, then failed because npm correctly rejected a publish dry-run for already-published version `0.1.2`.

**Improvement:** separate immutable repository validation from the question of whether this exact version is publishable.

### 45. LOW / release workflow — README recommends duplicate publish dry-runs

**Status: FIXED** — release documentation now runs the reusable repository gate once and documents the separate publishability dry-run without triggering the prepublish lifecycle twice.

`release:check` already performs `npm publish --dry-run --ignore-scripts --json`, while the README recommends another `npm publish --dry-run --json` immediately afterward. That second invocation can trigger `prepublishOnly`, causing the release checks to run again.

**Improvement:** simplify the release lifecycle and avoid duplicated validation/publish-dry-run execution.

### 46. MEDIUM / CI support policy — `engines.node` claims broader support than CI tests

**Status: FIXED** — the declared runtime policy is now explicit (`20 || 22 || 24`) and CI exercises all three supported Node major lines across Windows, macOS, and Linux.

The package declares Node `>=20`, while CI explicitly covers Node 20 and 22. This semver declaration also claims compatibility with Node 23, 24, 25, and future majors. The audit happened to pass all tests on Node 24.19.0, but that is not part of CI policy.

**Improvement:** either constrain the engine range to the actual support policy or test all Node majors/LTS lines that the package claims to support.

### 47. MEDIUM / CI — dependency audit is absent from CI

**Status: FIXED** — CI runs `npm audit --audit-level=moderate` on the Ubuntu/Node 24 matrix leg in addition to syntax, test, and package checks.

Local `release:check` runs `npm audit`, but the CI matrix runs syntax checks, tests, and package dry-run only.

**Improvement:** add `npm audit --audit-level=moderate` or another automated dependency-vulnerability scanner to CI.

### 48. MEDIUM / quality tooling — there is no lint/static-quality configuration

**Status: FIXED** — ESLint flat configuration is now part of the repository, `npm run lint` passes, the reusable release gate includes lint, and every CI matrix leg runs it. The first lint pass also surfaced and corrected redundant assignments and wrapped errors that discarded their original causes.

`npm run check` runs `node --check`, which validates JavaScript syntax but does not detect many quality and correctness problems such as unsafe patterns, unused code, suspicious async behavior, or risky shell constructs.

**Improvement:** add ESLint or an equivalent static-analysis step with a focused, maintainable ruleset.

### 49. MEDIUM / coverage — there is no coverage gate

**Status: FIXED** — `npm run coverage` now runs the full Node test suite through `c8` with enforced floors of 75% lines/statements/functions and 60% branches. The latest full release run passes at 78.92% lines/statements, 66.9% branches, and 83.1% functions; CI runs the gate on Ubuntu/Node 24 and `release:check` runs it before packaging.

The built-in coverage run reported approximately 78.93% line coverage, 63.61% branch coverage, and 81.05% function coverage overall. `cli.js` has especially low directly measured coverage, partly because many integration paths execute in child processes.

**Improvement:** add coverage reporting with subprocess-aware instrumentation and sensible per-module thresholds rather than relying only on global percentages.

### 50. MEDIUM / missing regression tests — high-risk audit findings are not covered

**Status: FIXED** — dedicated regressions now cover the command-sandbox policy/fail-closed path plus a real Linux escape attempt in provisioned CI, provider digest/provenance enforcement, auth cancellation propagation, large Windows-safe stdin prompt transport, failed-command events, hidden normal tool output, >1 MiB ranged reads, checkpoint traversal/duplicate/symlink attacks, publication races, environment-secret filtering, process-tree termination policy, and package/lock/changelog version consistency.

Add regression coverage for at least:

- shell/process escape from the staging boundary;
- managed-provider digest enforcement;
- Ctrl+C during authentication/provider install;
- Windows prompts/history above the process argv limit;
- failed-command event status;
- normal CLI having no tool stream;
- ranged reads for files above 1 MiB;
- checkpoint manifest traversal/tampering;
- realpath/symlink resume-container attacks;
- concurrent edits during the apply window;
- environment-secret filtering;
- changelog/package-version consistency.

### 51. LOW / validation discovery — npm validation script discovery is narrow

**Status: FIXED** — discovery now recognizes `verify`, `ci`, `test:unit`, `test:integration`, `test:e2e`, and `lint:ci` in addition to the original standard script names.

The discovery logic recognizes only exact names such as `check`, `test`, `lint`, `typecheck`, and `build`. Common project scripts such as `verify`, `ci`, `test:unit`, `test:integration`, `test:e2e`, or `lint:ci` are ignored.

**Improvement:** expand discovery or derive likely validation scripts from package metadata more flexibly.

### 52. LOW / atomicity semantics — multi-file patching is rollback-based, not strictly atomic

**Status: FIXED** — the tool description and test terminology now describe this accurately as prevalidated multi-file patching with best-effort rollback rather than claiming strict atomic filesystem semantics.

`apply_patch` validates hunks before writing and attempts to restore prior contents after a later write failure. That is useful transactional behavior, but the rollback itself is best-effort and can theoretically fail.

**Improvement:** describe this as validated multi-file patching with rollback unless stronger atomic filesystem semantics are implemented.

### 53. LOW / API robustness — `initializeProject()` does not validate an externally supplied filename

**Status: FIXED** — exported initialization now accepts only a simple basename inside the project root and rejects absolute, traversal, and nested paths.

The CLI itself uses `AGENTS.md`, but the exported function accepts a `fileName` option and joins it directly to the workspace. A caller can pass a traversal path such as `../file`.

**Improvement:** require a basename or otherwise validate the target as a safe project-relative path.

### 54. LOW / event schema correctness — event fields are filtered globally rather than by event type

**Status: FIXED** — each safe event type now has its own field allowlist, so file events cannot retain command data and command events cannot retain file paths.

`createAgentEvent()` accepts supported fields without enforcing which fields are valid for each event type. A file event can therefore retain a command field, for example.

**Improvement:** maintain a field allowlist per event type.

### 55. LOW / persistence evolution — settings/history write versioned data without enforcing migrations

**Status: FIXED** — settings and history accept legacy unversioned v1-compatible data but reject unknown explicit schema versions, establishing a migration boundary for future formats.

Settings and history persist `version: 1`, but their load paths do not enforce/migrate schema versions as strictly as task-state loading does.

**Improvement:** validate schema version and provide explicit migrations before future persistence changes.

### 56. LOW / dead or stale code — several abstractions appear test-only

**Status: FIXED** — the obsolete Google `buildReasoningDefaults`/reasoning-target configuration path and unused `windowsPathContains` helper were removed together with tests that existed only to exercise those dead exports. Runtime reasoning still uses the provider's supported `--effort` path, and PATH persistence keeps its actual normalization logic.

Examples observed during the audit include `buildReasoningDefaults()` and `windowsPathContains()`, which have little or no production-path usage beyond tests.

**Improvement:** connect useful abstractions to runtime behavior or remove obsolete helpers to reduce misleading maintenance surface.

### 57. LOW / override validation — `ANTIGRAVITY_CLI_BINARY` is documented as absolute but relative values are accepted

**Status: FIXED** — overrides are validated with platform-appropriate absolute-path semantics. External overrides are health-checked only and are never installed or replaced by `ensure`.

The implementation runs `path.resolve()` on the value rather than rejecting a relative override.

**Improvement:** explicitly require an absolute path and report a clear configuration error for relative values.

### 58. HIGH / provider compatibility — default Google reasoning omitted a required effort value

**Status: FIXED** — the runtime default, Google account agent default, and Antigravity request-builder defaults now use `high` reasoning. Requests for the default `gemini-3.8-flash` model therefore include `--effort high` instead of omitting `--effort`. Regression coverage verifies both normal and stream-JSON request builders include the high effort default.

The provider rejects `gemini-3.8-flash` when no effort is supplied, reporting that the model requires `--effort` with one of `low`, `medium`, or `high`. The wrapper previously combined `gemini-3.8-flash` with `reasoning=auto`, and `auto` intentionally omitted the provider flag, making the fresh default configuration invalid for this provider/model combination.

**Improvement:** keep the default reasoning aligned with provider requirements and retain explicit reasoning overrides only when they map to values accepted by the selected model.

## Recommended remediation order

### Phase 1 — safety guarantees

Prioritize findings **#1, #2, #3, #4, #5, #9, #10, #11, and #12**. These affect the trust boundary, provider supply chain, rollback promises, and access to user secrets.

### Phase 2 — confirmed runtime correctness

Fix **#6, #7, #8, #14, #16, #18, and #20**. These include the confirmed Windows `spawn ENAMETOOLONG` failure, cancellation gaps, incorrect progress/event behavior, weak validation semantics, and settings escalation.

### Phase 3 — robustness and scale

Address **#21 through #37**, particularly provider rollback, process-tree termination, large-file tooling, history budgeting, Office archive hardening, and sanitized error handling.

### Phase 4 — release, CI, docs, and maintainability

Resolve **#38 through #57**: release/version documentation drift, release-script design, CI coverage, lint/static analysis, coverage gates, regression tests, and cleanup of smaller API/schema issues.

## Overall assessment

The project already has a strong automated test baseline and a thoughtful staged-edit design, but several guarantees currently exist only at the wrapper level rather than as enforceable OS/runtime boundaries. The most important work is therefore not cosmetic refactoring: it is tightening command isolation, provider provenance, checkpoint integrity, environment handling, cancellation, and large-prompt transport.

The observed `spawn ENAMETOOLONG` error is a concrete manifestation of one of those gaps and should be treated as a high-priority runtime bug rather than an isolated environment problem.
