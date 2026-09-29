# workstate.md

memory.issueIdentity = firefox.workspace-manager

## Status

phase = bootstrap
branch = dev

## Done

- Repository initialized.
- `main` and `dev` branches created.
- Initial Manifest V3 extension skeleton added.
- Window/tab/tab-group snapshot prototype added.
- VS Code / web-ext development tooling started.
- Dedicated development Firefox profile chosen.

## Current decisions

- Develop on `dev`; keep `main` stable.
- Test in isolated Firefox profile, not production profile.
- Use AGENTS.md for durable project rules.
- Use this file for active state and remote/local handoff.
- Use ZLKL AI Memory context `firefox.workspace-manager` for shared long-term context.

## Next

1. Finalize VS Code task for sandbox Firefox launch.
2. Verify current Firefox/tabGroups API behavior in the isolated profile.
3. Add diagnostic UI showing windows, groups, tabs and discarded state.
4. Implement first safe manual DEEP discard action.
5. Design logical persistent workspace IDs before automatic restore.

## localCommand

status = idle
owner = none
task = none

## localResult

status = none
summary = none
