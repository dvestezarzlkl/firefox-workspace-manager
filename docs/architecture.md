# Architecture

## Goal

Treat Firefox windows and tab groups as persistent workspaces rather than disposable browser UI.

## Lifecycle modes

- KEEP: prevent automatic browser discard.
- AUTO: leave discard decisions to Firefox initially; later add policy/timeout logic.
- DEEP: explicitly discard eligible inactive tabs.

A true Android-like frozen/suspended JS runtime is outside the normal WebExtension API and is not part of the first implementation.

## Persistent window model

Firefox window IDs and tab-group IDs are runtime identifiers and must not be treated as stable identities across restarts. The extension therefore keeps its own logical workspace identity and snapshots window/tab/group metadata.

Phase 1 records browser state only. Restore policy will be added after validating exactly what Firefox preserves through the sessions API.

## Development rule

All active development goes to `dev`. `main` remains reviewable/stable.
