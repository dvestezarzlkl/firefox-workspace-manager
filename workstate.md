# workstate.md

memory.issueIdentity = firefox.workspace-manager

## Status

phase = bootstrap
branch = dev

## Done

- 0.7.0: Added versioned backup/restore of the full workspace collection.
- Single workspace export format bumped to v2 with exportedAt, createdAt and provenance; v1 imports remain supported.
- Imports now preserve original createdAt and record importedAt, source filename and original workspace name.
- Single and collection imports reject duplicate names; manager requires a new name or allows cancelling the complete import.
- Collection restore validates all workspace names/formats before a single storage write, preventing half-imported bundles.
- Single exports now use `yyyyMMddHHmmss_<workspace>.json`; collection backups use `yyyyMMddHHmmss_workspaces.json`. Device suffix is omitted because no trustworthy hostname is available through the current WebExtension API.
- Workspace cards show creation/import provenance.
- Added CHANGELOG.md as the canonical source for user-facing release history and AMO Version Notes.

- 0.6.4 H DOM refactor regression test passed: popup, Workspaces, workspace detail tree, Panels, Settings and Help render correctly after removal of dynamic innerHTML; workspace recovery also passed.

- 0.6.4: Added typed/JSDoc DOM helper `src/shared/H.js` with `H.el`, `H.txt`, `H.append`, `H.clear` and `H.replace`.
- Replaced all dynamic `innerHTML` rendering in manager.js and popup.js with real DOM construction through H.
- Converted host policies, URL exception rules, panel/tab rendering, workspace cards/tree/debug log and popup statistics without changing event delegation or CSS class/data-attribute contracts.
- AMO 0.6.3 reported five "Unsafe assignment to innerHTML" warnings; 0.6.4 source now contains zero `.innerHTML` assignments in manager/popup/H and should remove those validator warnings.
- Added architectural invariant: H is DOM-only; unrelated utilities remain in dedicated modules.

- 0.6.3: Version bumped for the first listed AMO submission. Extension code is unchanged from 0.6.2 plus the AMO publication tooling/metadata.
- Only manifest.json carries the extension release version; package.json/package-lock.json are intentionally not bumped for extension-only releases.

- Added bilingual CZ/EN AMO listing metadata in amo-metadata.json for the first listed submission.
- AMO category is Tabs; license MPL-2.0; reviewer notes document plain JS/native modules, no remote code and no data collection.
- Added npm script sign:listed and VS Code task "FF: Publikovat listed na AMO", reusing local ../.dev/amo-sign.cmd credentials.
- Build, listed sign and unlisted sign explicitly exclude amo-metadata.json from the packaged extension.
- UI localization remains deferred to the 1.0-era backlog; only the AMO store listing is localized now.

- 0.6.2: Hardened workspace switching after a Firefox 157 profile-specific failure where switching could close all Firefox windows.
- Switch no longer marks/detaches the current workspace before target restore. Existing windows remain live and mapped until the target is proven alive.
- Old switch windows are derived only from current live windowMap ownership, never persisted runtimeWindowId values.
- Closed target workspaces are restored with reuseLive=false so stale/reused Firefox runtime window IDs cannot be mistaken for an already-open target workspace.
- After restore, switch verifies returned target window IDs against browser.windows.getAll(); if no target window is live, switch aborts and preserves/reactivates the current workspace instead of closing anything.
- Added switch-begin, switch-target-verified, switch-target-restore-error, switch-aborted-no-live-target, switch-close-old-window-before/after and switch-end diagnostics.

- Firefox 157 production stress test passed on 0.6.1: ZLKL office workspace ~127-128 tabs / 33 groups / 2 windows.
- Tested copying workspace, removing one window and several tabs/groups, switching both directions, restarting Firefox after switches, and returning to the large workspace; active workspace was re-detected correctly after every restart.
- No new about:blank corruption observed during this test.
- Large-session restore visibly creates tabs first and groups them afterwards; treat this as a performance/UX optimization candidate, not a correctness bug.

