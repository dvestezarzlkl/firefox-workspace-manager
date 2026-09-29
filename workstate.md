# workstate.md

memory.issueIdentity = firefox.workspace-manager

## Status

phase = bootstrap
branch = dev

## Done

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

1. Pull latest dev and verify an AUTO tab without a deadline is repaired within 30 seconds.
2. Verify DEEP ALWAYS tabs are re-discarded by watchdog if they become loaded while inactive.
3. Inspect discard diagnostics on Google after watchdog runs.
4. Verify manager reopen does not reset existing AUTO countdowns.
5. Continue monitoring watchdog overhead and multi-window behavior.

## localCommand

status = done
owner = local-user
task = Pull latest dev and test DEEP ALL EXCEPT ACTIVE. Verify active, pinned and audible tabs stay loaded while other eligible tabs become discarded and remain in their groups.

## localResult

status = success
summary = DEEP ALL EXCEPT ACTIVE ověřeno v sandbox Firefoxu. Při aktivním nic.cz byly ostatní vhodné taby uvolněny z paměti; about:processes po akci ukazoval prakticky jen aktivní nic.cz, service worker YouTube a systémové Firefox procesy. Skupiny/taby zůstaly zachované.
