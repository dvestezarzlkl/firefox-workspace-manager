// @ts-check

import {
  ACTIVE_WORKSPACE_KEY,
  APP_RESTORE_PENDING_KEY,
  AUTO_SETTINGS_KEY,
  HOST_POLICIES_KEY,
  LAST_WORKSPACE_KEY,
  STORAGE_KEY,
  SYNC_ENABLED_KEY,
  SYNC_KEYS,
  URL_POLICIES_KEY,
  WINDOW_WORKSPACE_MAP_KEY,
  WORKSPACES_KEY
} from "./shared/constants.js";
import {
  hasWorkspaceContent,
  isExtensionUrl,
  isTransientBlankUrl,
  restoreUrlOrBlank
} from "./shared/url.js";
import {
  fingerprintLiveWindow,
  fingerprintSavedWindow,
  scoreWorkspaceWindowMatch
} from "./shared/windowFingerprint.js";
import { WorkspaceStore } from "./background/WorkspaceStore.js";
import { TabLifecycleManager } from "./background/TabLifecycleManager.js";
import { AppBackupService } from "./background/AppBackupService.js";
import { matchCompleteWorkspace } from "./background/WorkspaceRecoveryMatcher.js";

const workspaceStore = new WorkspaceStore();
const appBackupService = new AppBackupService();
const lifecycleManager = new TabLifecycleManager({
  isRestoreActive: () => workspaceRestoreDepth > 0,
  snapshotWindow: windowId => snapshotWindow(windowId)
});

const workspaceReattachTimers = new Map();
let workspaceRestoreDepth = 0;

function emptyState() {
  return { version: 1, windows: {}, updatedAt: Date.now() };
}

async function workspaceSnapshotLocked() {
  return workspaceStore.snapshotLocked(workspaceRestoreDepth);
}

async function acquireWorkspaceSnapshotLock(workspaceId, reason = "restore") {
  return workspaceStore.acquireSnapshotLock(workspaceId, reason);
}

async function releaseWorkspaceSnapshotLock(workspaceId) {
  return workspaceStore.releaseSnapshotLock(workspaceId);
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timeout after " + ms + " ms")), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function workspaceDebug(event, data = {}) {
  return workspaceStore.debug(event, data);
}

function newWorkspaceId() {
  return workspaceStore.newWorkspaceId();
}

function newLogicalWindowId() {
  return workspaceStore.newLogicalWindowId();
}

// Runtime reconciliation owns the bridge between persistent logical windows
// and ephemeral Firefox window IDs. Never promote a runtime ID to identity.
async function reconcileWorkspaceRuntimeState() {
  const stored = await browser.storage.local.get([
    WORKSPACES_KEY,
    WINDOW_WORKSPACE_MAP_KEY,
    ACTIVE_WORKSPACE_KEY
  ]);

  const workspaces = stored[WORKSPACES_KEY] ?? {};
  const windowMap = stored[WINDOW_WORKSPACE_MAP_KEY] ?? {};
  let activeWorkspaceId = stored[ACTIVE_WORKSPACE_KEY] ?? null;
  const liveWindows = await browser.windows.getAll({ windowTypes: ["normal"] });
  const liveIds = new Set(liveWindows.map(win => String(win.id)));

  let changed = false;

  for (const [runtimeId, mapping] of Object.entries(windowMap)) {
    if (liveIds.has(runtimeId)) continue;
    delete windowMap[runtimeId];
    const workspace = workspaces[mapping?.workspaceId];
    const logicalWindow = workspace?.windows?.[mapping?.logicalWindowId];
    if (logicalWindow?.open) {
      logicalWindow.open = false;
      logicalWindow.runtimeWindowId = null;
      logicalWindow.closedAt = Date.now();
      changed = true;
    }
  }

  for (const workspace of Object.values(workspaces)) {
    if (!workspace?.windows) continue;
    for (const logicalWindow of Object.values(workspace.windows)) {
      if (!logicalWindow?.open || logicalWindow.runtimeWindowId == null) continue;
      if (liveIds.has(String(logicalWindow.runtimeWindowId))) continue;
      logicalWindow.open = false;
      logicalWindow.runtimeWindowId = null;
      logicalWindow.closedAt = Date.now();
      changed = true;
    }

    const anyOpen = Object.values(workspace.windows).some(win => win?.open);
    if (workspace.open !== anyOpen) {
      workspace.open = anyOpen;
      changed = true;
    }

    const shouldBeActive = workspace.id === activeWorkspaceId && anyOpen;
    if (!!workspace.active !== shouldBeActive) {
      workspace.active = shouldBeActive;
      changed = true;
    }
  }

  if (activeWorkspaceId) {
    const activeWorkspace = workspaces[activeWorkspaceId];
    const hasLiveMappedWindow = Object.entries(windowMap).some(([runtimeId, mapping]) =>
      mapping?.workspaceId === activeWorkspaceId &&
      liveIds.has(runtimeId) &&
      !!activeWorkspace?.windows?.[mapping.logicalWindowId]
    );

    if (!activeWorkspace || !hasLiveMappedWindow) {
      await workspaceDebug("active-workspace-cleared-stale", {
        workspaceId: activeWorkspaceId,
        reason: "no-live-mapped-window"
      });
      activeWorkspaceId = null;
      changed = true;
    }
  }

  if (changed) {
    await browser.storage.local.set({
      [WORKSPACES_KEY]: workspaces,
      [WINDOW_WORKSPACE_MAP_KEY]: windowMap,
      [ACTIVE_WORKSPACE_KEY]: activeWorkspaceId,
      ...(activeWorkspaceId ? { [LAST_WORKSPACE_KEY]: activeWorkspaceId } : {})
    });
  }

  const normalizedGroups = normalizeWorkspaceGroupKeys(workspaces);
  if (normalizedGroups) {
    await browser.storage.local.set({ [WORKSPACES_KEY]: workspaces });
  }

  // Firefox may restore native windows before the extension background starts.
  // Reattach such windows by exact content fingerprint only; never fuzzy-match
  // during startup reconciliation.
  const populatedLiveWindows = await browser.windows.getAll({
    windowTypes: ["normal"],
    populate: true
  });

  const closedByFingerprint = new Map();
  for (const [workspaceId, workspace] of Object.entries(workspaces)) {
    for (const [logicalWindowId, savedWindow] of Object.entries(workspace?.windows ?? {})) {
      if (savedWindow?.open || savedWindow?.runtimeWindowId != null) continue;
      const fingerprint = savedWindow.fingerprint || await fingerprintSavedWindow(savedWindow);
      savedWindow.fingerprintVersion = 1;
      savedWindow.fingerprint = fingerprint;

      const list = closedByFingerprint.get(fingerprint) ?? [];
      list.push({ workspaceId, logicalWindowId, savedWindow });
      closedByFingerprint.set(fingerprint, list);
    }
  }

  let fingerprintReattached = false;

  for (const liveWindow of populatedLiveWindows) {
    const runtimeKey = String(liveWindow.id);
    if (windowMap[runtimeKey] || !hasWorkspaceContent(liveWindow)) continue;

    let liveGroups = [];
    try {
      liveGroups = await browser.tabGroups.query({ windowId: liveWindow.id });
    } catch {}

    const fingerprint = await fingerprintLiveWindow(liveWindow, liveGroups);
    const matches = closedByFingerprint.get(fingerprint) ?? [];
    if (matches.length !== 1) continue;

    const match = matches[0];
    const workspace = workspaces[match.workspaceId];
    const logicalWindow = workspace?.windows?.[match.logicalWindowId];
    if (!workspace || !logicalWindow) continue;

    windowMap[runtimeKey] = {
      workspaceId: match.workspaceId,
      logicalWindowId: match.logicalWindowId
    };

    logicalWindow.open = true;
    logicalWindow.runtimeWindowId = liveWindow.id;
    logicalWindow.closedAt = null;
    logicalWindow.updatedAt = Date.now();

    workspace.open = true;
    workspace.active = true;
    workspace.closedAt = null;
    workspace.updatedAt = Date.now();

    activeWorkspaceId = match.workspaceId;
    fingerprintReattached = true;

    await workspaceDebug("startup-fingerprint-reattached", {
      workspaceId: match.workspaceId,
      logicalWindowId: match.logicalWindowId,
      runtimeWindowId: liveWindow.id,
      fingerprint
    });
  }

  if (fingerprintReattached) {
    for (const [workspaceId, workspace] of Object.entries(workspaces)) {
      workspace.active = workspaceId === activeWorkspaceId && workspace.open;
    }

    await browser.storage.local.set({
      [WORKSPACES_KEY]: workspaces,
      [WINDOW_WORKSPACE_MAP_KEY]: windowMap,
      [ACTIVE_WORKSPACE_KEY]: activeWorkspaceId,
      ...(activeWorkspaceId ? { [LAST_WORKSPACE_KEY]: activeWorkspaceId } : {})
    });
  }

  return { workspaces, windowMap, activeWorkspaceId };
}

function normalizeWorkspaceGroupKeys(workspaces) {
  return workspaceStore.normalizeGroupKeys(workspaces);
}

async function loadWorkspaceStore() {
  return workspaceStore.load();
}

async function ensureActiveWorkspace(options = {}) {
  return workspaceStore.ensureActive(options);
}

// Canonical snapshot integrity -------------------------------------------------
// Workspace URLs are durable data; transient lazy/privileged about:blank is not.

/**
 * A discarded/lazy-restored Firefox tab can temporarily report about:blank
 * even though the workspace already knows its real URL. Never let that
 * transient runtime representation destroy the canonical workspace snapshot.
 */
function preserveCanonicalSnapshotTab(previousTab, liveTab) {
  if (!previousTab || !liveTab) return false;
  if (!isTransientBlankUrl(liveTab.url)) return false;
  if (!previousTab.url || isTransientBlankUrl(previousTab.url)) return false;

  // Normal DEEP/lazy tabs are the primary corruption case.
  if (liveTab.discarded || previousTab.discarded) return true;

  // Privileged about:* pages cannot be recreated by tabs.create(), so restore
  // intentionally uses about:blank as a runtime placeholder. Preserve the
  // original canonical URL in the workspace.
  if (
    String(previousTab.url).startsWith("about:") &&
    restoreUrlOrBlank(previousTab.url) === "about:blank"
  ) {
    return true;
  }

  return false;
}

