# AGENTS.md

## Project purpose

Firefox Workspace Manager is a Firefox WebExtension for persistent multi-window workspaces, tab-group aware organization, tab lifecycle management, and safe restoration of browser state.

## Repository workflow

- `main` is stable/reviewed.
- `dev` is active development.
- All implementation work lands in `dev` first.
- Do not merge to `main` without explicit user decision.

## Project memory and state

- Shared long-term context is stored in ZLKL AI Memory.
- Stable project identity: `memory.issueIdentity = firefox.workspace-manager`.
- `AGENTS.md` contains durable project rules and architecture decisions.
- `workstate.md` contains current progress, next steps, blockers and local handoff instructions.
- Redmine is only authoritative if/when a Redmine issue is explicitly attached to this project.

## Remote/local collaboration

Remote ChatGPT and local Codex may cooperate through the repository and ZLKL AI Memory.

### localCommand protocol

When work requires local filesystem access, a local Firefox instance, VS Code, shell execution, or other machine-local capability unavailable remotely:

1. Remote side writes a concrete task under `localCommand` in `workstate.md`.
2. Local Codex reads `AGENTS.md`, `workstate.md`, and the shared AI Memory context before execution.
3. Local Codex executes only the requested scope.
4. Local Codex records the result under `localResult`, including changed files, commands/tests run, and blockers.
5. Local Codex updates `workstate.md` and, for durable decisions or stable facts, writes them to the same AI Memory issueIdentity.
6. Remote side reads the updated state before continuing.

Do not use `localCommand` for secrets. Never place passwords, tokens, private keys or credentials into repository state or AI Memory.

## Development environment

- Use a dedicated Firefox development profile at `.dev/firefox-profile`.
- Do not test destructive lifecycle behavior against the user's production Firefox profile.
- Prefer local-first, dependency-light implementation.
- Avoid external services unless they provide a clear technical advantage.

## Architecture and code quality

- Canonical architecture and invariants are documented in `docs/architecture.md`.
- KEEP: prevent automatic discard where Firefox API permits.
- AUTO: extension-managed policy/timeout behavior.
- DEEP: explicit `tabs.discard()`.
- A true frozen JS-runtime sleep state is outside normal WebExtension control.
- Firefox runtime window/tab/group IDs are not persistent identities; use extension-owned logical IDs and content fingerprints.
- Runtime JavaScript uses native ES modules; do not add a bundler/transpiler without a concrete need.
- Use `// @ts-check` and JSDoc types for runtime JavaScript.
- Put shared complex shapes in `src/types/domain.js`.
- Prefer classes/services for stateful domains and plain exported functions for stateless algorithms.
- Comments should explain invariants, lifecycle boundaries and reasons rather than restating the next line.
- Never reintroduce load-then-immediate-discard during workspace restore; saved DEEP tabs are created discarded to protect canonical URLs.
- Never let transient runtime `about:blank` overwrite a previously known canonical workspace URL.
- Do not hand-edit generated `package-lock.json`; regenerate it through npm.


## JavaScript structure and typing

- Runtime JavaScript uses native ES modules; do not introduce a bundler unless the project explicitly decides to.
- New runtime JS files start with `// @ts-check`.
- Use JSDoc typedefs for domain structures and typed function parameters/returns.
- Prefer focused stateful services/classes for persistence/lifecycle/UI state and plain exported functions for stateless algorithms.
- Architectural comments explain invariants and reasons, not obvious line-by-line behavior.
- Keep restore/snapshot/fingerprint invariants documented in `docs/architecture.md` synchronized with code changes.
- Do not hand-edit `package-lock.json`; regenerate it through npm locally when dependencies/package metadata require it.


## AMO listed release process

- Every listed AMO release/update must include saved **Version Notes** describing that version's changes.
- Keep AMO summary/description as the long-lived product description; use Version Notes only for per-version release changes.
- Prefer generating Version Notes from repository release notes/changelog when practical so the step is not forgotten manually.


## DOM rendering safety

- Dynamic manager/popup UI must use DOM nodes, not dynamic `innerHTML`.
- Use `src/shared/H.js` for concise DOM construction. `H` is intentionally a DOM-only helper and must not become a general utility dumping ground.
- Keep `H` methods typed and documented with JSDoc; short names are acceptable because the class purpose and method contracts are explicit.


## Release changelog

- `CHANGELOG.md` is the canonical source for user-facing release history and AMO Version Notes.
- Git commits are implementation history and may be used as input when drafting changelog entries, but they are not the public release notes themselves.
- Every user-visible release block should update CHANGELOG before signing/publishing.