- 0.6.1: Panel filters now temporarily expand every matching window and group; clearing the filter restores the persisted manual disclosure state.
- Panel visual polish completed after the 0.6.0 structural refactor: stronger window hierarchy, flatter groups, native Firefox group-color indicators, quieter inactive filters and secondary Expand/Collapse controls.
- Removed textual group color names (purple/cyan/orange/...) from panel headers; color is now shown visually.
- Tab rows now use a CSS chain-link icon instead of the old bookmark-like outline.

- 0.6.0 structural/documentation refactor prepared without intentional behavior changes.
- Added shared JSDoc domain/runtime types and project-wide // @ts-check / jsconfig checkJs.
- Extracted WorkspaceStore for persistence, runtime mapping, snapshot lock, migration and debug log.
- Extracted TabLifecycleManager for AUTO / KEEP / DEEP lifecycle, alarms, statistics and discard diagnostics.
- Extracted PanelExplorerController for UI-only disclosure state and auto-refresh.
- Extracted shared storage constants, URL helpers and deterministic window fingerprint logic.
- Manager and popup now run as native ES-module extension pages and reuse shared modules.
- Added docs/architecture.md with runtime-ID, fingerprint, snapshot URL, restore-lock, active-vs-last-used, UI-state and Sync invariants.
- 0.6.0 deliberately leaves the working restore orchestration in background.js until regression-tested; WorkspaceRestorer extraction is a later safe structural pass.
- Refactor checkpoint audited after an interrupted tool stream: module files exist, HTML module loading is wired, old lifecycle/panel-state duplicate implementations are absent, and class method call/link checks pass.

- 0.5.6: Workspace action text now follows global active-workspace state instead of the target workspace open/closed flag.
- When any workspace is active, other workspace cards show "Přepnout".
- "Recover session" is shown only when no workspace is active.
- Confirmation text and runtime message now match the operation: switchWorkspace for switching, restoreWorkspace for recovery.

- 0.5.5: Popup now distinguishes active workspace from the last used inactive workspace.
- Added persistent fwm.lastWorkspaceId, updated whenever a workspace becomes active/used; clearing activeWorkspaceId does not clear lastWorkspaceId.
- If no workspace is active, popup shows the last used workspace name with "Naposledy použitý · neaktivní" and a direct Recover session button.
- Recover session calls the existing restoreWorkspace flow; this provides one-click recovery even when Firefox itself starts with a clean/non-restored session, as long as a workspace snapshot exists.
- Existing installs without lastWorkspaceId fall back to the most recently restored/updated workspace.

- 0.5.4: Critical workspace data-integrity fix for DEEP/lazy restored tabs.
- Restore now creates saved DEEP tabs directly with tabs.create({discarded:true,title,url}) instead of creating/loading them and immediately calling tabs.discard().
- This removes the race where tabs.create resolves before navigation commits and the immediate discard can leave the runtime tab at about:blank.
- Workspace snapshot now defensively preserves the previous canonical URL/title when a discarded/lazy runtime tab transiently reports about:blank/newtab/home at the same index.
- The same preservation protects privileged about:* source pages that must use about:blank as a runtime restore placeholder.
- New debug event snapshot-preserved-canonical-url records every time the guard prevents destructive URL replacement.
- restore-tab-create-before now logs createDiscarded; deferred post-restore discard is only a fallback if direct discarded creation fails.

- 0.5.3: Panel tree controls top row rebalanced: Always expanded on the left, Expand all / Collapse all on the right.
- Group headers now use a single left-aligned icon+title cluster so folder/ungrouped icons no longer visually float independently from their labels.

- 0.5.2: Rebalanced Panels toolbar after visual review: filter badges remain on the left; tree controls are on the right in two rows.
- Right toolbar row 1 contains Expand all / Collapse all / Always expanded; row 2 contains Refresh selector.
- Tab/bookmark icon now lives directly in the title row instead of a separate grid column, so icon and title align naturally with other content.

