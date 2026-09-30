# Firefox Workspace Manager

Firefox WebExtension for persistent multi-window workspaces, tab lifecycle management and safe restore.

Current development version: **0.6.0**

## Branches

- `main` - stable/reviewed releases
- `dev` - active development

## Core features

### Tab lifecycle

- KEEP / AUTO / DEEP lifecycle policies
- Per-hostname policy: AUTO, KEEP, DEEP
- Exact-URL EXCEPT/KEEP overrides
- Automatic discard after configurable inactivity
- DEEP ALWAYS watchdog and AUTO self-healing
- Active tab protection per Firefox window
- Optional pinned/audio protection
- Manual DEEP for one tab, one group or all eligible tabs
- Live AUTO countdown in the manager
- Per-host foreground/background usage statistics

### Workspaces

A workspace is a persistent set of Firefox windows. Each window snapshot contains its tabs, native Firefox tab groups and relevant tab state.

- Multiple windows per workspace
- Stable logical workspace/window IDs independent of runtime Firefox IDs
- Restore closed workspaces
- Restore tabs, tab groups, active tab and pinned state
- Save current workspace state
- Save current state as a new workspace
- Rename workspace
- Switch between workspaces
- Delete workspace definitions
- Active workspace name shown in popup

Native window close cannot be intercepted before Firefox closes the window. The extension therefore preserves the workspace snapshot and manages intent after the close rather than relying on runtime window IDs.

### Manager

The full-page manager contains:

- **Panely** - searchable/collapsible windows, groups and tabs, combinable lifecycle/policy filters, manual actions and optional auto-refresh
- **Workspaces** - workspace management and switching
- **Nastavení** - AUTO settings, hostname rules, exact URL exceptions and optional Firefox Sync
- **Nápověda** - built-in usage and behavior reference

### Popup

Compact dashboard showing:

- active workspace name, or last-used inactive workspace with one-click session recovery
- windows
- tabs
- groups
- active / loaded / deep tabs
- AUTO pending
- DEEP ALWAYS
- KEEP ALWAYS
- URL exceptions
- extension version

### Firefox Sync

Optional `storage.sync` support for lightweight settings:

- AUTO settings
- hostname policies
- exact URL exceptions

Runtime state, tab/window IDs, countdowns, usage statistics and workspace snapshots remain local.

## Versioning

Before stable 1.0:

- `0.MINOR.PATCH`
- MINOR = larger functional block
- PATCH = bug fix / build fix

The popup reads the version directly from `manifest.json`.

## Architecture

Runtime code uses native ES modules and plain JavaScript with `// @ts-check` + JSDoc.
Stateful domains are separated into services/controllers; stateless algorithms live in
shared modules. See `docs/architecture.md` for module boundaries and invariants.

Key persistent identities are extension-owned workspace/logical-window IDs and a
deterministic SHA-256 window-content fingerprint. Firefox runtime IDs are attachment
metadata only.

## Development

Development runs through `web-ext` using a dedicated profile under `.dev/firefox-profile`.

Useful commands:

```bash
npm install
npm run dev
npm run lint
npm run build
```

VS Code uses `jsconfig.json` for project-wide JavaScript type checking. Runtime
entrypoints and modules use `// @ts-check`; shared shapes are documented in
`src/types/domain.js`.

Do not hand-edit `package-lock.json`; regenerate it with npm when package metadata
or dependencies actually change.

The development watcher ignores Git metadata and non-runtime project files. Changes to runtime extension files still reload the extension; an open `moz-extension://` manager tab can therefore disappear during development reloads.

Development changes land in `dev`. Stable changes are merged into `main`.
