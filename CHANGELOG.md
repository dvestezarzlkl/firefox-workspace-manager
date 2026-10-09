# Changelog

This file contains user-facing release changes for Workspace Manager.

Use Git history for implementation detail. Use this changelog as the canonical
source for release notes and AMO Version Notes.

## Unreleased

## 0.8.1 - 2026-10-09

### Fixed
- Complete application restore now reattaches an existing Firefox workspace when every saved window has a unique, exact fingerprint match among currently open windows; it no longer leaves such a workspace incorrectly inactive.
- Changed, missing, duplicated or ambiguous windows are never attached silently.
- When full application restore cannot safely reattach live windows, manager and popup explicitly warn that Recover will open additional windows and request confirmation. Background also blocks unconfirmed duplicate recovery.
- Unresolved application restore blocks automatic fuzzy reattachment, including after a Firefox restart, so a changed live session cannot silently overwrite restored backup snapshots.


## 0.8.0 - 2026-10-09

### Added
- Complete versioned application Backup/Restore in Settings.
- Full backup includes all workspaces, AUTO settings, hostname policies, exact URL exceptions, Firefox Sync preference, known hosts, aggregate host statistics, workspace debug history and stable manager UI preferences.
- Application backup filename uses `yyyyMMddHHmmss_workspace_manager.json`.

### Safety
- Application restore never imports ephemeral Firefox runtime IDs, active window mappings, tab lifecycle deadlines or snapshot locks.
- Current Firefox windows stay open during restore; restored workspaces remain inactive until explicitly recovered.
- Panel explorer backup preserves only stable preferences (Always expanded and refresh interval), never runtime window/group disclosure IDs.

## 0.7.0 - 2026-10-01

### Added
- Backup and restore all saved workspaces in one versioned JSON bundle.
- Import provenance metadata: original creation time, import time, source filename and original workspace name.
- Duplicate-name protection for single and collection imports.
- Timestamp prefixes on single-workspace and workspace-collection exports.

### Changed
- Single-workspace export format is now version 2; imports remain backward compatible with version 1.
- Workspace cards show creation/import provenance.
- Built-in Help documents LIVE snapshot behavior and workspace backup/restore.

## 0.6.4 - 2026-10-01

### Changed
- Replaced dynamic `innerHTML` rendering in manager and popup with typed DOM construction through `H`.

### Fixed
- Removed all AMO validator warnings caused by unsafe dynamic HTML assignment.

## 0.6.3 - 2026-09-30

### Added
- First listed AMO submission metadata in Czech and English.
- Listed AMO publishing task and release metadata workflow.

## 0.6.2 - 2026-09-30

### Fixed
- Workspace switching now restores and verifies the target before closing the previous workspace windows.
- Prevented profile-specific Firefox exit caused by stale/reused runtime window IDs.

## 0.6.1 - 2026-09-30

### Changed
- Improved Panels visual hierarchy and Firefox tab-group color indicators.
- Filters temporarily expand matching windows and groups without overwriting manual disclosure state.

## 0.6.0 - 2026-09-30

### Changed
- Structural refactor into typed ES modules and focused services/controllers.
- Added project-wide `// @ts-check`, JSDoc domain types and architecture documentation.