async function saveWorkspaceSnapshot(win, groups) {
  if (await workspaceSnapshotLocked()) return null;

  const existing = await loadWorkspaceStore();
  if ((!existing.activeWorkspaceId || !existing.workspaces[existing.activeWorkspaceId]) && !hasWorkspaceContent(win)) {
    return null;
  }

  let store = existing;
  if (!existing.activeWorkspaceId || !existing.workspaces[existing.activeWorkspaceId]) {
    if (Object.keys(existing.workspaces).length > 0) {
      await workspaceDebug("snapshot-skipped-no-active-workspace", {
        windowId: win.id,
        tabCount: (win.tabs ?? []).length
      });
      return null;
    }
    store = await ensureActiveWorkspace({ allowCreate: true });
  }

  const { workspaces, windowMap, activeWorkspaceId } = store;
  const workspace = workspaces[activeWorkspaceId];
  const runtimeKey = String(win.id);

  if (!hasWorkspaceContent(win)) {
    await workspaceDebug("snapshot-skipped-empty-window", {
      workspaceId: activeWorkspaceId,
      runtimeWindowId: win.id,
      tabCount: (win.tabs ?? []).length
    });
    return null;
  }

  const mapping = windowMap[runtimeKey];
  if (!mapping || mapping.workspaceId !== activeWorkspaceId || !workspace.windows?.[mapping.logicalWindowId]) {
    await workspaceDebug("snapshot-skipped-unmapped-window", {
      workspaceId: activeWorkspaceId,
      runtimeWindowId: win.id,
      tabCount: (win.tabs ?? []).filter(tab => !isExtensionUrl(tab.url)).length
    });
    return null;
  }

  workspace.windows ??= {};
  const previousWindow = workspace.windows[mapping.logicalWindowId];
  const previousTabsByRuntimeId = new Map(
    (previousWindow?.tabs ?? [])
      .filter(tab => tab.runtimeTabId != null)
      .map(tab => [Number(tab.runtimeTabId), tab])
  );
  const previousTabsByIndex = new Map(
    (previousWindow?.tabs ?? []).map(tab => [Number(tab.index), tab])
  );
  const preservedCanonicalTabs = [];

  const snapshotTabs = (win.tabs ?? [])
    .filter(tab => !isExtensionUrl(tab.url))
    .map(tab => {
      const groupIndex = groups.findIndex(group => group.id === tab.groupId);
      // Prefer the stable runtime tab identity within the current Firefox
      // session. Index fallback is needed immediately after workspace restore,
      // because restored tabs necessarily receive new runtime IDs.
      const previousTab =
        previousTabsByRuntimeId.get(Number(tab.id)) ??
        previousTabsByIndex.get(Number(tab.index));
      const preserveCanonical = preserveCanonicalSnapshotTab(previousTab, tab);
      const url = preserveCanonical ? previousTab.url : tab.url;
      const title = preserveCanonical
        ? (previousTab.title || tab.title)
        : tab.title;

      if (preserveCanonical) {
        preservedCanonicalTabs.push({
          runtimeTabId: tab.id,
          index: tab.index,
          liveUrl: tab.url,
          canonicalUrl: previousTab.url,
          discarded: !!tab.discarded
        });
      }

      return {
        runtimeTabId: tab.id,
        index: tab.index,
        url,
        title,
        pinned: tab.pinned,
        active: tab.active,
        discarded: tab.discarded,
        audible: tab.audible,
        autoDiscardable: tab.autoDiscardable,
        cookieStoreId: tab.cookieStoreId,
        runtimeGroupId: tab.groupId,
        groupKey: groupIndex >= 0 ? "g" + groupIndex : null
      };
    });

  workspace.windows[mapping.logicalWindowId] = {
    id: mapping.logicalWindowId,
    open: true,
    runtimeWindowId: win.id,
    closedAt: null,
    updatedAt: Date.now(),
    window: {
      state: win.state,
      left: win.left,
      top: win.top,
      width: win.width,
      height: win.height,
      incognito: win.incognito
    },
    groups: groups.map((group, index) => ({
      runtimeGroupId: group.id,
      groupKey: "g" + index,
      title: group.title,
      color: group.color,
      collapsed: group.collapsed
    })),
    tabs: snapshotTabs
  };

  if (preservedCanonicalTabs.length) {
    await workspaceDebug("snapshot-preserved-canonical-url", {
      workspaceId: activeWorkspaceId,
      logicalWindowId: mapping.logicalWindowId,
      runtimeWindowId: win.id,
      tabs: preservedCanonicalTabs
    });
  }

  workspace.windows[mapping.logicalWindowId].fingerprintVersion = 1;
  workspace.windows[mapping.logicalWindowId].fingerprint =
    await fingerprintSavedWindow(workspace.windows[mapping.logicalWindowId]);

  workspace.updatedAt = Date.now();
  workspace.open = true;
  workspace.active = true;

  await browser.storage.local.set({
    [WORKSPACES_KEY]: workspaces,
    [WINDOW_WORKSPACE_MAP_KEY]: windowMap,
    [ACTIVE_WORKSPACE_KEY]: activeWorkspaceId,
    [LAST_WORKSPACE_KEY]: activeWorkspaceId
  });

  await workspaceDebug("snapshot-saved", {
    workspaceId: activeWorkspaceId,
    logicalWindowId: mapping.logicalWindowId,
    runtimeWindowId: win.id,
    tabs: workspace.windows[mapping.logicalWindowId].tabs.length,
    groups: workspace.windows[mapping.logicalWindowId].groups.length
  });

  return activeWorkspaceId;
}

// Native-session reattach ------------------------------------------------------
// Exact content fingerprint is primary. Fuzzy matching is only a guarded fallback.
async function tryReattachWorkspaceWindow(windowId) {
  if (workspaceRestoreDepth > 0 || await workspaceSnapshotLocked()) return false;

  const store = await loadWorkspaceStore();
  const runtimeKey = String(windowId);
  if (store.windowMap[runtimeKey]) return false;

  let win;
  try {
    win = await browser.windows.get(windowId, { populate: true });
  } catch {
    return false;
  }

  if (win.type !== "normal" || !hasWorkspaceContent(win)) return false;

  let liveGroups = [];
  try {
    liveGroups = await browser.tabGroups.query({ windowId });
  } catch {}

  const liveFingerprint = await fingerprintLiveWindow(win, liveGroups);

  const candidateWorkspaceIds =
    store.activeWorkspaceId && store.workspaces[store.activeWorkspaceId]
      ? [store.activeWorkspaceId]
      : Object.keys(store.workspaces);

  const exactCandidates = [];
  const fuzzyCandidates = [];

  for (const workspaceId of candidateWorkspaceIds) {
    const workspace = store.workspaces[workspaceId];
    if (!workspace?.windows) continue;

    for (const [logicalWindowId, savedWindow] of Object.entries(workspace.windows)) {
      if (savedWindow?.open || savedWindow?.runtimeWindowId != null) continue;

      const savedFingerprint = savedWindow.fingerprint ||
        await fingerprintSavedWindow(savedWindow);

      if (!savedWindow.fingerprint) {
        savedWindow.fingerprintVersion = 1;
        savedWindow.fingerprint = savedFingerprint;
      }

      if (savedFingerprint === liveFingerprint) {
        exactCandidates.push({
          workspaceId,
          logicalWindowId,
          savedWindow,
          match: {
            score: 1,
            accepted: true,
            method: "fingerprint",
            fingerprint: liveFingerprint
          }
        });
        continue;
      }

      const match = scoreWorkspaceWindowMatch(savedWindow, win, liveGroups);
      if (!match?.accepted) continue;

      fuzzyCandidates.push({
        workspaceId,
        logicalWindowId,
        savedWindow,
        match: {
          ...match,
          method: "fuzzy",
          liveFingerprint,
          savedFingerprint
        }
      });
    }
  }

  const candidates = exactCandidates.length ? exactCandidates : fuzzyCandidates;
  if (!candidates.length) return false;

  candidates.sort((a, b) => b.match.score - a.match.score);
  const best = candidates[0];
  const second = candidates[1];

  // Avoid silently attaching an ambiguous new window.
  if (
    second &&
    best.match.method !== "fingerprint" &&
    best.match.score < 0.90 &&
    (best.match.score - second.match.score) < 0.12
  ) {
    await workspaceDebug("window-reattach-ambiguous", {
      runtimeWindowId: windowId,
      best: {
        workspaceId: best.workspaceId,
        logicalWindowId: best.logicalWindowId,
        score: best.match.score
      },
      second: {
        workspaceId: second.workspaceId,
        logicalWindowId: second.logicalWindowId,
        score: second.match.score
      }
    });
    return false;
  }

  const workspace = store.workspaces[best.workspaceId];
  const logicalWindow = workspace.windows[best.logicalWindowId];
  const now = Date.now();

  store.windowMap[runtimeKey] = {
    workspaceId: best.workspaceId,
    logicalWindowId: best.logicalWindowId
  };

  logicalWindow.open = true;
  logicalWindow.runtimeWindowId = windowId;
  logicalWindow.closedAt = null;
  logicalWindow.updatedAt = now;

  workspace.open = true;
  workspace.active = true;
  workspace.closedAt = null;
  workspace.updatedAt = now;

  for (const [workspaceId, other] of Object.entries(store.workspaces)) {
    if (workspaceId !== best.workspaceId && other) other.active = false;
  }

  store.activeWorkspaceId = best.workspaceId;

  await browser.storage.local.set({
    [WORKSPACES_KEY]: store.workspaces,
    [WINDOW_WORKSPACE_MAP_KEY]: store.windowMap,
    [ACTIVE_WORKSPACE_KEY]: best.workspaceId,
    [LAST_WORKSPACE_KEY]: best.workspaceId
  });

  await workspaceDebug("window-reattached", {
    workspaceId: best.workspaceId,
    logicalWindowId: best.logicalWindowId,
    runtimeWindowId: windowId,
    matchMethod: best.match.method ?? "fuzzy",
    liveFingerprint,
    ...best.match
  });

  // Once ownership is restored, update the saved snapshot to the actual
  // reopened runtime state.
  await snapshotWindow(windowId);
  return true;
}

function scheduleWorkspaceWindowReattach(windowId, delayMs = 800) {
  if (workspaceRestoreDepth > 0 || windowId == null || windowId < 0) return;

  const previous = workspaceReattachTimers.get(windowId);
  if (previous) clearTimeout(previous);

  const timer = setTimeout(() => {
    workspaceReattachTimers.delete(windowId);
    tryReattachWorkspaceWindow(windowId).catch(console.error);
  }, delayMs);

  workspaceReattachTimers.set(windowId, timer);
}

