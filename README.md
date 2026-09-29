# Firefox Workspace Manager

Firefox WebExtension focused on persistent workspaces, tab lifecycle management and safe restoration of multi-window sessions.

## Branches

- `main` - stable/reviewed releases
- `dev` - active development

## Planned core features

- Persistent logical workspaces mapped to Firefox windows
- Restore accidentally closed persistent windows
- Per-domain / per-workspace lifecycle rules
- KEEP / AUTO / DEEP modes
- Automatic tab discard for DEEP mode
- Native Firefox tab-group awareness
- Reuse/focus an already open URL instead of duplicating tabs
- Local-first storage; no external service required

## Development

During development load `manifest.json` from `about:debugging#/runtime/this-firefox`.

Development changes land in `dev`. Stable changes are merged into `main`.
