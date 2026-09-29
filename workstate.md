# workstate.md

memory.issueIdentity = firefox.workspace-manager

## Status

phase = bootstrap
branch = dev

## Done

- 0.3.6: Workspace restore no longer blocks on sequential DEEP/discard operations.
- Restore now creates all windows, tabs and groups first, persists the active workspace, then discards previously DEEP tabs in parallel as post-processing.
- Export inspection confirmed the saved Práce workspace currently contains a stale third logical window from earlier broken restore attempts; do not auto-delete it yet.

- 0.3.5: Workspace groups now use stable groupKey values instead of relying on Firefox runtime group IDs.
- Existing saved workspaces are migrated on load from runtimeGroupId membership to groupKey membership.
- Restore groups tabs by stable groupKey and keeps runtime group IDs only as fallback/debug context.

- 0.3.4: Workspace detail now shows window -> group -> tabs.
- Workspace debug log is visible directly under the expanded workspace.
- Restore/switch request has a 20s UI timeout, so a stuck background call cannot leave the button disabled forever.
- Restore API calls are instrumented and have per-step timeouts.

- Prevented automatic creation of a new workspace when closed workspaces already exist but none is active.
- Added workspace debug log in background for create/snapshot/close/restore operations.
- Added simple workspace detail tree: workspace name -> window0/windowN -> tab title + URL.
- Added Export JSON per workspace and Import JSON for creating a new workspace with fresh internal IDs.
- Version bumped to 0.3.2.

- Fixed phantom-workspace race during restore.
- Restore now suppresses automatic workspace snapshots until newly created windows are mapped back to the target workspace.
- If no active workspace exists, switching/restoring now goes directly to the selected workspace instead of snapshotting the manager window into a new workspace.
- Manager-only/blank windows no longer create a workspace when no workspace is active.
- Extension manager tabs are excluded from workspace snapshots.
- Version bumped to 0.3.1.

- Workspace UI now distinguishes runtime-open windows from total stored logical windows.
- Added reconciliation of stale runtime window mappings so old logical windows are marked closed if their Firefox window no longer exists.

- Added dedicated Workspaces tab.
- Workspaces tab supports active status, window/tab/group totals, rename, save current state, save as new, switch/restore and delete.
- Workspace switch restores the target workspace before closing previous windows, preventing Firefox from exiting when switching from the last open window.
- Popup header now shows the active workspace name.
- Added complete built-in Nápověda tab covering lifecycle states, panels, workspaces, Sync, popup/statistics and dev-mode reload behavior.
- Removed duplicate closed-workspace UI from Panely; workspace restore/management is centralized in Workspaces.
- Development version bumped to 0.3.0.

- Versioning convention adopted: pre-1.0 uses 0.MINOR.PATCH; MINOR for feature blocks, PATCH for bug/build fixes.
- Current development version bumped to 0.2.0.
- Popup shows the extension version from manifest.json in a small footer.

- Fixed workspace data model: one workspace now owns multiple windows, not one workspace per window.
- Legacy per-window workspace records are migrated into a single multi-window workspace.
- Closing one window only closes that logical window inside the workspace; closing the last window closes the workspace.
- Restore now recreates all windows belonging to the workspace, including tabs and groups per window.
- Closed-workspace UI now shows window/tab/group totals across the whole workspace.

- Added stable logical workspaceId mapping for normal Firefox windows.
- Workspace snapshots are stored separately from runtime windowId.
- Closing a Firefox window marks its workspace closed instead of deleting the snapshot.
- Manager shows closed persistent workspaces with an Obnovit action.
- Restore recreates the window, tabs, pin state, active tab and Firefox tab groups; previously discarded inactive tabs are discarded again after restore.
- Added optional Firefox Sync settings toggle.
- Sync scope is intentionally limited to AUTO settings, hostname policies and exact URL exceptions; runtime state/statistics/workspace snapshots remain local.

- Popup redesigned as a compact statistics dashboard; no duplicate tab list.
- Popup now follows dark/light theme via color-scheme.
- web-ext dev watcher now ignores .git metadata plus non-runtime project files; this targets unexplained manager-tab closures caused by extension reloads from background Git/VS Code file changes.