- 0.5.1: Panel hierarchy headers now have lightweight CSS window/folder/bookmark icons and stronger visual separation.
- Panel toolbar is split into two columns: tree controls on the left and state/policy filter badges on the right.
- Added Expand all, Collapse all and persistent Always expanded controls.
- Added persistent panel auto-refresh selector: Off / 5 / 10 / 30 / 60 seconds.
- Manual and automatic refresh now capture currently open window/group details before rebuilding the DOM, so expanded/collapsed state survives refresh.
- Filtering/search expansion stays temporary and is not accidentally written into the user's manual disclosure state.
- package-lock root version metadata was aligned with extension/package version.

- Dev tooling: Added VS Code Task Runner action "Git: Pull" for the current workspace.

- 0.5.0: Panels page redesigned as a scalable explorer for large sessions.
- Added fulltext search across tab title, URL and Firefox tab-group title.
- Added combinable state filters (Active, Loaded, Deep) and policy filters (AUTO, KEEP always, DEEP always, EXCEPT) with live counts.
- Windows are collapsed by default and rendered as native details/summary disclosure sections; groups are independently collapsible.
- Manual window/group expansion is UI-only and remembered in localStorage, never written into workspace snapshots.
- Search auto-expands matching windows/groups; broad state/policy filters expand matching windows while leaving groups compact.
- Filtered headers show visible/total tab counts; no lifecycle/backend semantics were changed.
- Tab rows now show a compact URL line under the title.

- 0.4.19: Window SHA-256 fingerprint is now the primary content identity across snapshot, native reattach, startup/session reconciliation, export and import.
- Workspace JSON export now stores fingerprintVersion and fingerprint per window.
- Import never blindly trusts exported fingerprints: it recomputes from group-name/URL content and logs mismatches.
- Startup reconciliation can reattach Firefox-native restored windows that existed before the extension background started, but only on a unique exact fingerprint match.
- runtimeWindowId remains ephemeral; logicalWindowId remains internal persistent identity; fingerprint represents persistent window content identity.

- 0.4.18: Added deterministic SHA-256 fingerprints for logical Firefox windows.
- Fingerprint input is a sorted canonical list of "normalized group title | normalized URL" rows; runtime tab/group IDs are excluded.
- Saved window snapshots now persist fingerprintVersion=1 + fingerprint.
- Native reopened windows compute the same fingerprint and exact matches reattach immediately.
- Existing pre-0.4.18 snapshots get fingerprints lazily on first comparison.
- Previous fuzzy URL/title/group scoring remains only as fallback when an exact fingerprint does not match.

- 0.4.17: Native Firefox reopened windows (Ctrl+Shift+N / session restore) can be reattached to their saved logical workspace window.
- Reattach never creates a new logical window; it only matches against an existing closed saved window.
- Matching uses tab URL/title overlap, tab-count similarity and group-title overlap, with ambiguity rejection to avoid ghost-window adoption.
- Successful reattach updates runtime window mapping, marks the logical window open, keeps the workspace active and snapshots the reopened runtime state.
- Reattach detection is debounced across window/tab/group restore events so large native-restored windows can finish populating before matching.

- 0.4.16: VS Code signing task now loads AMO credentials from ../.dev/amo-sign.cmd before running npm run sign:unlisted.
- Credentials stay outside the repository and are not committed to Git.

- 0.4.15: Fixed empty manager footer metadata by moving manager.js after the footer DOM, so version/developer elements exist before script initialization.

- 0.4.14: Fixed manager startup regression introduced by footer metadata: managerVersion and managerDeveloper DOM elements are now declared before use.

- 0.4.13: Added standard Firefox manifest developer metadata (dvestezar.cz + homepage URL).
- Manager footer now reads developer name/URL dynamically from browser.runtime.getManifest(); "pro ZLKL" remains UI-specific metadata.

- 0.4.12: Added a subtle manager footer with dynamic manifest version and attribution: "od dvestezar.cz · pro ZLKL".

- 0.4.11: Uložit jako nový replaced by Uložit akt. stav jako nový.
- New workspace creation no longer depends on activeWorkspaceId or an existing workspace snapshot.
- The action captures the current live Firefox normal windows directly, including tabs and native tab groups.
- Current runtime windows are remapped to the new workspace; previous saved workspace definitions remain intact as closed snapshots.
- The new workspace is persisted, read-back verified, and automatically activated only after successful validation.

