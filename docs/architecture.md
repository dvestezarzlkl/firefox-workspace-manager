# Architecture

Firefox Workspace Manager is intentionally implemented as a dependency-light
Firefox WebExtension. Runtime code uses native ES modules and plain JavaScript
with `// @ts-check` + JSDoc types; there is no bundler or transpilation step.

## Module map

### Background

- `src/background.js`
  - WebExtension bootstrap and event wiring.
  - Workspace orchestration: snapshot, restore, reattach, switch, import/export.
  - Message router between manager/popup and background services.
- `src/background/WorkspaceStore.js`
  - Canonical workspace persistence boundary.
  - Runtime-window mapping persistence.
  - Snapshot lock.
  - Structured workspace debug log.
  - Legacy workspace/group-key normalization.
- `src/background/TabLifecycleManager.js`
  - AUTO / KEEP / DEEP runtime lifecycle.
  - Inactivity deadlines and alarms.
  - Host usage statistics.
  - Discard diagnostics and DEEP ALWAYS watchdog.
- `src/background/AppBackupService.js`
  - Versioned complete application disaster-recovery backup.
  - Durable settings/data whitelist.
  - Restore-time invalidation of Firefox runtime IDs, active mappings and snapshot locks.

### Shared

- `src/shared/H.js` — typed DOM construction helper (`H.el`, `H.txt`, `H.append`, `H.clear`, `H.replace`); dynamic values become text/properties rather than parsed HTML.
- `src/shared/constants.js` — storage keys and shared defaults.
- `src/shared/url.js` — URL classification and restore-safe URL helpers.
- `src/shared/windowFingerprint.js` — deterministic content fingerprint and
  fuzzy fallback matching.
- `src/types/domain.js` — JSDoc domain/runtime types.
- `src/types/globals.d.ts` — dynamic WebExtension `browser` runtime global.
- `jsconfig.json` — project-wide JavaScript type checking.

### Manager / popup

- `src/manager/manager.js` — manager controller, rendering and user actions.
- `src/manager/PanelExplorerController.js` — UI-only disclosure state and
  panel auto-refresh.
- `src/popup/popup.js` — compact status/recovery dashboard.

The manager and popup are native ES-module extension pages.

## Core invariants

### Runtime IDs are not identities

Firefox `windowId`, tab `id` and tab-group `id` are ephemeral runtime
handles. They may change after browser restart/session restore.

Persistent identities are:

- `workspace.id` — workspace identity.
- `logicalWindowId` — persistent logical window identity.
- `groupKey` — stable group key inside one logical window snapshot.
- `fingerprint` — deterministic identity of window content used for native
  session reattachment.

`runtimeWindowId`, `runtimeTabId` and `runtimeGroupId` are attachment
metadata only.

### Window fingerprint

A window fingerprint is SHA-256 over a deterministic sorted list of:

`normalized group title | normalized URL`

Runtime IDs and screen geometry are deliberately excluded.

Exact fingerprint match is the primary reattach mechanism. Fuzzy URL/title/group
matching is only a fallback when native Firefox restore changed one item.

### Snapshot URLs are canonical data

A saved workspace URL must not be replaced by a transient runtime
`about:blank`.

Firefox can temporarily expose a lazy/discarded or privileged restored tab as
`about:blank`. Snapshot code therefore preserves the previous canonical URL
when the live blank is known to be a transient representation.

Saved DEEP tabs are restored directly with `tabs.create({ discarded: true })`
where possible. The old load-then-immediately-discard sequence must not be
reintroduced: it can discard a tab before navigation commits and permanently
turn the next snapshot into `about:blank`.

### Restore owns the workspace model

Workspace restore acquires a snapshot lock and increments restore depth.
Automatic snapshot/lifecycle work must not mutate workspace state while restore
is constructing runtime windows.

Switching workspace restores the target first and only then closes old
workspace windows. This prevents Firefox from exiting when the previous
workspace contained the last browser windows.

### Active and last-used workspace are different concepts

- `fwm.activeWorkspaceId` identifies the workspace currently mapped to live
  Firefox windows.
- `fwm.lastWorkspaceId` survives when no workspace is active and powers
  one-click popup session recovery.

Do not infer last-used state from window runtime IDs.

### Application restore reattachment safety

Restore never copies stale Firefox runtime IDs from the backup. Immediately after
restoring the portable workspace definitions it computes fresh fingerprints of
*currently open* windows and matches them against all saved workspaces.

Only a complete one-to-one exact fingerprint match can attach a workspace and
mark it active. Duplicate, missing or changed windows remain detached to avoid
mapping another workspace or immediately overwriting a backed-up URL.

An unresolved application restore carries a transient-recovery safeguard in
`fwm.applicationRestorePending`. It disables automatic fuzzy reattachment
and requires an explicit warning/confirmation before Recover creates extra
windows. The safeguard survives browser restart and clears only after safe
full attachment or successful explicit recovery.

### Application backup never restores runtime identity

Complete application backup is intentionally a durable-data backup, not a raw
`storage.local` dump. It includes workspaces, AUTO/KEEP/DEEP configuration,
Sync preference, known hosts, aggregate host statistics, diagnostics and stable
manager preferences.

Restore must reset or exclude:

- active workspace runtime state;
- `windowWorkspaceMap`;
- runtime window/tab/group IDs as attachments;
- tab lifecycle deadlines keyed by runtime tab IDs;
- last-active runtime tab IDs;
- snapshot locks and transient browser-state cache.

Existing Firefox windows stay open during application restore. Restored
workspaces remain inactive until the user explicitly chooses Recover session.

### UI state is not workspace data

Panel explorer expanded/collapsed state, Always expanded and manager
auto-refresh are UI preferences stored in `localStorage`.

They must never be written into workspace snapshots or affect fingerprints.

### Sync scope is intentionally small

Firefox `storage.sync` contains only lightweight configuration:

- AUTO settings.
- Hostname policies.
- Exact URL exceptions.

Workspace snapshots, runtime IDs, lifecycle deadlines, statistics and debug
history remain local.

## DOM rendering and HTML safety

Dynamic UI must be built as DOM nodes. Do not reintroduce dynamic `innerHTML`
or string-template HTML rendering for manager/popup data.

Use the small `H` helper for repetitive DOM construction:

- `H.el()` creates an element with typed/common properties and children.
- `H.txt()` creates an explicit text node.
- `H.append()` appends optional Node/text children.
- `H.clear()` / `H.replace()` clear or replace children.

`H` is deliberately limited to HTML/DOM concerns. Hashing, timers, workspace
logic and other utilities belong in their own modules.

## JavaScript conventions

- New runtime JS files start with `// @ts-check`.
- Complex object shapes belong in JSDoc typedefs, not undocumented anonymous
  objects repeated throughout the project.
- Stateful domains should be services/classes.
- Stateless transformations and algorithms should be plain exported functions.
- Comments explain invariants, lifecycle boundaries and reasons. Avoid comments
  that merely translate the next line of code.
- Prefer extension-owned stable IDs over Firefox runtime IDs for persistence.
- Do not hand-edit generated `package-lock.json`; regenerate it through npm.

## Refactor boundary in 0.6.0

0.6.0 intentionally does not rewrite the working workspace restore algorithm.
Persistence, lifecycle state, shared algorithms and manager disclosure state are
already separated into modules/services. Workspace restore/orchestration remains
in `background.js` for this release so the recently stabilized multi-window
recovery and DEEP URL-integrity behavior can be regression-tested independently.

A later structural pass may extract `WorkspaceService` /
`WorkspaceRestorer` after 0.6.0 behavior is verified.