async function markWorkspaceClosed(windowId) {
  const { workspaces, windowMap, activeWorkspaceId } = await loadWorkspaceStore();
  const runtimeKey = String(windowId);
  const mapping = windowMap[runtimeKey];
  if (!mapping) return;

  const workspace = workspaces[mapping.workspaceId];
  const logicalWindow = workspace?.windows?.[mapping.logicalWindowId];
  if (!workspace || !logicalWindow) return;

  logicalWindow.open = false;
  logicalWindow.runtimeWindowId = null;
  logicalWindow.closedAt = Date.now();
  logicalWindow.updatedAt = Date.now();
  delete windowMap[runtimeKey];

  const anyOpen = Object.values(workspace.windows ?? {}).some(win => win.open);
  workspace.open = anyOpen;
  workspace.active = anyOpen && activeWorkspaceId === workspace.id;
  workspace.updatedAt = Date.now();

  const updates = {
    [WORKSPACES_KEY]: workspaces,
    [WINDOW_WORKSPACE_MAP_KEY]: windowMap
  };

  if (!anyOpen && activeWorkspaceId === workspace.id) {
    updates[ACTIVE_WORKSPACE_KEY] = null;
    workspace.active = false;
    workspace.closedAt = Date.now();
  }

  await browser.storage.local.set(updates);
  await workspaceDebug("window-closed", {
    workspaceId: workspace.id,
    logicalWindowId: mapping.logicalWindowId,
    runtimeWindowId: windowId,
    workspaceStillOpen: anyOpen
  });
}

// Workspace restore ------------------------------------------------------------
// Restore runs under snapshot lock/restore depth so background observers cannot
// persist half-built windows as canonical workspace state.
async function createRestoreWindowShell(workspaceId, logicalWindowId, sourceWindow) {
  await workspaceDebug("restore-window-shell-before", {
    workspaceId,
    logicalWindowId,
    requestedGeometry: sourceWindow.window ?? null
  });

  let win;
  try {
    win = await withTimeout(
      browser.windows.create({ url: "about:blank" }),
      10000,
      "windows.create shell"
    );
  } catch (error) {
    await workspaceDebug("restore-window-shell-error", {
      workspaceId,
      logicalWindowId,
      error: String(error?.message ?? error)
    });
    throw error;
  }

  await workspaceDebug("restore-window-shell-after", {
    workspaceId,
    logicalWindowId,
    runtimeWindowId: win.id
  });

  return win.id;
}

async function populateRestoredWindow(workspaceId, logicalWindowId, sourceWindow, windowId) {
  const sourceTabs = (sourceWindow.tabs ?? [])
    .slice()
    .sort((a, b) => a.index - b.index)
    .filter(tab => !isExtensionUrl(tab.url));

  await workspaceDebug("restore-window-populate-begin", {
    workspaceId,
    logicalWindowId,
    runtimeWindowId: windowId,
    sourceTabCount: sourceTabs.length,
    sourceGroupCount: (sourceWindow.groups ?? []).length
  });

  const shellTabs = (await withTimeout(
    browser.tabs.query({ windowId }),
    5000,
    "tabs.query restore shell"
  )).slice().sort((a, b) => a.index - b.index);

  const shellTabIds = shellTabs.map(tab => tab.id).filter(id => id != null);
  const liveTabIds = [];

  // Never reuse the shell about:blank tab as restored content. Creating every
  // saved tab explicitly avoids the first-tab URL reverting to about:blank
  // during navigation/discard/session transitions.
  for (let i = 0; i < sourceTabs.length; i++) {
    const source = sourceTabs[i];
    const restoreUrl = restoreUrlOrBlank(source.url);

    await workspaceDebug("restore-tab-create-before", {
      workspaceId,
      logicalWindowId,
      sourceIndex: i,
      url: source.url,
      restoreUrl,
      substituted: restoreUrl !== source.url,
      createDiscarded: !!source.discarded && !source.active
    });

    const createDiscarded = !!source.discarded && !source.active;
    const createProperties = {
      windowId,
      url: restoreUrl,
      active: false
    };

    if (createDiscarded) {
      createProperties.discarded = true;
      if (source.title) createProperties.title = source.title;
    }

    let created;
    try {
      created = await withTimeout(
        browser.tabs.create(createProperties),
        5000,
        createDiscarded ? "tabs.create discarded" : "tabs.create"
      );
    } catch (error) {
      // Defensive fallback for a Firefox/API edge case: create normally and
      // defer discard. This path must not be the normal restore path.
      if (!createDiscarded) throw error;

      await workspaceDebug("restore-create-discarded-fallback", {
        workspaceId,
        logicalWindowId,
        sourceIndex: i,
        sourceUrl: source.url,
        restoreUrl,
        error: String(error?.message ?? error)
      });

      created = await withTimeout(browser.tabs.create({
        windowId,
        url: restoreUrl,
        active: false
      }), 5000, "tabs.create fallback");
    }

    liveTabIds.push(created.id);
  }

  if (sourceTabs.length && shellTabIds.length) {
    for (const shellTabId of shellTabIds) {
      try {
        await withTimeout(browser.tabs.remove(shellTabId), 3000, "tabs.remove restore shell");
      } catch (error) {
        await workspaceDebug("restore-shell-tab-remove-error", {
          workspaceId,
          logicalWindowId,
          runtimeWindowId: windowId,
          tabId: shellTabId,
          error: String(error?.message ?? error)
        });
      }
    }
  }

  await workspaceDebug("restore-tabs-created", {
    workspaceId,
    logicalWindowId,
    runtimeWindowId: windowId,
    liveTabCount: liveTabIds.length
  });

  const newTabByOldRuntimeId = new Map();
  for (let i = 0; i < Math.min(sourceTabs.length, liveTabIds.length); i++) {
    newTabByOldRuntimeId.set(sourceTabs[i].runtimeTabId, liveTabIds[i]);

    if (sourceTabs[i].pinned) {
      try {
        await withTimeout(
          browser.tabs.update(liveTabIds[i], { pinned: true }),
          3000,
          "tabs.update pinned"
        );
      } catch (error) {
        await workspaceDebug("restore-pin-error", {
          workspaceId,
          logicalWindowId,
          tabId: liveTabIds[i],
          error: String(error?.message ?? error)
        });
      }
    }
  }

  for (const [groupIndex, group] of (sourceWindow.groups ?? []).entries()) {
    const groupKey = group.groupKey ?? ("g" + groupIndex);
    const tabIds = sourceTabs
      .filter(tab => {
        if (Object.prototype.hasOwnProperty.call(tab, "groupKey")) {
          return tab.groupKey === groupKey;
        }
        return tab.runtimeGroupId === group.runtimeGroupId;
      })
      .map(tab => newTabByOldRuntimeId.get(tab.runtimeTabId))
      .filter(id => id != null);

    if (!tabIds.length) continue;

    await workspaceDebug("restore-group-before", {
      workspaceId,
      logicalWindowId,
      title: group.title ?? "",
      groupKey,
      tabCount: tabIds.length,
      sourceRuntimeGroupId: group.runtimeGroupId,
      tabIds
    });

    try {
      const newGroupId = await withTimeout(
        browser.tabs.group({
          tabIds,
          createProperties: { windowId }
        }),
        5000,
        "tabs.group"
      );

      await withTimeout(
        browser.tabGroups.update(newGroupId, {
          title: group.title ?? "",
          color: group.color,
          collapsed: !!group.collapsed
        }),
        5000,
        "tabGroups.update"
      );

      await workspaceDebug("restore-group-after", {
        workspaceId,
        logicalWindowId,
        title: group.title ?? "",
        groupKey,
        newGroupId
      });
    } catch (error) {
      await workspaceDebug("restore-group-error", {
        workspaceId,
        logicalWindowId,
        title: group.title ?? "",
        groupKey,
        error: String(error?.message ?? error)
      });
    }
  }

  const activeSource = sourceTabs.find(tab => tab.active);
  const activeTabId = activeSource
    ? newTabByOldRuntimeId.get(activeSource.runtimeTabId)
    : null;

  if (activeTabId != null) {
    try {
      await withTimeout(
        browser.tabs.update(activeTabId, { active: true }),
        3000,
        "activate restored tab"
      );
    } catch {}
  }

  if (sourceWindow.window?.state === "normal") {
    const geometry = {};
    for (const key of ["left", "top", "width", "height"]) {
      if (Number.isFinite(sourceWindow.window[key])) geometry[key] = sourceWindow.window[key];
    }

    if (Object.keys(geometry).length) {
      try {
        await withTimeout(
          browser.windows.update(windowId, geometry),
          5000,
          "windows.update geometry"
        );
      } catch (error) {
        await workspaceDebug("restore-window-geometry-error", {
          workspaceId,
          logicalWindowId,
          runtimeWindowId: windowId,
          geometry,
          error: String(error?.message ?? error)
        });
      }
    }
  }

  const deferredDiscardEntries = [];
  for (const source of sourceTabs.filter(source => source.discarded && !source.active)) {
    const tabId = newTabByOldRuntimeId.get(source.runtimeTabId);
    if (tabId == null) continue;

    let liveTab = null;
    try {
      liveTab = await browser.tabs.get(tabId);
    } catch {}

    // tabs.create({ discarded: true }) is the safe path and needs no later
    // discard. Only the defensive fallback reaches the post-process queue.
    if (liveTab?.discarded) continue;

    deferredDiscardEntries.push({
      tabId,
      sourceUrl: source.url,
      restoreUrl: restoreUrlOrBlank(source.url)
    });
  }

  const deferredDiscardTabIds = deferredDiscardEntries.map(item => item.tabId);

  await workspaceDebug("restore-window-populate-end", {
    workspaceId,
    logicalWindowId,
    runtimeWindowId: windowId,
    deferredDiscardCount: deferredDiscardTabIds.length,
    deferredDiscardEntries
  });

  return { windowId, deferredDiscardTabIds };
}


async function findLiveWorkspaceWindows(workspaceId, workspaces, windowMap) {
  const liveWindows = await browser.windows.getAll({ windowTypes: ["normal"] });
  const liveIds = new Set(liveWindows.map(win => String(win.id)));
  const workspace = workspaces[workspaceId];
  if (!workspace) return [];

  const result = [];
  for (const [runtimeId, mapping] of Object.entries(windowMap ?? {})) {
    if (mapping?.workspaceId !== workspaceId || !liveIds.has(runtimeId)) continue;
    const logicalWindow = workspace.windows?.[mapping.logicalWindowId];
    if (!logicalWindow) continue;

    logicalWindow.open = true;
    logicalWindow.runtimeWindowId = Number(runtimeId);
    logicalWindow.closedAt = null;
    result.push({
      runtimeWindowId: Number(runtimeId),
      logicalWindowId: mapping.logicalWindowId
    });
  }
  return result;
}