- 0.4.10: Added VS Code task FF: Podepsat unlisted XPI, running npm run sign:unlisted with visible dedicated terminal output.

- 0.4.9: Public add-on name changed from Firefox Workspace Manager to Workspace Manager to satisfy AMO trademark validation.
- Gecko extension ID remains firefox-workspace-manager@dvestezar.cz so extension identity/storage stays stable.
- Manager/popup branding updated and malformed Refresh button markup fixed.

- 0.4.8: Added Firefox MV3 data_collection_permissions required:["none"] for AMO signing.
- Added npm script sign:unlisted using web-ext sign --channel=unlisted.
- AMO API credentials must come from WEB_EXT_API_KEY / WEB_EXT_API_SECRET environment variables; do not store them in the repository.

- 0.4.7: Dedicated Firefox dev profile moved outside the repository to ../.dev/firefox-profile.
- predev now creates ../.dev and web-ext no longer needs to ignore .dev because the profile is outside --source-dir.

- 0.4.6: Restore no longer reuses the window shell about:blank tab as the first saved tab.
- Every saved tab is created explicitly with tabs.create; the temporary shell tab is removed afterward.
- This removes the special first-tab path that could revert MPI (or another first URL) back to about:blank after recovery/session transitions.
- Restore debug now includes deferredDiscardEntries with source URL and restored tab ID.

- 0.4.5: groupKey is now authoritative for imported/current workspace data.
- Explicit groupKey:null means ungrouped and is never migrated through legacy runtimeGroupId fallback.
- Legacy runtimeGroupId migration is used only when the groupKey property is completely absent.
- Imported ungrouped tabs now use runtimeGroupId:null, avoiding collision with synthetic imported group IDs (-1, -2, ...).
- Restore group debug now includes the exact tabIds selected for each group.

- 0.4.4: Startup reconciliation now clears fwm.activeWorkspaceId when the active workspace has no live mapped Firefox windows.
- inferActiveWorkspaceFromRuntime validates the stored active workspace against live runtime mappings instead of trusting stale state.
- Manager UI only labels a workspace AKTIVNÍ when it has at least one open logical window; a zero-window workspace remains recoverable.

- 0.4.3: VS Code FF tasks no longer depend on the built-in npm task provider.
- All FF tasks are plain shell tasks using npm commands and explicit workspace cwd.
- Task terminals always reveal, so npm install/dev/lint/build output is visible.

- 0.4.2: Automatic workspace snapshots can update only runtime windows already mapped to that workspace.
- Unmapped runtime windows are ignored and logged as snapshot-skipped-unmapped-window; they can no longer create ghost logical windows.
- Uložit stav explicitly adopts only genuinely unmapped content windows, never windows already owned by another workspace.
- Uložit jako nový now uses the explicit save path before cloning.

- 0.4.1: Recovery now holds a persistent workspace snapshot lock in storage.local for the entire restore operation.
- Snapshot entry points refuse to write while the lock is active, even if the background context reloads and workspaceRestoreDepth resets.
- Automatic snapshotAllWindows on extension startup/install/module load was removed.
- Blank/manager-only windows are no longer persisted into an existing workspace snapshot.
- Imported workspace definitions therefore remain read-only during Recover session and cannot be overwritten by partially restored shell windows.

- 0.4.0: Workspace recovery is now two-phase.
- Phase 1 creates and maps all Firefox windows as about:blank shells before any tabs/groups are populated.
- Phase 2 populates each shell with saved tabs, groups, active tab and geometry.
- AUTO/DEEP lifecycle handlers, watchdog and alarms are paused while workspace recovery is active.
- Saved discarded state is applied only after all windows/tabs/groups are fully restored.
- Runtime lifecycle state is re-seeded only after the entire recovery completes.

- 0.3.13: Workspace Debug log has a Copy button.
- Copied log format is plain text: HH:MM:SS | event | JSON data.
- Clipboard output includes extension version, workspace name and workspace ID header for easier debugging in chat.

