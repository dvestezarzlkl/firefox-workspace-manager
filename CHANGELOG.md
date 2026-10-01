# Changelog

This file contains user-facing release changes for Workspace Manager.

Use Git history for implementation detail. Use this changelog as the canonical
source for release notes and AMO Version Notes.

## Unreleased

### Added
- Workspace collection backup/restore.
- Workspace import provenance and duplicate-name protection.
- Timestamped export filenames.

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