async function inferActiveWorkspaceFromRuntime() {
  const store = await loadWorkspaceStore();
  const liveWindows = await browser.windows.getAll({ windowTypes: ["normal"] });
  const liveIds = new Set(liveWindows.map(win => String(win.id)));

  if (store.activeWorkspaceId && store.workspaces[store.activeWorkspaceId]) {
    const liveActiveMappings = Object.entries(store.windowMap ?? {}).filter(([runtimeId, mapping]) =>
      mapping?.workspaceId === store.activeWorkspaceId && liveIds.has(runtimeId)
    );

    if (liveActiveMappings.length) return store.activeWorkspaceId;

    const staleWorkspace = store.workspaces[store.activeWorkspaceId];
    staleWorkspace.active = false;
    staleWorkspace.open = false;
    await browser.storage.local.set({
      [WORKSPACES_KEY]: store.workspaces,
      [ACTIVE_WORKSPACE_KEY]: null
    });
  }
  const counts = new Map();

  for (const [runtimeId, mapping] of Object.entries(store.windowMap ?? {})) {
    if (!liveIds.has(runtimeId) || !mapping?.workspaceId || !store.workspaces[mapping.workspaceId]) continue;
    counts.set(mapping.workspaceId, (counts.get(mapping.workspaceId) ?? 0) + 1);
  }

  if (!counts.size) return null;

  const [workspaceId] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const workspace = store.workspaces[workspaceId];
  workspace.active = true;
  workspace.open = true;
  workspace.closedAt = null;

  await browser.storage.local.set({
    [WORKSPACES_KEY]: store.workspaces,
    [ACTIVE_WORKSPACE_KEY]: workspaceId,
    [LAST_WORKSPACE_KEY]: workspaceId
  });

  await workspaceDebug("active-workspace-inferred", {
    workspaceId,
    mappedLiveWindows: counts.get(workspaceId)
  });

  return workspaceId;
}

async function restoreWorkspace(workspaceId, options = {}) {
  const { reuseLive = true } = options;
  await workspaceDebug("restore-begin", {
    workspaceId,
    restoreDepth: workspaceRestoreDepth
  });

  const store = await loadWorkspaceStore();
  const { workspaces } = store;
  const workspace = workspaces[workspaceId];
  if (!workspace) throw new Error("Workspace not found");

  const liveMappedWindows = reuseLive
    ? await findLiveWorkspaceWindows(
        workspaceId,
        workspaces,
        store.windowMap
      )
    : [];

  if (liveMappedWindows.length) {
    workspace.active = true;
    workspace.open = true;
    workspace.closedAt = null;
    workspace.updatedAt = Date.now();

    for (const [id, other] of Object.entries(workspaces)) {
      if (id !== workspaceId && other) other.active = false;
    }

    await browser.storage.local.set({
      [WORKSPACES_KEY]: workspaces,
      [ACTIVE_WORKSPACE_KEY]: workspaceId,
      [LAST_WORKSPACE_KEY]: workspaceId
    });

    await workspaceDebug("restore-reused-live-windows", {
      workspaceId,
      runtimeWindowIds: liveMappedWindows.map(item => item.runtimeWindowId)
    });

    try {
      await browser.windows.update(
        liveMappedWindows[0].runtimeWindowId,
        { focused: true }
      );
    } catch {}

    return {
      windowIds: liveMappedWindows.map(item => item.runtimeWindowId),
      reused: true
    };
  }

  const entries = Object.entries(workspace.windows ?? {});
  const restored = [];

  await acquireWorkspaceSnapshotLock(workspaceId, "restore");
  const deferredDiscardTabIds = [];
  const shellByLogicalWindowId = new Map();
  const newMap = { ...store.windowMap };

  workspaceRestoreDepth++;
  try {
    // Phase 1: create ALL windows first and map them immediately.
    for (const [logicalWindowId, sourceWindow] of entries) {
      try {
        const windowId = await createRestoreWindowShell(
          workspaceId,
          logicalWindowId,
          sourceWindow
        );

        shellByLogicalWindowId.set(logicalWindowId, windowId);
        restored.push(windowId);
        newMap[String(windowId)] = { workspaceId, logicalWindowId };

        sourceWindow.open = true;
        sourceWindow.runtimeWindowId = windowId;
        sourceWindow.closedAt = null;
        sourceWindow.updatedAt = Date.now();
      } catch (error) {
        sourceWindow.open = false;
        sourceWindow.runtimeWindowId = null;
        sourceWindow.updatedAt = Date.now();

        await workspaceDebug("restore-window-shell-failed", {
          workspaceId,
          logicalWindowId,
          error: String(error?.message ?? error)
        });
      }
    }

    workspace.open = restored.length > 0;
    workspace.active = restored.length > 0;
    workspace.closedAt = null;
    workspace.restoredAt = Date.now();
    workspace.updatedAt = Date.now();

    for (const [id, other] of Object.entries(workspaces)) {
      if (id !== workspaceId && other) other.active = false;
    }

    // Persist mapping BEFORE populating tabs/groups.
    await browser.storage.local.set({
      [WORKSPACES_KEY]: workspaces,
      [WINDOW_WORKSPACE_MAP_KEY]: newMap,
      [ACTIVE_WORKSPACE_KEY]: restored.length ? workspaceId : null,
      ...(restored.length ? { [LAST_WORKSPACE_KEY]: workspaceId } : {})
    });

    await workspaceDebug("restore-shells-complete", {
      workspaceId,
      restoredWindowIds: restored,
      requestedWindowCount: entries.length
    });

    // Phase 2: populate each existing shell.
    for (const [logicalWindowId, sourceWindow] of entries) {
      const windowId = shellByLogicalWindowId.get(logicalWindowId);
      if (windowId == null) continue;

      try {
        const result = await populateRestoredWindow(
          workspaceId,
          logicalWindowId,
          sourceWindow,
          windowId
        );

        deferredDiscardTabIds.push(...result.deferredDiscardTabIds);
      } catch (error) {
        await workspaceDebug("restore-window-populate-error", {
          workspaceId,
          logicalWindowId,
          runtimeWindowId: windowId,
          error: String(error?.message ?? error)
        });
      }
    }
  } finally {
    workspaceRestoreDepth--;
  }

  if (restored.length) {
    try {
      await browser.windows.update(restored[0], { focused: true });
    } catch {}
  }

  await workspaceDebug("restore-core-complete", {
    workspaceId,
    restoredWindowIds: restored,
    deferredDiscardCount: deferredDiscardTabIds.length
  });

  // Only after every shell, tab and group is restored do we apply the saved
  // discarded state. This is part of restore, not lifecycle policy evaluation.
  const discardResults = await Promise.allSettled(
    deferredDiscardTabIds.map(tabId =>
      withTimeout(browser.tabs.discard(tabId), 3000, "tabs.discard")
    )
  );

  await workspaceDebug("restore-discard-postprocess", {
    workspaceId,
    requested: deferredDiscardTabIds.length,
    rejected: discardResults.filter(result => result.status === "rejected").length
  });

  // Rebuild lifecycle only after restore is fully complete.
  await lifecycleManager.seedRuntimeState();
  await lifecycleManager.scheduleNextDeep();

  await workspaceDebug("restore-end", {
    workspaceId,
    restoredWindowIds: restored,
    activeWorkspaceId: restored.length ? workspaceId : null
  });

  await releaseWorkspaceSnapshotLock(workspaceId);
  return { windowIds: restored, reused: false };
}


// Workspace import/export ------------------------------------------------------
async function sanitizeWorkspaceForExport(workspace) {
  const exported = {
    format: "firefox-workspace-manager.workspace",
    version: 2,
    exportedAt: Date.now(),
    name: workspace?.name || "Workspace",
    createdAt: Number(workspace?.createdAt) || null,
    provenance: workspace?.importedAt
      ? {
          importedAt: Number(workspace.importedAt) || null,
          sourceName: workspace.importSource ?? null,
          originalName: workspace.originalName ?? null
        }
      : null,
    windows: []
  };

  for (const sourceWindow of Object.values(workspace?.windows ?? {})) {
    const groupKeyByRuntime = new Map();
    const groups = (sourceWindow.groups ?? []).map((group, index) => {
      const key = group.groupKey ?? ("g" + index);
      groupKeyByRuntime.set(group.runtimeGroupId, key);
      return {
        key,
        title: group.title ?? "",
        color: group.color ?? "grey",
        collapsed: !!group.collapsed
      };
    });

    const tabs = (sourceWindow.tabs ?? []).map(tab => ({
      index: tab.index ?? 0,
      url: tab.url ?? "about:blank",
      title: tab.title ?? "",
      pinned: !!tab.pinned,
      active: !!tab.active,
      discarded: !!tab.discarded,
      autoDiscardable: tab.autoDiscardable !== false,
      cookieStoreId: tab.cookieStoreId ?? null,
      groupKey: tab.groupKey ?? groupKeyByRuntime.get(tab.runtimeGroupId) ?? null
    }));

    const fingerprintVersion = 1;
    const fingerprint = await fingerprintSavedWindow({
      groups: (sourceWindow.groups ?? []).map((group, index) => ({
        ...group,
        groupKey: group.groupKey ?? ("g" + index)
      })),
      tabs: sourceWindow.tabs ?? []
    });

    exported.windows.push({
      fingerprintVersion,
      fingerprint,
      window: {
        state: sourceWindow.window?.state ?? "normal",
        left: sourceWindow.window?.left ?? null,
        top: sourceWindow.window?.top ?? null,
        width: sourceWindow.window?.width ?? null,
        height: sourceWindow.window?.height ?? null,
        incognito: !!sourceWindow.window?.incognito
      },
      groups,
      tabs
    });
  }

  return exported;
}

/**
 * Validate one exported workspace payload.
 *
 * Version 1 remains accepted for backups created before provenance metadata
 * was introduced. Version 2 adds createdAt/exportedAt/provenance fields.
 *
 * @param {any} payload
 */
function validateWorkspaceImportPayload(payload) {
  if (
    !payload ||
    payload.format !== "firefox-workspace-manager.workspace" ||
    ![1, 2].includes(Number(payload.version))
  ) {
    throw new Error("Unsupported workspace JSON format");
  }

  if (!Array.isArray(payload.windows)) {
    throw new Error("Workspace JSON neobsahuje seznam oken");
  }
}

/** @param {string} value */
function normalizeWorkspaceName(value) {
  return String(value ?? "").trim().toLocaleLowerCase("cs-CZ");
}