- Verified multi-window active-tab behavior: one active tab per Firefox window is protected from DEEP, so an apparently persistent tab may simply be active in another window.
- MPI TECH case explained by being the active tab in the second window; after pull/reload it disappeared when no longer protected.
- Keep the 30s watchdog as a recovery/self-heal mechanism for update/reload edge cases.

- 30-second watchdog now covers both DEEP ALWAYS enforcement and AUTO self-healing.
- AUTO tabs missing lifecycle/deadline state are recreated by watchdog; existing inactiveSince is preserved when available.
- Per-tab discard diagnostics exposed in manager: attempt time, reason, result and discardedAt.

- AUTO timeout changes now preserve each tab's original inactiveSince; changing timeout no longer restarts countdowns from zero.
- Pending inactive tabs are recomputed against the new timeout and overdue tabs are swept immediately.

- Multi-window listing verified with two Firefox windows; groups and ungrouped tabs render separately per window.
- Countdown persistence fixed across manager close/reopen by preserving existing inactiveSince/deadline state.
- Extension manager no longer replaces logical active content tab for lifecycle/statistics.
- Per-host statistics now track both foreground and background time.
- Host settings show active/background utilization ratio and total observed time.
- Tab rows now show DEEP ALWAYS / KEEP ALWAYS / EXCEPT; countdown is reserved for AUTO.

- Per-tab EXCEPT toggle added next to DEEP.
- EXCEPT now stores exact full URL KEEP exceptions, not hostname or URL prefix.
- Exact URL exception is visibly marked on the tab row and honored by single-tab, group, bulk and automatic DEEP.

- AUTO lifecycle engine added: per-tab inactiveSince/deadline state, one next-deadline browser alarm, automatic discard when due.
- Manager shows live countdown to automatic DEEP.
- Per-host usage statistics collected: activations, total foreground time, last activation/deactivation, auto-deep count.
- URL-prefix KEEP exceptions added with higher priority than hostname policy.
- Extension icon added and wired into manifest/action.

- Background tracks last active normal HTTP/HTTPS content tab per Firefox window.
- Full manager protects that last active content tab from DEEP ALL.
- Zavřít manager activates the previous content tab before closing manager.

- Full manager split into Panely | Nastavení tabs.
- Manager self-protection now uses its exact tab ID in addition to extension URL detection.
- Nastavení: global AUTO settings added and persisted.
- Host policy list: without filter shows only hosts from currently open tabs; with filter searches known/saved hosts and caps output at 30.

- Internal extension pages are now permanently excluded from DEEP actions.
- Full manager has an explicit Zavřít button.
- Settings panel open/closed state persists across manager refresh/reload.

- Group-level DEEP action added; it protects active, pinned and audible tabs.
- Settings panel added with lifecycle policy stored per exact hostname/subdomain, not per tab.
- Host policy modes: AUTO, KEEP, DEEP.

- Full-page manager added for large tab collections.
- Compact Unicode status indicators added: ● active, ✓ loaded, ○ deep/unloaded; extra flags use practical symbols.
- Popup can open/reuse the full manager tab.

- Bulk DEEP action added: discards all eligible inactive tabs while protecting active, pinned and audible tabs.

- Diagnostic popup added: windows, groups, tab state flags and manual DEEP discard.

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

1. Pull 0.3.1 and restart the dev task.
2. From the current state, click Obnovit on Práce.
3. Verify no new Workspace 4/5 is created.
4. Verify Práce becomes AKTIVNÍ and all of its saved windows return.
5. If successful, delete the stale Workspace 2 and Workspace 3 records manually.
6. Re-test closing both windows sequentially, reopening Firefox/manager, and restoring Práce.
7. Then continue with the close-intent dialog: Ponechat ve workspace / Odebrat z workspace / Zavřít celý workspace.

## localCommand

status = done
owner = local-user
task = Pull latest dev and test DEEP ALL EXCEPT ACTIVE. Verify active, pinned and audible tabs stay loaded while other eligible tabs become discarded and remain in their groups.

## localResult

status = success
summary = DEEP ALL EXCEPT ACTIVE ověřeno v sandbox Firefoxu. Při aktivním nic.cz byly ostatní vhodné taby uvolněny z paměti; about:processes po akci ukazoval prakticky jen aktivní nic.cz, service worker YouTube a systémové Firefox procesy. Skupiny/taby zůstaly zachované.