- 0.3.12: Restore window creation now uses the minimum windows.create payload (URL only).
- Added explicit restore-window-create-error logging around browser.windows.create.
- Ghost logical windows are treated as historical artifacts from the earlier restore/snapshot race, not the current cause of the missing last window.

- 0.3.11: Active workspace can be inferred from live runtime windows and fwm.windowWorkspaceMap when activeWorkspaceId is missing/stale.
- Recover session is now idempotent: if mapped workspace windows already exist, it reuses them instead of creating duplicates.
- Uložit jako nový and Uložit stav recover the active workspace from runtime mappings before operating.

- 0.3.10: Renamed the global manager reload action to Refresh.
- Closed workspace restore action is now labeled Recover session; open non-active workspaces still use Přepnout.

- 0.3.9: Workspace store now actually runs groupKey normalization on load.
- Workspace detail now has Vyřadit per logical window; this only edits the saved workspace definition and never closes a runtime Firefox window.
- Active workspace status continues to use fwm.activeWorkspaceId as the source of truth.
- Debug log confirmed Firefox successfully creates restored tab groups (restore-group-after) for videa, ZLKL, čtení and partneři.

- 0.3.8: Restore no longer aborts on Firefox-internal URLs such as about:processes.
- Non-restorable internal URLs are restored as about:blank and logged as substituted, allowing the rest of the window and its tab groups to restore.
- Extension manager URLs remain excluded from workspace restore.

- 0.3.7: Multi-window restore no longer passes saved geometry into windows.create.
- Window geometry is applied afterward as best-effort; negative/off-screen multi-monitor coordinates cannot abort restore.
- Each logical window restore is isolated: failure of windowN is logged and restore continues with windowN+1.

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

1. Pull 0.7.0 and reload the extension.
2. Export one workspace and verify the filename starts with yyyyMMddHHmmss and the JSON reports format version 2.
3. Re-import the same workspace: duplicate-name guard must require a new name or cancel.
4. Verify the imported workspace card shows createdAt/importedAt/source/original-name provenance correctly.
5. Run Backup workspaces, inspect the collection JSON, then Restore workspaces.
6. During collection restore, verify duplicate names are resolved before import and that existing workspaces are not overwritten.
7. Recover one restored workspace and verify windows/groups/tabs/fingerprints remain correct.
8. Run web-ext lint and unlisted validation before distributing 0.7.0.

## localCommand

status = done
owner = local-user
task = Pull latest dev and test DEEP ALL EXCEPT ACTIVE. Verify active, pinned and audible tabs stay loaded while other eligible tabs become discarded and remain in their groups.

## localResult

status = success
summary = DEEP ALL EXCEPT ACTIVE ověřeno v sandbox Firefoxu. Při aktivním nic.cz byly ostatní vhodné taby uvolněny z paměti; about:processes po akci ukazoval prakticky jen aktivní nic.cz, service worker YouTube a systémové Firefox procesy. Skupiny/taby zůstaly zachované.


## Backlog

- Workspace persistence modes: split two independent concerns instead of one combined select. Update mode = LIVE (current continuous workspace updates) vs MANUAL/PERMANENT SNAPSHOT (workspace changes only after explicit "Uložit stav"). Startup policy for manual/permanent workspaces = respect/start last Firefox session vs force this workspace active on browser start. In manual/permanent mode add "Uložit stav" to the popup. Update Help wording because current "Uložit stav = aktualizuje snapshot právě aktivního workspace" is misleading while LIVE mode already updates continuously. Implement after the current backlog, not now.

- Complete application backup/restore in Settings: one versioned backup file containing all settings, all workspaces and relevant application metadata for disaster recovery.
- Lifecycle/activity log for Panels: default-collapsed diagnostic log similar to workspace debug log. Record create/open, activate, inactive, deadline scheduled/recomputed, discard/DEEP, reload/reactivate and restore events with timestamp, tab ID/title/URL, workspace/window/group context when known, reason/policy and result. Keep a bounded history (roughly 200–500 events) and provide quick event-type filters.