/**
 * Convert exported workspace data into a new local workspace with fresh
 * logical/runtime placeholder IDs. The returned object is not persisted yet.
 *
 * @param {any} payload
 * @param {{name?: string, sourceName?: string|null, importedAt?: number}} [options]
 */
async function buildImportedWorkspace(payload, options = {}) {
  validateWorkspaceImportPayload(payload);

  const workspaceId = newWorkspaceId();
  const windows = {};
  const now = Number(options.importedAt) || Date.now();
  const importedName = String(options.name ?? payload.name ?? "Importovaný workspace").trim();
  if (!importedName) throw new Error("Workspace musí mít název");

  for (const importedWindow of payload.windows) {
    const logicalWindowId = newLogicalWindowId();
    const runtimeGroupByKey = new Map();

    const groups = (Array.isArray(importedWindow.groups) ? importedWindow.groups : [])
      .map((group, index) => {
        const runtimeGroupId = -(index + 1);
        const groupKey = group.key ?? ("g" + index);
        runtimeGroupByKey.set(groupKey, runtimeGroupId);
        return {
          runtimeGroupId,
          groupKey,
          title: String(group.title ?? ""),
          color: group.color ?? "grey",
          collapsed: !!group.collapsed
        };
      });

    const tabs = (Array.isArray(importedWindow.tabs) ? importedWindow.tabs : [])
      .map((tab, index) => ({
        runtimeTabId: -(index + 1),
        index: Number.isFinite(tab.index) ? tab.index : index,
        url: String(tab.url ?? "about:blank"),
        title: String(tab.title ?? ""),
        pinned: !!tab.pinned,
        active: !!tab.active,
        discarded: !!tab.discarded,
        audible: false,
        autoDiscardable: tab.autoDiscardable !== false,
        cookieStoreId: tab.cookieStoreId ?? null,
        runtimeGroupId: tab.groupKey
          ? (runtimeGroupByKey.get(tab.groupKey) ?? null)
          : null,
        groupKey: tab.groupKey ?? null
      }));

    const importedSnapshot = {
      id: logicalWindowId,
      open: false,
      runtimeWindowId: null,
      closedAt: now,
      updatedAt: now,
      window: {
        state: importedWindow.window?.state ?? "normal",
        left: Number.isFinite(importedWindow.window?.left)
          ? importedWindow.window.left
          : null,
        top: Number.isFinite(importedWindow.window?.top)
          ? importedWindow.window.top
          : null,
        width: Number.isFinite(importedWindow.window?.width)
          ? importedWindow.window.width
          : null,
        height: Number.isFinite(importedWindow.window?.height)
          ? importedWindow.window.height
          : null,
        incognito: !!importedWindow.window?.incognito
      },
      groups,
      tabs
    };

    importedSnapshot.fingerprintVersion = 1;
    importedSnapshot.fingerprint = await fingerprintSavedWindow(importedSnapshot);

    if (
      importedWindow.fingerprint &&
      importedWindow.fingerprintVersion === 1 &&
      importedWindow.fingerprint !== importedSnapshot.fingerprint
    ) {
      await workspaceDebug("workspace-import-fingerprint-mismatch", {
        importedFingerprint: importedWindow.fingerprint,
        computedFingerprint: importedSnapshot.fingerprint,
        logicalWindowId
      });
    }

    windows[logicalWindowId] = importedSnapshot;
  }

  const originalCreatedAt = Number(payload.createdAt);
  const provenance = payload.provenance && typeof payload.provenance === "object"
    ? payload.provenance
    : null;

  return {
    id: workspaceId,
    name: importedName,
    persistent: true,
    active: false,
    open: false,
    createdAt: Number.isFinite(originalCreatedAt) && originalCreatedAt > 0
      ? originalCreatedAt
      : now,
    updatedAt: now,
    closedAt: now,
    importedAt: now,
    importSource: options.sourceName ?? provenance?.sourceName ?? null,
    originalName: String(provenance?.originalName || payload.name || importedName),
    windows
  };
}

/**
 * @param {any} payload
 * @param {{name?: string, sourceName?: string|null}} [options]
 */
async function importWorkspace(payload, options = {}) {
  const { workspaces } = await loadWorkspaceStore();
  validateWorkspaceImportPayload(payload);

  const requestedName = String(options.name ?? payload.name ?? "Importovaný workspace").trim();
  const normalizedName = normalizeWorkspaceName(requestedName);

  if (
    Object.values(workspaces).some(workspace =>
      normalizeWorkspaceName(workspace?.name) === normalizedName
    )
  ) {
    throw new Error('Workspace s názvem "' + requestedName + '" už existuje');
  }

  const imported = await buildImportedWorkspace(payload, {
    name: requestedName,
    sourceName: options.sourceName ?? null
  });

  workspaces[imported.id] = imported;
  await browser.storage.local.set({ [WORKSPACES_KEY]: workspaces });

  await workspaceDebug("workspace-imported", {
    workspaceId: imported.id,
    sourceName: imported.importSource,
    originalName: imported.originalName,
    windows: Object.keys(imported.windows).length
  });

  return imported;
}

async function getWorkspaceExport(workspaceId) {
  const { workspaces } = await loadWorkspaceStore();
  const workspace = workspaces[workspaceId];
  if (!workspace) throw new Error("Workspace not found");
  return sanitizeWorkspaceForExport(workspace);
}

/**
 * Export all saved workspaces as one portable bundle.
 */
async function getWorkspaceCollectionExport() {
  const { workspaces } = await loadWorkspaceStore();
  const exported = [];

  for (const workspace of Object.values(workspaces)) {
    exported.push(await sanitizeWorkspaceForExport(workspace));
  }

  return {
    format: "firefox-workspace-manager.workspaces",
    version: 1,
    exportedAt: Date.now(),
    workspaces: exported
  };
}

/**
 * Import a complete workspace collection after all names have already been
 * resolved by the UI. Validation happens before persistence, so a bad bundle
 * never leaves a half-imported collection behind.
 *
 * @param {any} payload
 * @param {{names?: string[], sourceName?: string|null}} [options]
 */
async function importWorkspaceCollection(payload, options = {}) {
  if (
    !payload ||
    payload.format !== "firefox-workspace-manager.workspaces" ||
    Number(payload.version) !== 1 ||
    !Array.isArray(payload.workspaces)
  ) {
    throw new Error("Unsupported workspace collection JSON format");
  }

  const store = await loadWorkspaceStore();
  const existingNames = new Set(
    Object.values(store.workspaces)
      .map(workspace => normalizeWorkspaceName(workspace?.name))
      .filter(Boolean)
  );
  const requestedNames = Array.isArray(options.names) ? options.names : [];
  const resolvedNames = [];
  const seenNames = new Set(existingNames);

  for (let index = 0; index < payload.workspaces.length; index++) {
    const workspacePayload = payload.workspaces[index];
    validateWorkspaceImportPayload(workspacePayload);

    const name = String(
      requestedNames[index] ?? workspacePayload.name ?? "Importovaný workspace"
    ).trim();

    if (!name) throw new Error("Workspace musí mít název");

    const normalized = normalizeWorkspaceName(name);
    if (seenNames.has(normalized)) {
      throw new Error('Workspace s názvem "' + name + '" už existuje');
    }

    seenNames.add(normalized);
    resolvedNames.push(name);
  }

  const importedAt = Date.now();
  const importedWorkspaces = [];

  for (let index = 0; index < payload.workspaces.length; index++) {
    importedWorkspaces.push(await buildImportedWorkspace(
      payload.workspaces[index],
      {
        name: resolvedNames[index],
        sourceName: options.sourceName ?? null,
        importedAt
      }
    ));
  }

  for (const workspace of importedWorkspaces) {
    store.workspaces[workspace.id] = workspace;
  }

  await browser.storage.local.set({ [WORKSPACES_KEY]: store.workspaces });

  await workspaceDebug("workspace-collection-imported", {
    sourceName: options.sourceName ?? null,
    count: importedWorkspaces.length,
    workspaceIds: importedWorkspaces.map(workspace => workspace.id)
  });

  return {
    imported: importedWorkspaces.length,
    workspaceIds: importedWorkspaces.map(workspace => workspace.id)
  };
}

/**
 * Export complete durable application state. Runtime Firefox IDs are excluded
 * by AppBackupService and the portable workspace collection format.
 *
 * @param {{alwaysExpanded?:boolean,refreshSeconds?:number}|null|undefined} panelExplorer
 */
async function exportApplicationBackup(panelExplorer) {
  const workspaceCollection = await getWorkspaceCollectionExport();
  return appBackupService.exportBackup({
    workspaceCollection,
    panelExplorer
  });
}

/**
 * Rebuild portable workspace snapshots with fresh local IDs while preserving
 * their original provenance. Disaster recovery is not treated as a new normal
 * workspace import.
 *
 * @param {any} collection
 * @returns {Promise<{workspaces:Record<string,any>,workspaceIds:string[]}>}
 */
async function rebuildApplicationWorkspaces(collection) {
  if (
    !collection ||
    collection.format !== "firefox-workspace-manager.workspaces" ||
    Number(collection.version) !== 1 ||
    !Array.isArray(collection.workspaces)
  ) {
    throw new Error("Application backup neobsahuje platné workspaces");
  }

  const workspaces = {};
  const workspaceIds = [];
  const restoredAt = Date.now();

  for (const workspacePayload of collection.workspaces) {
    validateWorkspaceImportPayload(workspacePayload);

    const restored = await buildImportedWorkspace(workspacePayload, {
      name: String(workspacePayload.name || "Workspace"),
      sourceName: null,
      importedAt: restoredAt
    });

    const provenance =
      workspacePayload.provenance &&
      typeof workspacePayload.provenance === "object"
        ? workspacePayload.provenance
        : null;

    if (provenance?.importedAt) {
      restored.importedAt = Number(provenance.importedAt) || restoredAt;
      restored.importSource = provenance.sourceName ?? null;
      restored.originalName =
        provenance.originalName ?? workspacePayload.name ?? restored.name;
    } else {
      delete restored.importedAt;
      restored.importSource = null;
      restored.originalName = String(workspacePayload.name || restored.name);
    }

    restored.active = false;
    restored.open = false;
    restored.closedAt = restoredAt;
    restored.updatedAt = restoredAt;

    workspaces[restored.id] = restored;
    workspaceIds.push(restored.id);
  }

  return { workspaces, workspaceIds };
}

/**
 * Strictly reattach a completely matching restored workspace to windows that
 * are still open in this Firefox session. Never use fuzzy matching here:
 * a different tab/group means the saved backup and live window are divergent.
 *
 * Matching is one-to-one and complete at the workspace level. We do not attach
 * a partial workspace because normal Recover currently reuses all mapped
 * windows and would otherwise silently omit the missing ones.
 *
 * @param {Record<string,any>} workspaces
 * @param {string|null} preferredWorkspaceId
 * @returns {Promise<{reattached:boolean,workspaceId:string|null,windowCount:number}>}
 */
async function reattachApplicationBackupWindows(workspaces, preferredWorkspaceId) {
  const savedWindows = [];
  for (const [workspaceId, workspace] of Object.entries(workspaces)) {
    for (const [logicalWindowId, saved] of Object.entries(workspace.windows ?? {})) {
      if (!(saved.tabs ?? []).some(tab => !isExtensionUrl(tab.url))) continue;
      savedWindows.push({
        workspaceId,
        logicalWindowId,
        fingerprint: await fingerprintSavedWindow(saved)
      });
    }
  }

  const currentWindows = await browser.windows.getAll({
    windowTypes: ["normal"],
    populate: true
  });
  const liveWindows = [];
  for (const win of currentWindows) {
    if (win.id == null || !hasWorkspaceContent(win)) continue;
    try {
      const groups = await browser.tabGroups.query({ windowId: win.id });
      liveWindows.push({
        runtimeWindowId: win.id,
        fingerprint: await fingerprintLiveWindow(win, groups)
      });
    } catch (error) {
      await workspaceDebug("app-restore-fingerprint-read-failed", {
        runtimeWindowId: win.id,
        error: String(error?.message ?? error)
      });
    }
  }

  const matched = matchCompleteWorkspace(
    savedWindows,
    liveWindows,
    preferredWorkspaceId
  );
  if (!matched) {
    await workspaceDebug("app-restore-reattach-skipped", {
      reason: "no-complete-unambiguous-exact-match",
      savedWindows: savedWindows.length,
      liveWindows: liveWindows.length
    });
    return { reattached: false, workspaceId: null, windowCount: 0 };
  }

  // Verify that the live fingerprint did not change while resolving hashes.
  const expectedById = new Map(liveWindows.map(win => [
    win.runtimeWindowId, win.fingerprint
  ]));
  for (const match of matched.matches) {
    try {
      const win = await browser.windows.get(match.runtimeWindowId, {
        populate: true
      });
      const groups = await browser.tabGroups.query({
        windowId: match.runtimeWindowId
      });
      if (
        !hasWorkspaceContent(win) ||
        await fingerprintLiveWindow(win, groups) !==
          expectedById.get(match.runtimeWindowId)
      ) {
        return { reattached: false, workspaceId: null, windowCount: 0 };
      }
    } catch {
      return { reattached: false, workspaceId: null, windowCount: 0 };
    }
  }

  const workspace = workspaces[matched.workspaceId];
  if (!workspace) {
    return { reattached: false, workspaceId: null, windowCount: 0 };
  }

  const now = Date.now();
  const windowMap = {};
  for (const match of matched.matches) {
    const saved = workspace.windows[match.logicalWindowId];
    if (!saved) {
      return { reattached: false, workspaceId: null, windowCount: 0 };
    }
    saved.open = true;
    saved.runtimeWindowId = match.runtimeWindowId;
    saved.closedAt = null;
    saved.updatedAt = now;
    windowMap[String(match.runtimeWindowId)] = {
      workspaceId: matched.workspaceId,
      logicalWindowId: match.logicalWindowId
    };
  }

  for (const [id, item] of Object.entries(workspaces)) {
    item.active = id === matched.workspaceId;
    item.open = id === matched.workspaceId;
  }
  workspace.closedAt = null;
  workspace.updatedAt = now;

  await browser.storage.local.set({
    [WORKSPACES_KEY]: workspaces,
    [WINDOW_WORKSPACE_MAP_KEY]: windowMap,
    [ACTIVE_WORKSPACE_KEY]: matched.workspaceId,
    [LAST_WORKSPACE_KEY]: matched.workspaceId
  });
  await browser.storage.local.remove(APP_RESTORE_PENDING_KEY);
  await workspaceDebug("app-restore-windows-reattached", {
    workspaceId: matched.workspaceId,
    runtimeWindowIds: matched.matches.map(item => item.runtimeWindowId),
    method: "strict-complete-fingerprint"
  });

  return {
    reattached: true,
    workspaceId: matched.workspaceId,
    windowCount: matched.matches.length
  };
}

/**
 * Preview whether Recover would create additional Firefox windows following
 * an application restore that was not safe to reattach automatically.
 *
 * @param {string} workspaceId
 */
async function previewWorkspaceRecovery(workspaceId) {
  const [{ workspaces }, stored, windows] = await Promise.all([
    loadWorkspaceStore(),
    browser.storage.local.get(APP_RESTORE_PENDING_KEY),
    browser.windows.getAll({ windowTypes: ["normal"], populate: true })
  ]);

  const workspace = workspaces[workspaceId];
  if (!workspace) throw new Error("Workspace not found");

  return {
    pendingApplicationRestore: !!stored[APP_RESTORE_PENDING_KEY],
    liveContentWindows: windows.filter(win => hasWorkspaceContent(win)).length,
    restoreWindowCount: Object.keys(workspace.windows ?? {}).length
  };
}

/**
 * Replace durable application state from a validated disaster-recovery backup.
 * Existing Firefox windows stay open but are detached from workspace runtime
 * mappings; restored workspaces remain inactive until Recover session.
 *
 * @param {any} payload
 */
async function restoreApplicationBackup(payload) {
  appBackupService.validate(payload);
  const rebuilt = await rebuildApplicationWorkspaces(
    payload.data.workspaces
  );

  workspaceRestoreDepth++;
  try {
    const result = await appBackupService.restoreBackup(
      payload,
      rebuilt.workspaces,
      rebuilt.workspaceIds
    );

    const attachment = await reattachApplicationBackupWindows(
      rebuilt.workspaces,
      result.lastWorkspaceId
    );

    await workspaceDebug("application-backup-restored", {
      sourceVersion: payload.extensionVersion ?? null,
      workspaceCount: rebuilt.workspaceIds.length,
      lastWorkspaceId: result.lastWorkspaceId
    });

    if (payload.settings?.syncEnabled) {
      await pushSettingsToSync();
    }

    return {
      restored: true,
      workspaces: rebuilt.workspaceIds.length,
      ...result,
      ...attachment
    };
  } finally {
    workspaceRestoreDepth = Math.max(0, workspaceRestoreDepth - 1);
    await lifecycleManager.seedRuntimeState();
    await lifecycleManager.ensureWatchdogAlarm();
  }
}

async function removeWorkspaceWindow(workspaceId, logicalWindowId) {
  const store = await loadWorkspaceStore();
  const workspace = store.workspaces[workspaceId];
  const logicalWindow = workspace?.windows?.[logicalWindowId];
  if (!workspace || !logicalWindow) throw new Error("Workspace window not found");

  if (logicalWindow.open && logicalWindow.runtimeWindowId != null) {
    delete store.windowMap[String(logicalWindow.runtimeWindowId)];
  }

  delete workspace.windows[logicalWindowId];
  workspace.updatedAt = Date.now();

  const remaining = Object.values(workspace.windows ?? {});
  workspace.open = remaining.some(win => win.open);
  workspace.active = store.activeWorkspaceId === workspaceId && workspace.open;

  if (!remaining.length && store.activeWorkspaceId === workspaceId) {
    store.activeWorkspaceId = null;
    workspace.active = false;
  }

  await browser.storage.local.set({
    [WORKSPACES_KEY]: store.workspaces,
    [WINDOW_WORKSPACE_MAP_KEY]: store.windowMap,
    [ACTIVE_WORKSPACE_KEY]: store.activeWorkspaceId
  });

  await workspaceDebug("workspace-window-removed", {
    workspaceId,
    logicalWindowId,
    remainingWindows: remaining.length
  });

  return { removed: true, remainingWindows: remaining.length };
}

async function adoptUnmappedWindowsIntoActiveWorkspace() {
  const store = await loadWorkspaceStore();
  const workspaceId = store.activeWorkspaceId;
  const workspace = workspaceId ? store.workspaces[workspaceId] : null;
  if (!workspace) return null;

  const liveWindows = await browser.windows.getAll({
    windowTypes: ["normal"],
    populate: true
  });

  let adopted = 0;

  for (const win of liveWindows) {
    const runtimeKey = String(win.id);

    // Never steal a window that is already owned by any workspace.
    if (store.windowMap[runtimeKey]) continue;

    // Ignore blank/newtab/manager-only windows.
    if (!hasWorkspaceContent(win)) continue;

    const logicalWindowId = newLogicalWindowId();
    store.windowMap[runtimeKey] = { workspaceId, logicalWindowId };
    workspace.windows ??= {};
    workspace.windows[logicalWindowId] = {
      id: logicalWindowId,
      open: true,
      runtimeWindowId: win.id,
      closedAt: null,
      updatedAt: Date.now(),
      window: {
        state: win.state,
        left: win.left,
        top: win.top,
        width: win.width,
        height: win.height,
        incognito: win.incognito
      },
      groups: [],
      tabs: []
    };

    adopted++;
    await workspaceDebug("workspace-window-adopted-explicitly", {
      workspaceId,
      logicalWindowId,
      runtimeWindowId: win.id
    });
  }

  if (adopted) {
    workspace.updatedAt = Date.now();
    await browser.storage.local.set({
      [WORKSPACES_KEY]: store.workspaces,
      [WINDOW_WORKSPACE_MAP_KEY]: store.windowMap
    });
  }

  return adopted;
}

async function snapshotCurrentWorkspace() {
  const activeWorkspaceId = await inferActiveWorkspaceFromRuntime();
  if (!activeWorkspaceId) return null;

  await adoptUnmappedWindowsIntoActiveWorkspace();
  await snapshotAllWindows();
  return activeWorkspaceId;
}

async function renameWorkspace(workspaceId, name) {
  const { workspaces } = await loadWorkspaceStore();
  const workspace = workspaces[workspaceId];
  if (!workspace) throw new Error("Workspace not found");
  workspace.name = String(name || "").trim() || workspace.name || "Workspace";
  workspace.updatedAt = Date.now();
  await browser.storage.local.set({ [WORKSPACES_KEY]: workspaces });
  return workspace;
}

async function createWorkspaceFromCurrentState(name) {
  if (await workspaceSnapshotLocked()) {
    throw new Error("Workspace restore is still in progress");
  }

  const liveWindows = await browser.windows.getAll({
    windowTypes: ["normal"],
    populate: true
  });

  const captured = [];

  for (const win of liveWindows) {
    if (!hasWorkspaceContent(win)) continue;

    const groups = await browser.tabGroups.query({ windowId: win.id });
    const logicalWindowId = newLogicalWindowId();
    const groupKeyByRuntimeId = new Map();

    const savedGroups = groups.map((group, index) => {
      const groupKey = "g" + index;
      groupKeyByRuntimeId.set(group.id, groupKey);
      return {
        runtimeGroupId: group.id,
        groupKey,
        title: group.title,
        color: group.color,
        collapsed: group.collapsed
      };
    });

    const savedTabs = (win.tabs ?? [])
      .filter(tab => !isExtensionUrl(tab.url))
      .map(tab => ({
        runtimeTabId: tab.id,
        index: tab.index,
        url: tab.url,
        title: tab.title,
        pinned: tab.pinned,
        active: tab.active,
        discarded: tab.discarded,
        audible: tab.audible,
        autoDiscardable: tab.autoDiscardable,
        cookieStoreId: tab.cookieStoreId,
        runtimeGroupId: tab.groupId,
        groupKey: groupKeyByRuntimeId.get(tab.groupId) ?? null
      }));

    if (!savedTabs.length) continue;

    const snapshot = {
      id: logicalWindowId,
      open: true,
      runtimeWindowId: win.id,
      closedAt: null,
      updatedAt: Date.now(),
      window: {
        state: win.state,
        left: win.left,
        top: win.top,
        width: win.width,
        height: win.height,
        incognito: win.incognito
      },
      groups: savedGroups,
      tabs: savedTabs
    };

    snapshot.fingerprintVersion = 1;
    snapshot.fingerprint = await fingerprintSavedWindow(snapshot);

    captured.push({
      runtimeWindowId: win.id,
      logicalWindowId,
      snapshot
    });
  }

  if (!captured.length) {
    throw new Error("Aktuální Firefox neobsahuje žádné okno s uložitelnými panely");
  }

  const store = await loadWorkspaceStore();
  const workspaceId = newWorkspaceId();
  const now = Date.now();

  // Detach captured runtime windows from their previous workspace ownership,
  // but keep all existing saved definitions intact as closed snapshots.
  for (const item of captured) {
    const runtimeKey = String(item.runtimeWindowId);
    const previousMapping = store.windowMap[runtimeKey];

    if (previousMapping) {
      const previousWorkspace = store.workspaces[previousMapping.workspaceId];
      const previousWindow = previousWorkspace?.windows?.[previousMapping.logicalWindowId];

      if (previousWindow) {
        previousWindow.open = false;
        previousWindow.runtimeWindowId = null;
        previousWindow.closedAt = now;
        previousWindow.updatedAt = now;
      }

      delete store.windowMap[runtimeKey];
    }
  }

  for (const workspace of Object.values(store.workspaces)) {
    if (!workspace) continue;
    workspace.active = false;
    workspace.open = Object.values(workspace.windows ?? {}).some(win => !!win?.open);
    if (!workspace.open && !workspace.closedAt) workspace.closedAt = now;
  }

  const windows = {};
  for (const item of captured) {
    windows[item.logicalWindowId] = item.snapshot;
    store.windowMap[String(item.runtimeWindowId)] = {
      workspaceId,
      logicalWindowId: item.logicalWindowId
    };
  }

  const workspace = {
    id: workspaceId,
    name: String(name || "").trim() || ("Workspace " + (Object.keys(store.workspaces).length + 1)),
    persistent: true,
    active: true,
    open: true,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    windows
  };

  store.workspaces[workspaceId] = workspace;
  store.activeWorkspaceId = workspaceId;

  await browser.storage.local.set({
    [WORKSPACES_KEY]: store.workspaces,
    [WINDOW_WORKSPACE_MAP_KEY]: store.windowMap,
    [ACTIVE_WORKSPACE_KEY]: workspaceId,
    [LAST_WORKSPACE_KEY]: workspaceId
  });

  const tabCount = captured.reduce((sum, item) => sum + item.snapshot.tabs.length, 0);
  const groupCount = captured.reduce((sum, item) => sum + item.snapshot.groups.length, 0);

  await workspaceDebug("workspace-created-from-current-state", {
    workspaceId,
    windows: captured.length,
    tabs: tabCount,
    groups: groupCount,
    runtimeWindowIds: captured.map(item => item.runtimeWindowId)
  });

  // Verify persistence before reporting success to the manager UI.
  const verify = await browser.storage.local.get([
    WORKSPACES_KEY,
    WINDOW_WORKSPACE_MAP_KEY,
    ACTIVE_WORKSPACE_KEY
  ]);

  const verifiedWorkspace = verify[WORKSPACES_KEY]?.[workspaceId];
  const verifiedActiveId = verify[ACTIVE_WORKSPACE_KEY];
  const verifiedWindows = Object.keys(verifiedWorkspace?.windows ?? {}).length;
  const verifiedTabs = Object.values(verifiedWorkspace?.windows ?? {})
    .reduce((sum, win) => sum + (win.tabs ?? []).length, 0);

  if (
    !verifiedWorkspace ||
    verifiedActiveId !== workspaceId ||
    verifiedWindows !== captured.length ||
    verifiedTabs !== tabCount
  ) {
    throw new Error("Kontrola uloženého workspace selhala");
  }

  return {
    workspaceId,
    active: true,
    windows: captured.length,
    tabs: tabCount,
    groups: groupCount
  };
}

async function deleteWorkspace(workspaceId) {
  const store = await loadWorkspaceStore();
  const { workspaces, windowMap, activeWorkspaceId } = store;
  const workspace = workspaces[workspaceId];
  if (!workspace) return { deleted: false };

  for (const [runtimeId, mapping] of Object.entries(windowMap)) {
    if (mapping?.workspaceId === workspaceId) delete windowMap[runtimeId];
  }

  delete workspaces[workspaceId];

  const updates = {
    [WORKSPACES_KEY]: workspaces,
    [WINDOW_WORKSPACE_MAP_KEY]: windowMap
  };

  if (activeWorkspaceId === workspaceId) {
    updates[ACTIVE_WORKSPACE_KEY] = null;
  }

  await browser.storage.local.set(updates);

  // If the active definition was deleted, keep the user's currently open
  // windows and immediately adopt them into a fresh workspace.
  if (activeWorkspaceId === workspaceId) {
    await snapshotAllWindows();
  }

  return { deleted: true };
}

async function switchWorkspace(targetWorkspaceId) {
  const before = await loadWorkspaceStore();
  if (!before.activeWorkspaceId || !before.workspaces[before.activeWorkspaceId]) {
    return restoreWorkspace(targetWorkspaceId, { reuseLive: false });
  }

  // Save the current live state, but do NOT detach or mark it closed yet.
  // Keeping the old workspace fully alive until the target is verified makes
  // switching failure-safe and prevents Firefox from ever seeing zero windows
  // during a normal switch.
  await snapshotAllWindows();

  const store = await loadWorkspaceStore();
  const currentId = store.activeWorkspaceId;

  if (currentId === targetWorkspaceId) {
    const currentLive = await findLiveWorkspaceWindows(
      currentId,
      store.workspaces,
      store.windowMap
    );

    if (currentLive.length) {
      try {
        await browser.windows.update(currentLive[0].runtimeWindowId, { focused: true });
      } catch {}
    }

    return { reused: true, workspaceId: currentId };
  }

  const target = store.workspaces[targetWorkspaceId];
  if (!target) throw new Error("Target workspace not found");

  // Old windows are derived from the LIVE mapping, never from persisted
  // workspace.windows[*].runtimeWindowId. Firefox runtime IDs are ephemeral
  // and can be reused across browser sessions.
  const currentLive = await findLiveWorkspaceWindows(
    currentId,
    store.workspaces,
    store.windowMap
  );
  const oldWindowIds = currentLive.map(item => item.runtimeWindowId);

  await workspaceDebug("switch-begin", {
    currentWorkspaceId: currentId,
    targetWorkspaceId,
    oldWindowIds
  });

  let restored;
  try {
    // A closed target workspace must be created afresh. Never trust stale
    // runtime mappings during a switch.
    restored = await restoreWorkspace(targetWorkspaceId, { reuseLive: false });
  } catch (error) {
    await workspaceDebug("switch-target-restore-error", {
      currentWorkspaceId: currentId,
      targetWorkspaceId,
      oldWindowIds,
      error: String(error?.message ?? error)
    });

    // restoreWorkspace may have changed active flags before failing. The old
    // windows are still untouched, so restore their logical active state.
    const rollback = await loadWorkspaceStore();
    const current = rollback.workspaces[currentId];
    if (current) {
      current.active = true;
      current.open = oldWindowIds.length > 0;
      current.closedAt = null;
    }
    const failedTarget = rollback.workspaces[targetWorkspaceId];
    if (failedTarget) failedTarget.active = false;

    await browser.storage.local.set({
      [WORKSPACES_KEY]: rollback.workspaces,
      [ACTIVE_WORKSPACE_KEY]: current ? currentId : null,
      ...(current ? { [LAST_WORKSPACE_KEY]: currentId } : {})
    });

    throw error;
  }

  // Verify the target windows actually exist before closing a single old one.
  const liveAfterRestore = await browser.windows.getAll({ windowTypes: ["normal"] });
  const liveIds = new Set(liveAfterRestore.map(win => win.id));
  const restoredWindowIds = (restored.windowIds ?? []).filter(id => liveIds.has(id));

  await workspaceDebug("switch-target-verified", {
    currentWorkspaceId: currentId,
    targetWorkspaceId,
    restoredWindowIds: restored.windowIds ?? [],
    verifiedTargetWindowIds: restoredWindowIds,
    liveWindowIds: [...liveIds]
  });

  if (!restoredWindowIds.length) {
    const rollback = await loadWorkspaceStore();
    const current = rollback.workspaces[currentId];
    if (current) {
      current.active = true;
      current.open = oldWindowIds.length > 0;
      current.closedAt = null;
    }
    const failedTarget = rollback.workspaces[targetWorkspaceId];
    if (failedTarget) {
      failedTarget.active = false;
      failedTarget.open = false;
    }

    await browser.storage.local.set({
      [WORKSPACES_KEY]: rollback.workspaces,
      [ACTIVE_WORKSPACE_KEY]: current ? currentId : null,
      ...(current ? { [LAST_WORKSPACE_KEY]: currentId } : {})
    });

    await workspaceDebug("switch-aborted-no-live-target", {
      currentWorkspaceId: currentId,
      targetWorkspaceId,
      oldWindowIds
    });

    throw new Error("Přepnutí zrušeno: cílový workspace nemá žádné živé okno");
  }

  // Target is now proven alive. Only now may the previous workspace windows
  // be closed. onRemoved still has their original mapping and therefore marks
  // the correct (old) workspace closed without touching the active target.
  for (const windowId of oldWindowIds) {
    if (restoredWindowIds.includes(windowId)) continue;

    await workspaceDebug("switch-close-old-window-before", {
      currentWorkspaceId: currentId,
      targetWorkspaceId,
      runtimeWindowId: windowId
    });

    try {
      await browser.windows.remove(windowId);
      await workspaceDebug("switch-close-old-window-after", {
        currentWorkspaceId: currentId,
        targetWorkspaceId,
        runtimeWindowId: windowId,
        result: "closed"
      });
    } catch (error) {
      await workspaceDebug("switch-close-old-window-after", {
        currentWorkspaceId: currentId,
        targetWorkspaceId,
        runtimeWindowId: windowId,
        result: "error",
        error: String(error?.message ?? error)
      });
    }
  }

  await workspaceDebug("switch-end", {
    previousWorkspaceId: currentId,
    activeWorkspaceId: targetWorkspaceId,
    targetWindowIds: restoredWindowIds
  });

  return {
    ...restored,
    windowIds: restoredWindowIds
  };
}

// Lightweight settings sync ----------------------------------------------------
// Workspace snapshots and runtime state deliberately remain local.
async function pushSettingsToSync() {
  const local = await browser.storage.local.get([SYNC_ENABLED_KEY, ...SYNC_KEYS]);
  if (!local[SYNC_ENABLED_KEY]) return;

  const remote = await browser.storage.sync.get(SYNC_KEYS);
  const update = {};
  for (const key of SYNC_KEYS) {
    if (!(key in local)) continue;
    if (JSON.stringify(local[key]) !== JSON.stringify(remote[key])) update[key] = local[key];
  }
  if (Object.keys(update).length) await browser.storage.sync.set(update);
}

async function pullSettingsFromSync() {
  const local = await browser.storage.local.get([SYNC_ENABLED_KEY, ...SYNC_KEYS]);
  if (!local[SYNC_ENABLED_KEY]) return;

  const remote = await browser.storage.sync.get(SYNC_KEYS);
  const update = {};
  for (const key of SYNC_KEYS) {
    if (!(key in remote)) continue;
    if (JSON.stringify(remote[key]) !== JSON.stringify(local[key])) update[key] = remote[key];
  }
  if (Object.keys(update).length) await browser.storage.local.set(update);
}

// Runtime browser-state cache --------------------------------------------------
// This cache is separate from the persistent logical workspace model.
async function loadState() {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] ?? emptyState();
}

async function saveState(state) {
  state.updatedAt = Date.now();
  await browser.storage.local.set({ [STORAGE_KEY]: state });
}

async function snapshotWindow(windowId) {
  if (await workspaceSnapshotLocked()) return null;

  let win;
  try {
    win = await browser.windows.get(windowId, { populate: true });
  } catch {
    return;
  }
  if (win.type !== "normal") return;

  const groups = await browser.tabGroups.query({ windowId });
  const state = await loadState();
  state.windows[String(windowId)] = {
    id: windowId,
    focused: win.focused,
    incognito: win.incognito,
    state: win.state,
    left: win.left,
    top: win.top,
    width: win.width,
    height: win.height,
    tabs: (win.tabs ?? []).map(tab => ({
      id: tab.id,
      index: tab.index,
      url: tab.url,
      title: tab.title,
      pinned: tab.pinned,
      active: tab.active,
      discarded: tab.discarded,
      audible: tab.audible,
      autoDiscardable: tab.autoDiscardable,
      cookieStoreId: tab.cookieStoreId,
      groupId: tab.groupId
    })),
    groups: groups.map(group => ({
      id: group.id,
      title: group.title,
      color: group.color,
      collapsed: group.collapsed
    }))
  };
  await saveState(state);
  await saveWorkspaceSnapshot(win, groups);
}

async function snapshotAllWindows() {
  if (await workspaceSnapshotLocked()) return null;

  const windows = await browser.windows.getAll({ windowTypes: ["normal"] });
  for (const win of windows) await snapshotWindow(win.id);
}

// WebExtension event wiring ----------------------------------------------------
// Keep handlers thin: stateful lifecycle behavior belongs to TabLifecycleManager.
browser.runtime.onInstalled.addListener(() => {
  lifecycleManager.seedRuntimeState().catch(console.error);
});

browser.runtime.onStartup.addListener(() => {
  lifecycleManager.seedRuntimeState().catch(console.error);
});

browser.alarms.onAlarm.addListener(alarm => {
  lifecycleManager.handleAlarm(alarm.name);
});

browser.tabs.onCreated.addListener(tab => {
  if (workspaceRestoreDepth > 0) return;
  if (tab.windowId >= 0) {
    scheduleWorkspaceWindowReattach(tab.windowId);
    snapshotWindow(tab.windowId).catch(console.error);
  }
});

browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
  lifecycleManager.handleTabRemoved(tabId, removeInfo).catch(console.error);
});

browser.tabs.onActivated.addListener(activeInfo => {
  if (workspaceRestoreDepth > 0) return;
  lifecycleManager.handleActivation(activeInfo).catch(console.error);
  snapshotWindow(activeInfo.windowId).catch(console.error);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (workspaceRestoreDepth > 0) return;

  const relevant = ["url", "title", "pinned", "discarded", "autoDiscardable", "audible"];
  if (relevant.some(key => Object.hasOwn(changeInfo, key))) {
    scheduleWorkspaceWindowReattach(tab.windowId);
    snapshotWindow(tab.windowId).catch(console.error);
  }

  lifecycleManager.handleTabUpdated(tabId, changeInfo, tab);
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    browser.storage.local.get(SYNC_ENABLED_KEY).then(stored => {
      if (!stored[SYNC_ENABLED_KEY]) return;
      const update = {};
      for (const key of SYNC_KEYS) {
        if (changes[key]) update[key] = changes[key].newValue;
      }
      if (Object.keys(update).length) browser.storage.local.set(update).catch(console.error);
    }).catch(console.error);
    return;
  }

  if (area !== "local") return;

  if (changes[SYNC_ENABLED_KEY]) {
    if (changes[SYNC_ENABLED_KEY].newValue) {
      pushSettingsToSync().catch(console.error);
    }
  } else if (SYNC_KEYS.some(key => changes[key])) {
    browser.storage.local.get(SYNC_ENABLED_KEY).then(stored => {
      if (stored[SYNC_ENABLED_KEY]) pushSettingsToSync().catch(console.error);
    }).catch(console.error);
  }

  if (
    workspaceRestoreDepth === 0 &&
    (changes[HOST_POLICIES_KEY] || changes[URL_POLICIES_KEY] || changes[AUTO_SETTINGS_KEY])
  ) {
    lifecycleManager.handleSettingsChanged().catch(console.error);
  }
});

browser.tabGroups.onCreated.addListener(group => {
  if (workspaceRestoreDepth === 0) {
    scheduleWorkspaceWindowReattach(group.windowId);
    snapshotWindow(group.windowId).catch(console.error);
  }
});
browser.tabGroups.onUpdated.addListener(group => {
  if (workspaceRestoreDepth === 0) {
    scheduleWorkspaceWindowReattach(group.windowId);
    snapshotWindow(group.windowId).catch(console.error);
  }
});
browser.tabGroups.onMoved.addListener(group => {
  if (workspaceRestoreDepth === 0) {
    scheduleWorkspaceWindowReattach(group.windowId);
    snapshotWindow(group.windowId).catch(console.error);
  }
});

browser.windows.onCreated.addListener(win => {
  if (workspaceRestoreDepth > 0) return;
  if (win.type === "normal") {
    scheduleWorkspaceWindowReattach(win.id, 1200);
    snapshotWindow(win.id).catch(console.error);
  }
});

browser.runtime.onMessage.addListener(message => {
  if (message?.type === "restoreWorkspace" && message.workspaceId) {
    return restoreWorkspace(message.workspaceId);
  }
  if (message?.type === "switchWorkspace" && message.workspaceId) {
    return switchWorkspace(message.workspaceId);
  }
  if (message?.type === "renameWorkspace" && message.workspaceId) {
    return renameWorkspace(message.workspaceId, message.name);
  }
  if (message?.type === "snapshotWorkspace") {
    return snapshotCurrentWorkspace();
  }
  if (message?.type === "createWorkspaceFromCurrentState") {
    return createWorkspaceFromCurrentState(message.name);
  }
  if (message?.type === "deleteWorkspace" && message.workspaceId) {
    return deleteWorkspace(message.workspaceId);
  }
  if (message?.type === "removeWorkspaceWindow" && message.workspaceId && message.logicalWindowId) {
    return removeWorkspaceWindow(message.workspaceId, message.logicalWindowId);
  }
  if (message?.type === "exportWorkspace" && message.workspaceId) {
    return getWorkspaceExport(message.workspaceId);
  }
  if (message?.type === "exportWorkspaceCollection") {
    return getWorkspaceCollectionExport();
  }
  if (message?.type === "importWorkspace" && message.payload) {
    return importWorkspace(message.payload, {
      name: message.name,
      sourceName: message.sourceName
    });
  }
  if (message?.type === "importWorkspaceCollection" && message.payload) {
    return importWorkspaceCollection(message.payload, {
      names: message.names,
      sourceName: message.sourceName
    });
  }
  if (message?.type === "exportApplicationBackup") {
    return exportApplicationBackup(message.panelExplorer);
  }
  if (message?.type === "restoreApplicationBackup" && message.payload) {
    return restoreApplicationBackup(message.payload);
  }
  if (message?.type === "pullSyncSettings") {
    return pullSettingsFromSync();
  }
  if (message?.type === "pushSyncSettings") {
    return pushSettingsToSync();
  }
  return undefined;
});

browser.windows.onRemoved.addListener(async windowId => {
  lifecycleManager.forgetWindow(windowId);
  const pendingReattach = workspaceReattachTimers.get(windowId);
  if (pendingReattach) {
    clearTimeout(pendingReattach);
    workspaceReattachTimers.delete(windowId);
  }
  await markWorkspaceClosed(windowId);
  const state = await loadState();
  const entry = state.windows[String(windowId)];
  if (entry) {
    entry.closedAt = Date.now();
    entry.open = false;
    await saveState(state);
  }
});

reconcileWorkspaceRuntimeState().catch(console.error);
lifecycleManager.seedRuntimeState().catch(console.error);
lifecycleManager.ensureWatchdogAlarm().catch(console.error);
pullSettingsFromSync().catch(console.error);
