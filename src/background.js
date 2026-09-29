const STORAGE_KEY = "fwm.state";
const LAST_ACTIVE_CONTENT_KEY = "fwm.lastActiveContentTabs";
const HOST_POLICIES_KEY = "fwm.hostPolicies";
const URL_POLICIES_KEY = "fwm.urlPolicies";
const AUTO_SETTINGS_KEY = "fwm.autoSettings";
const TAB_LIFECYCLE_KEY = "fwm.tabLifecycle";
const HOST_STATS_KEY = "fwm.hostStats";
const NEXT_DEEP_ALARM = "fwm.nextDeep";
const DEEP_WATCHDOG_ALARM = "fwm.deepWatchdog";
const WORKSPACES_KEY = "fwm.workspaces";
const WINDOW_WORKSPACE_MAP_KEY = "fwm.windowWorkspaceMap";
const SYNC_ENABLED_KEY = "fwm.sync.enabled";
const SYNC_KEYS = [AUTO_SETTINGS_KEY, HOST_POLICIES_KEY, URL_POLICIES_KEY];
const WORKSPACE_DEBUG_KEY = "fwm.workspaceDebugLog";
const WORKSPACE_SNAPSHOT_LOCK_KEY = "fwm.workspaceSnapshotLock";
const WORKSPACE_SNAPSHOT_LOCK_TTL_MS = 120000;

const activeByWindow = new Map();
let workspaceRestoreDepth = 0;

function defaultAutoSettings() {
  return {
    minutes: 60,
    deepOnLeave: false,
    protectPinned: true,
    protectAudible: true
  };
}

function emptyState() {
  return { version: 1, windows: {}, updatedAt: Date.now() };
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url ?? "");
}

function hostnameFromUrl(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isExtensionUrl(url) {
  return /^(moz|chrome)-extension:\/\//i.test(url ?? "");
}

function hasWorkspaceContent(win) {
  return (win?.tabs ?? []).some(tab => {
    const url = tab?.url ?? "";
    if (isExtensionUrl(url)) return false;
    return !["about:blank", "about:newtab", "about:home"].includes(url);
  });
}

async function workspaceSnapshotLocked() {
  if (workspaceRestoreDepth > 0) return true;

  const stored = await browser.storage.local.get(WORKSPACE_SNAPSHOT_LOCK_KEY);
  const lock = stored[WORKSPACE_SNAPSHOT_LOCK_KEY];
  if (!lock) return false;

  const acquiredAt = Number(lock.acquiredAt) || 0;
  if (Date.now() - acquiredAt > WORKSPACE_SNAPSHOT_LOCK_TTL_MS) {
    await browser.storage.local.remove(WORKSPACE_SNAPSHOT_LOCK_KEY);
    return false;
  }

  return true;
}

async function acquireWorkspaceSnapshotLock(workspaceId, reason = "restore") {
  const lock = { workspaceId, reason, acquiredAt: Date.now() };
  await browser.storage.local.set({ [WORKSPACE_SNAPSHOT_LOCK_KEY]: lock });
  await workspaceDebug("snapshot-lock-acquired", lock);
}

async function releaseWorkspaceSnapshotLock(workspaceId) {
  const stored = await browser.storage.local.get(WORKSPACE_SNAPSHOT_LOCK_KEY);
  const lock = stored[WORKSPACE_SNAPSHOT_LOCK_KEY];
  if (!lock) return;
  if (workspaceId && lock.workspaceId && lock.workspaceId !== workspaceId) return;

  await browser.storage.local.remove(WORKSPACE_SNAPSHOT_LOCK_KEY);
  await workspaceDebug("snapshot-lock-released", {
    workspaceId: workspaceId ?? lock.workspaceId ?? null
  });
}

async function getConfig() {
  const stored = await browser.storage.local.get([
    HOST_POLICIES_KEY,
    URL_POLICIES_KEY,
    AUTO_SETTINGS_KEY
  ]);
  return {
    hostPolicies: stored[HOST_POLICIES_KEY] ?? {},
    urlPolicies: Array.isArray(stored[URL_POLICIES_KEY]) ? stored[URL_POLICIES_KEY] : [],
    auto: { ...defaultAutoSettings(), ...(stored[AUTO_SETTINGS_KEY] ?? {}) }
  };
}

function resolvePolicy(tab, config) {
  const url = tab.url ?? "";
  if (isExtensionUrl(url)) return "KEEP";

  const urlRule = config.urlPolicies.find(rule => rule?.url === url);
  if (urlRule?.mode) return urlRule.mode;

  const host = hostnameFromUrl(url);
  if (host && config.hostPolicies[host]) return config.hostPolicies[host];
  return "AUTO";
}

function protectedByRuntime(tab, auto) {
  if (tab.id == null || tab.active || tab.discarded || isExtensionUrl(tab.url)) return true;
  if (auto.protectPinned && tab.pinned) return true;
  if (auto.protectAudible && tab.audible) return true;
  return false;
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
  const stored = await browser.storage.local.get(WORKSPACE_DEBUG_KEY);
  const log = Array.isArray(stored[WORKSPACE_DEBUG_KEY]) ? stored[WORKSPACE_DEBUG_KEY] : [];
  log.push({
    at: Date.now(),
    event,
    data
  });
  await browser.storage.local.set({
    [WORKSPACE_DEBUG_KEY]: log.slice(-200)
  });
}

function newWorkspaceId() {
  return crypto.randomUUID();
}

function newLogicalWindowId() {
  return crypto.randomUUID();
}


async function reconcileWorkspaceRuntimeState() {
  const stored = await browser.storage.local.get([
    WORKSPACES_KEY,
    WINDOW_WORKSPACE_MAP_KEY,
    "fwm.activeWorkspaceId"
  ]);

  const workspaces = stored[WORKSPACES_KEY] ?? {};
  const windowMap = stored[WINDOW_WORKSPACE_MAP_KEY] ?? {};
  let activeWorkspaceId = stored["fwm.activeWorkspaceId"] ?? null;
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
      "fwm.activeWorkspaceId": activeWorkspaceId
    });
  }

  const normalizedGroups = normalizeWorkspaceGroupKeys(workspaces);
  if (normalizedGroups) {
    await browser.storage.local.set({ [WORKSPACES_KEY]: workspaces });
  }

  return { workspaces, windowMap, activeWorkspaceId };
}

function normalizeWorkspaceGroupKeys(workspaces) {
  let changed = false;

  for (const workspace of Object.values(workspaces ?? {})) {
    for (const win of Object.values(workspace?.windows ?? {})) {
      const groups = win.groups ?? [];
      const tabs = win.tabs ?? [];
      const keyByRuntimeId = new Map();

      groups.forEach((group, index) => {
        if (!group.groupKey) {
          group.groupKey = "g" + index;
          changed = true;
        }
        keyByRuntimeId.set(group.runtimeGroupId, group.groupKey);
      });

      for (const tab of tabs) {
        if (tab.groupKey) continue;
        const key = keyByRuntimeId.get(tab.runtimeGroupId);
        if (key) {
          tab.groupKey = key;
          changed = true;
        } else if (tab.runtimeGroupId == null || tab.runtimeGroupId === -1) {
          tab.groupKey = null;
        }
      }
    }
  }

  return changed;
}

async function loadWorkspaceStore() {
  const stored = await browser.storage.local.get([
    WORKSPACES_KEY,
    WINDOW_WORKSPACE_MAP_KEY,
    "fwm.activeWorkspaceId"
  ]);

  let workspaces = stored[WORKSPACES_KEY] ?? {};
  let windowMap = stored[WINDOW_WORKSPACE_MAP_KEY] ?? {};
  let activeWorkspaceId = stored["fwm.activeWorkspaceId"] ?? null;

  const legacy = Object.values(workspaces).filter(ws => ws && !ws.windows && ws.window);
  if (legacy.length) {
    const mergedId = newWorkspaceId();
    const merged = {
      id: mergedId,
      name: legacy[0]?.name || "Workspace 1",
      persistent: true,
      createdAt: Math.min(...legacy.map(ws => ws.createdAt || Date.now())),
      updatedAt: Date.now(),
      windows: {}
    };

    const newMap = {};
    for (const ws of legacy) {
      const logicalWindowId = newLogicalWindowId();
      merged.windows[logicalWindowId] = {
        id: logicalWindowId,
        open: !!ws.open,
        runtimeWindowId: ws.runtimeWindowId ?? null,
        closedAt: ws.closedAt ?? null,
        window: ws.window ?? {},
        groups: ws.groups ?? [],
        tabs: ws.tabs ?? []
      };

      if (ws.runtimeWindowId != null) {
        newMap[String(ws.runtimeWindowId)] = {
          workspaceId: mergedId,
          logicalWindowId
        };
      }
    }

    workspaces = { [mergedId]: merged };
    windowMap = newMap;
    activeWorkspaceId = Object.values(merged.windows).some(win => win.open) ? mergedId : null;

    await browser.storage.local.set({
      [WORKSPACES_KEY]: workspaces,
      [WINDOW_WORKSPACE_MAP_KEY]: windowMap,
      "fwm.activeWorkspaceId": activeWorkspaceId
    });
  }

  if (normalizeWorkspaceGroupKeys(workspaces)) {
    await browser.storage.local.set({ [WORKSPACES_KEY]: workspaces });
  }

  return { workspaces, windowMap, activeWorkspaceId };
}

async function ensureActiveWorkspace({ allowCreate = false } = {}) {
  const store = await loadWorkspaceStore();
  let { workspaces, windowMap, activeWorkspaceId } = store;

  if (activeWorkspaceId && workspaces[activeWorkspaceId]) {
    return { workspaces, windowMap, activeWorkspaceId };
  }

  const firstEverWorkspace = Object.keys(workspaces).length === 0;
  if (!allowCreate && !firstEverWorkspace) {
    return { workspaces, windowMap, activeWorkspaceId: null };
  }

  activeWorkspaceId = newWorkspaceId();
  workspaces[activeWorkspaceId] = {
    id: activeWorkspaceId,
    name: "Workspace " + (Object.keys(workspaces).length + 1),
    persistent: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    windows: {}
  };

  await browser.storage.local.set({
    [WORKSPACES_KEY]: workspaces,
    "fwm.activeWorkspaceId": activeWorkspaceId
  });
  await workspaceDebug("workspace-created", {
    workspaceId: activeWorkspaceId,
    reason: firstEverWorkspace ? "first-ever" : "explicit"
  });

  return { workspaces, windowMap, activeWorkspaceId };
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
    tabs: (win.tabs ?? []).filter(tab => !isExtensionUrl(tab.url)).map(tab => {
      const groupIndex = groups.findIndex(group => group.id === tab.groupId);
      return ({
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
      groupKey: groupIndex >= 0 ? "g" + groupIndex : null
    });
    })
  };

  workspace.updatedAt = Date.now();
  workspace.open = true;
  workspace.active = true;

  await browser.storage.local.set({
    [WORKSPACES_KEY]: workspaces,
    [WINDOW_WORKSPACE_MAP_KEY]: windowMap,
    "fwm.activeWorkspaceId": activeWorkspaceId
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
    updates["fwm.activeWorkspaceId"] = null;
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

function restorableUrl(url) {
  if (!url) return null;
  if (/^(moz|chrome)-extension:\/\//i.test(url)) return null;

  try {
    const parsed = new URL(url);
    if (["http:", "https:", "file:"].includes(parsed.protocol)) return url;
    if (url === "about:blank") return url;
  } catch {}

  return null;
}

function restoreUrlOrBlank(url) {
  return restorableUrl(url) || "about:blank";
}

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

  const liveTabs = (await withTimeout(
    browser.tabs.query({ windowId }),
    5000,
    "tabs.query restore shell"
  )).slice().sort((a, b) => a.index - b.index);

  const liveTabIds = [];
  const firstTabId = liveTabs[0]?.id ?? null;

  if (sourceTabs.length && firstTabId != null) {
    const firstUrl = restoreUrlOrBlank(sourceTabs[0].url);
    await workspaceDebug("restore-tab-update-first", {
      workspaceId,
      logicalWindowId,
      runtimeWindowId: windowId,
      tabId: firstTabId,
      url: sourceTabs[0].url,
      restoreUrl: firstUrl,
      substituted: firstUrl !== sourceTabs[0].url
    });

    await withTimeout(
      browser.tabs.update(firstTabId, { url: firstUrl }),
      5000,
      "tabs.update first restore URL"
    );
    liveTabIds.push(firstTabId);
  }

  for (let i = 1; i < sourceTabs.length; i++) {
    const source = sourceTabs[i];
    const restoreUrl = restoreUrlOrBlank(source.url);

    await workspaceDebug("restore-tab-create-before", {
      workspaceId,
      logicalWindowId,
      sourceIndex: i,
      url: source.url,
      restoreUrl,
      substituted: restoreUrl !== source.url
    });

    const created = await withTimeout(browser.tabs.create({
      windowId,
      url: restoreUrl,
      active: false
    }), 5000, "tabs.create");

    liveTabIds.push(created.id);
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
      .filter(tab =>
        (tab.groupKey ?? null) === groupKey ||
        (!tab.groupKey && tab.runtimeGroupId === group.runtimeGroupId)
      )
      .map(tab => newTabByOldRuntimeId.get(tab.runtimeTabId))
      .filter(id => id != null);

    if (!tabIds.length) continue;

    await workspaceDebug("restore-group-before", {
      workspaceId,
      logicalWindowId,
      title: group.title ?? "",
      groupKey,
      tabCount: tabIds.length,
      sourceRuntimeGroupId: group.runtimeGroupId
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

  const deferredDiscardTabIds = sourceTabs
    .filter(source => source.discarded && !source.active)
    .map(source => newTabByOldRuntimeId.get(source.runtimeTabId))
    .filter(tabId => tabId != null);

  await workspaceDebug("restore-window-populate-end", {
    workspaceId,
    logicalWindowId,
    runtimeWindowId: windowId,
    deferredDiscardCount: deferredDiscardTabIds.length
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
      "fwm.activeWorkspaceId": null
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
    "fwm.activeWorkspaceId": workspaceId
  });

  await workspaceDebug("active-workspace-inferred", {
    workspaceId,
    mappedLiveWindows: counts.get(workspaceId)
  });

  return workspaceId;
}

async function restoreWorkspace(workspaceId) {
  await workspaceDebug("restore-begin", {
    workspaceId,
    restoreDepth: workspaceRestoreDepth
  });

  const store = await loadWorkspaceStore();
  const { workspaces } = store;
  const workspace = workspaces[workspaceId];
  if (!workspace) throw new Error("Workspace not found");

  const liveMappedWindows = await findLiveWorkspaceWindows(
    workspaceId,
    workspaces,
    store.windowMap
  );

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
      "fwm.activeWorkspaceId": workspaceId
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
      "fwm.activeWorkspaceId": restored.length ? workspaceId : null
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
  await seedRuntimeState();
  await scheduleNextDeep();

  await workspaceDebug("restore-end", {
    workspaceId,
    restoredWindowIds: restored,
    activeWorkspaceId: restored.length ? workspaceId : null
  });

  await releaseWorkspaceSnapshotLock(workspaceId);
  return { windowIds: restored, reused: false };
}


function sanitizeWorkspaceForExport(workspace) {
  const exported = {
    format: "firefox-workspace-manager.workspace",
    version: 1,
    name: workspace?.name || "Workspace",
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

    exported.windows.push({
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

async function importWorkspace(payload) {
  if (!payload || payload.format !== "firefox-workspace-manager.workspace" || payload.version !== 1) {
    throw new Error("Unsupported workspace JSON format");
  }

  const { workspaces } = await loadWorkspaceStore();
  const workspaceId = newWorkspaceId();
  const windows = {};

  for (const importedWindow of Array.isArray(payload.windows) ? payload.windows : []) {
    const logicalWindowId = newLogicalWindowId();
    const runtimeGroupByKey = new Map();
    const groups = (Array.isArray(importedWindow.groups) ? importedWindow.groups : []).map((group, index) => {
      const runtimeGroupId = -(index + 1);
      runtimeGroupByKey.set(group.key ?? ("g" + index), runtimeGroupId);
      return {
        runtimeGroupId,
        groupKey: group.key ?? ("g" + index),
        title: String(group.title ?? ""),
        color: group.color ?? "grey",
        collapsed: !!group.collapsed
      };
    });

    const tabs = (Array.isArray(importedWindow.tabs) ? importedWindow.tabs : []).map((tab, index) => ({
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
      runtimeGroupId: tab.groupKey ? (runtimeGroupByKey.get(tab.groupKey) ?? -1) : -1,
      groupKey: tab.groupKey ?? null
    }));

    windows[logicalWindowId] = {
      id: logicalWindowId,
      open: false,
      runtimeWindowId: null,
      closedAt: Date.now(),
      updatedAt: Date.now(),
      window: {
        state: importedWindow.window?.state ?? "normal",
        left: Number.isFinite(importedWindow.window?.left) ? importedWindow.window.left : null,
        top: Number.isFinite(importedWindow.window?.top) ? importedWindow.window.top : null,
        width: Number.isFinite(importedWindow.window?.width) ? importedWindow.window.width : null,
        height: Number.isFinite(importedWindow.window?.height) ? importedWindow.window.height : null,
        incognito: !!importedWindow.window?.incognito
      },
      groups,
      tabs
    };
  }

  workspaces[workspaceId] = {
    id: workspaceId,
    name: String(payload.name || "Importovaný workspace"),
    persistent: true,
    active: false,
    open: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    closedAt: Date.now(),
    windows
  };

  await browser.storage.local.set({ [WORKSPACES_KEY]: workspaces });
  await workspaceDebug("workspace-imported", {
    workspaceId,
    windows: Object.keys(windows).length
  });
  return workspaces[workspaceId];
}

async function getWorkspaceExport(workspaceId) {
  const { workspaces } = await loadWorkspaceStore();
  const workspace = workspaces[workspaceId];
  if (!workspace) throw new Error("Workspace not found");
  return sanitizeWorkspaceForExport(workspace);
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
    "fwm.activeWorkspaceId": store.activeWorkspaceId
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

async function cloneActiveWorkspace(name) {
  let activeWorkspaceId = await inferActiveWorkspaceFromRuntime();
  if (activeWorkspaceId) await snapshotCurrentWorkspace();

  const store = await loadWorkspaceStore();
  activeWorkspaceId = store.activeWorkspaceId ?? activeWorkspaceId;
  const workspaces = store.workspaces;
  const source = activeWorkspaceId ? workspaces[activeWorkspaceId] : null;
  if (!source) throw new Error("No active workspace");

  const id = newWorkspaceId();
  const clonedWindows = {};
  for (const sourceWindow of Object.values(source.windows ?? {})) {
    const logicalWindowId = newLogicalWindowId();
    clonedWindows[logicalWindowId] = {
      ...sourceWindow,
      id: logicalWindowId,
      open: false,
      runtimeWindowId: null,
      closedAt: Date.now()
    };
  }

  workspaces[id] = {
    ...source,
    id,
    name: String(name || "").trim() || "Workspace " + (Object.keys(workspaces).length + 1),
    active: false,
    open: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    closedAt: Date.now(),
    windows: clonedWindows
  };

  await browser.storage.local.set({ [WORKSPACES_KEY]: workspaces });
  return workspaces[id];
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
    updates["fwm.activeWorkspaceId"] = null;
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
    return restoreWorkspace(targetWorkspaceId);
  }

  await snapshotAllWindows();
  const store = await loadWorkspaceStore();
  const currentId = store.activeWorkspaceId;

  if (currentId === targetWorkspaceId) {
    const current = store.workspaces[currentId];
    const openIds = Object.values(current?.windows ?? {})
      .filter(win => win.open && win.runtimeWindowId != null)
      .map(win => win.runtimeWindowId);
    if (openIds.length) {
      try { await browser.windows.update(openIds[0], { focused: true }); } catch {}
    }
    return { reused: true, workspaceId: currentId };
  }

  const target = store.workspaces[targetWorkspaceId];
  if (!target) throw new Error("Target workspace not found");

  const current = currentId ? store.workspaces[currentId] : null;
  const oldWindowIds = Object.values(current?.windows ?? {})
    .filter(win => win.open && win.runtimeWindowId != null)
    .map(win => win.runtimeWindowId);

  // Detach old runtime windows from the workspace mapping before restoring
  // the target, so their later onRemoved events cannot mutate the new active workspace.
  const detachedMap = { ...store.windowMap };
  for (const runtimeId of oldWindowIds) delete detachedMap[String(runtimeId)];

  if (current) {
    current.active = false;
    current.open = false;
    current.closedAt = Date.now();
    current.updatedAt = Date.now();
    for (const logicalWindow of Object.values(current.windows ?? {})) {
      if (!logicalWindow.open) continue;
      logicalWindow.open = false;
      logicalWindow.closedAt = Date.now();
      logicalWindow.runtimeWindowId = null;
    }
  }

  target.active = false;
  target.open = false;

  await browser.storage.local.set({
    [WORKSPACES_KEY]: store.workspaces,
    [WINDOW_WORKSPACE_MAP_KEY]: detachedMap,
    "fwm.activeWorkspaceId": null
  });

  // Restore first. This guarantees Firefox still has at least one normal window
  // before the previous workspace windows are closed.
  const restored = await restoreWorkspace(targetWorkspaceId);

  for (const windowId of oldWindowIds) {
    if ((restored.windowIds ?? []).includes(windowId)) continue;
    try { await browser.windows.remove(windowId); } catch {}
  }

  return restored;
}

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

async function rememberActiveContentTab(tab) {
  if (!tab || tab.id == null || !isHttpUrl(tab.url)) return;
  const stored = await browser.storage.local.get(LAST_ACTIVE_CONTENT_KEY);
  const map = stored[LAST_ACTIVE_CONTENT_KEY] ?? {};
  map[String(tab.windowId)] = tab.id;
  await browser.storage.local.set({ [LAST_ACTIVE_CONTENT_KEY]: map });
}

async function mutateLifecycle(mutator) {
  const stored = await browser.storage.local.get([TAB_LIFECYCLE_KEY, HOST_STATS_KEY]);
  const lifecycle = stored[TAB_LIFECYCLE_KEY] ?? {};
  const stats = stored[HOST_STATS_KEY] ?? {};
  await mutator(lifecycle, stats);
  await browser.storage.local.set({
    [TAB_LIFECYCLE_KEY]: lifecycle,
    [HOST_STATS_KEY]: stats
  });
}

function ensureHostStats(stats, host) {
  if (!host) return null;
  stats[host] ??= {
    activations: 0,
    totalActiveMs: 0,
    totalInactiveMs: 0,
    firstSeenAt: Date.now(),
    lastActivatedAt: null,
    lastDeactivatedAt: null,
    autoDeepCount: 0
  };
  return stats[host];
}

async function markActivated(tab) {
  if (!tab || tab.id == null || !isHttpUrl(tab.url)) return;
  const now = Date.now();
  const host = hostnameFromUrl(tab.url);

  await mutateLifecycle(async (lifecycle, stats) => {
    const key = String(tab.id);
    const previous = lifecycle[key] ?? {};
    const sameActiveVisit = previous.activeSince && previous.url === tab.url;

    if (!sameActiveVisit && previous.inactiveSince && previous.host) {
      const previousStat = ensureHostStats(stats, previous.host);
      if (previousStat) {
        previousStat.totalInactiveMs = (previousStat.totalInactiveMs || 0) + Math.max(0, now - previous.inactiveSince);
      }
    }

    if (!sameActiveVisit && previous.activeSince && previous.host) {
      const previousStat = ensureHostStats(stats, previous.host);
      if (previousStat) {
        previousStat.totalActiveMs += Math.max(0, now - previous.activeSince);
        previousStat.lastDeactivatedAt = now;
      }
    }

    lifecycle[key] = {
      ...previous,
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      host,
      activeSince: sameActiveVisit ? previous.activeSince : now,
      inactiveSince: null,
      deadline: null,
      policy: "ACTIVE"
    };

    if (!sameActiveVisit) {
      const hostStat = ensureHostStats(stats, host);
      if (hostStat) {
        hostStat.activations += 1;
        hostStat.lastActivatedAt = now;
      }
    }
  });

  await rememberActiveContentTab(tab);
}

async function markInactive(tab) {
  if (!tab || tab.id == null || !isHttpUrl(tab.url)) return;
  const now = Date.now();
  const config = await getConfig();
  const policy = resolvePolicy(tab, config);
  const host = hostnameFromUrl(tab.url);

  await mutateLifecycle(async (lifecycle, stats) => {
    const key = String(tab.id);
    const previous = lifecycle[key] ?? {};
    if (previous.activeSince) {
      const hostStat = ensureHostStats(stats, host);
      if (hostStat) {
        hostStat.totalActiveMs += Math.max(0, now - previous.activeSince);
        hostStat.lastDeactivatedAt = now;
      }
    }

    let deadline = null;
    if (!protectedByRuntime(tab, config.auto)) {
      if (policy === "DEEP") deadline = now;
      else if (policy === "AUTO") {
        deadline = config.auto.deepOnLeave
          ? now
          : now + Math.max(2, Number(config.auto.minutes) || 60) * 60_000;
      }
    }

    lifecycle[key] = {
      ...previous,
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      host,
      activeSince: null,
      inactiveSince: now,
      deadline,
      policy
    };
  });

  await scheduleNextDeep();
}

async function recomputeInactivePolicy(tab) {
  if (workspaceRestoreDepth > 0) return;
  if (!tab || tab.id == null || !isHttpUrl(tab.url) || tab.active) return;

  const config = await getConfig();
  const policy = resolvePolicy(tab, config);
  const host = hostnameFromUrl(tab.url);
  const now = Date.now();

  await mutateLifecycle(async (lifecycle) => {
    const key = String(tab.id);
    const previous = lifecycle[key] ?? {};
    const inactiveSince = previous.inactiveSince || now;

    let deadline = null;
    if (!protectedByRuntime(tab, config.auto)) {
      if (policy === "DEEP") {
        deadline = now;
      } else if (policy === "AUTO") {
        deadline = config.auto.deepOnLeave
          ? now
          : inactiveSince + Math.max(2, Number(config.auto.minutes) || 60) * 60_000;
      }
    }

    lifecycle[key] = {
      ...previous,
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      host,
      activeSince: null,
      inactiveSince,
      deadline,
      policy
    };
  });
}

async function handleActivation(activeInfo) {
  if (workspaceRestoreDepth > 0) return;
  let nextTab;
  try {
    nextTab = await browser.tabs.get(activeInfo.tabId);
  } catch {
    return;
  }

  const previousId = activeByWindow.get(activeInfo.windowId);

  // Extension UI is a control surface, not user content. Keep the previous
  // content tab as the logical active tab for lifecycle/statistics purposes.
  if (isExtensionUrl(nextTab.url)) return;

  activeByWindow.set(activeInfo.windowId, activeInfo.tabId);

  if (previousId != null && previousId !== activeInfo.tabId) {
    try {
      const previousTab = await browser.tabs.get(previousId);
      if (!isExtensionUrl(previousTab.url)) await markInactive(previousTab);
    } catch {}
  }

  await markActivated(nextTab);
}

async function scheduleNextDeep() {
  if (workspaceRestoreDepth > 0) return;
  const stored = await browser.storage.local.get(TAB_LIFECYCLE_KEY);
  const lifecycle = stored[TAB_LIFECYCLE_KEY] ?? {};
  const now = Date.now();
  const deadlines = Object.values(lifecycle)
    .map(item => item?.deadline)
    .filter(deadline => Number.isFinite(deadline) && deadline > 0);

  await browser.alarms.clear(NEXT_DEEP_ALARM);
  if (!deadlines.length) return;

  const next = Math.max(now + 1000, Math.min(...deadlines));
  browser.alarms.create(NEXT_DEEP_ALARM, { when: next });
}


async function discardWithDiagnostics(tab, reason) {
  if (!tab || tab.id == null) return false;
  const attemptAt = Date.now();

  await mutateLifecycle(async lifecycle => {
    const key = String(tab.id);
    lifecycle[key] = {
      ...(lifecycle[key] ?? {}),
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      host: hostnameFromUrl(tab.url),
      lastDiscardAttemptAt: attemptAt,
      lastDiscardReason: reason,
      lastDiscardResult: "pending"
    };
  });

  try {
    await browser.tabs.discard(tab.id);
    let refreshed = null;
    try {
      refreshed = await browser.tabs.get(tab.id);
    } catch {}

    const success = refreshed?.discarded === true;
    const completedAt = Date.now();

    await mutateLifecycle(async lifecycle => {
      const key = String(tab.id);
      lifecycle[key] = {
        ...(lifecycle[key] ?? {}),
        lastDiscardResult: success ? "discarded" : "not-discarded",
        lastDiscardCompletedAt: completedAt,
        discardedAt: success ? completedAt : lifecycle[key]?.discardedAt ?? null
      };
    });

    return success;
  } catch (error) {
    const completedAt = Date.now();
    await mutateLifecycle(async lifecycle => {
      const key = String(tab.id);
      lifecycle[key] = {
        ...(lifecycle[key] ?? {}),
        lastDiscardResult: "error",
        lastDiscardError: String(error?.message ?? error),
        lastDiscardCompletedAt: completedAt
      };
    });
    console.warn("Discard failed", tab.id, reason, error);
    return false;
  }
}

async function deepAlwaysWatchdog() {
  if (workspaceRestoreDepth > 0) return;
  const config = await getConfig();
  const tabs = await browser.tabs.query({});
  const stored = await browser.storage.local.get(TAB_LIFECYCLE_KEY);
  const lifecycle = stored[TAB_LIFECYCLE_KEY] ?? {};

  for (const tab of tabs) {
    if (!isHttpUrl(tab.url) || tab.id == null) continue;
    const policy = resolvePolicy(tab, config);
    const item = lifecycle[String(tab.id)];

    if (policy === "DEEP") {
      if (protectedByRuntime(tab, config.auto)) continue;

      // DEEP ALWAYS is a desired state, not a one-shot action. Reassert it
      // periodically in case an update/reload/runtime transition left the tab loaded.
      await discardWithDiagnostics(tab, "deep-always-watchdog");
      continue;
    }

    if (policy === "AUTO" && !tab.active && !tab.discarded) {
      // Self-heal missing AUTO lifecycle state. Keep an existing inactiveSince
      // when possible; otherwise start the interval now.
      if (!item || !item.inactiveSince || !item.deadline || item.url !== tab.url) {
        await recomputeInactivePolicy(tab);
      }
    }
  }

  await scheduleNextDeep();
}

async function ensureWatchdogAlarm() {
  const existing = await browser.alarms.get(DEEP_WATCHDOG_ALARM);
  if (!existing) {
    browser.alarms.create(DEEP_WATCHDOG_ALARM, {
      delayInMinutes: 0.5,
      periodInMinutes: 0.5
    });
  }
}

async function sweepDueTabs() {
  if (workspaceRestoreDepth > 0) return;
  const config = await getConfig();
  const stored = await browser.storage.local.get([TAB_LIFECYCLE_KEY, HOST_STATS_KEY]);
  const lifecycle = stored[TAB_LIFECYCLE_KEY] ?? {};
  const stats = stored[HOST_STATS_KEY] ?? {};
  const now = Date.now();
  let changed = false;

  for (const [key, item] of Object.entries(lifecycle)) {
    if (!item?.deadline || item.deadline > now) continue;

    let tab;
    try {
      tab = await browser.tabs.get(Number(key));
    } catch {
      delete lifecycle[key];
      changed = true;
      continue;
    }

    const policy = resolvePolicy(tab, config);
    if (policy === "KEEP" || protectedByRuntime(tab, config.auto)) {
      lifecycle[key].deadline = null;
      lifecycle[key].policy = policy;
      changed = true;
      continue;
    }

    const success = await discardWithDiagnostics(tab, policy === "DEEP" ? "deep-always-deadline" : "auto-deadline");
    lifecycle[key].deadline = success ? null : now + 60_000;
    lifecycle[key].policy = policy;
    if (success) {
      const hostStat = ensureHostStats(stats, hostnameFromUrl(tab.url));
      if (hostStat) hostStat.autoDeepCount += 1;
    }
    changed = true;
  }

  if (changed) {
    await browser.storage.local.set({
      [TAB_LIFECYCLE_KEY]: lifecycle,
      [HOST_STATS_KEY]: stats
    });
  }
  await scheduleNextDeep();
}

async function seedRuntimeState() {
  const tabs = await browser.tabs.query({});
  const stored = await browser.storage.local.get(TAB_LIFECYCLE_KEY);
  const lifecycle = stored[TAB_LIFECYCLE_KEY] ?? {};

  for (const tab of tabs) {
    if (tab.id == null || tab.windowId < 0) continue;
    const item = lifecycle[String(tab.id)];

    if (tab.active) {
      if (!isExtensionUrl(tab.url)) {
        activeByWindow.set(tab.windowId, tab.id);
      }

      if (isHttpUrl(tab.url) && (!item || !item.activeSince || item.deadline)) {
        await markActivated(tab);
      }
      continue;
    }

    if (!isHttpUrl(tab.url)) continue;

    // Preserve an existing inactivity interval/deadline across event-page
    // suspension/restart. Only initialize or reconcile stale active state.
    if (!item || item.activeSince || item.url !== tab.url) {
      await markInactive(tab);
    }
  }

  await scheduleNextDeep();
}

browser.runtime.onInstalled.addListener(() => {
  seedRuntimeState().catch(console.error);
});

browser.runtime.onStartup.addListener(() => {
  seedRuntimeState().catch(console.error);
});

browser.alarms.onAlarm.addListener(alarm => {
  if (workspaceRestoreDepth > 0) return;
  if (alarm.name === NEXT_DEEP_ALARM) sweepDueTabs().catch(console.error);
  if (alarm.name === DEEP_WATCHDOG_ALARM) deepAlwaysWatchdog().catch(console.error);
});

browser.tabs.onCreated.addListener(tab => {
  if (workspaceRestoreDepth > 0) return;
  if (tab.windowId >= 0) snapshotWindow(tab.windowId).catch(console.error);
});

browser.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const stored = await browser.storage.local.get([TAB_LIFECYCLE_KEY, HOST_STATS_KEY]);
  const lifecycle = stored[TAB_LIFECYCLE_KEY] ?? {};
  const stats = stored[HOST_STATS_KEY] ?? {};
  const item = lifecycle[String(tabId)];
  const now = Date.now();

  if (item?.host) {
    const hostStat = ensureHostStats(stats, item.host);
    if (hostStat) {
      if (item.activeSince) hostStat.totalActiveMs += Math.max(0, now - item.activeSince);
      if (item.inactiveSince) hostStat.totalInactiveMs = (hostStat.totalInactiveMs || 0) + Math.max(0, now - item.inactiveSince);
    }
  }

  delete lifecycle[String(tabId)];
  await browser.storage.local.set({
    [TAB_LIFECYCLE_KEY]: lifecycle,
    [HOST_STATS_KEY]: stats
  });
  await scheduleNextDeep();
  if (!removeInfo.isWindowClosing && !(await workspaceSnapshotLocked())) {
    snapshotWindow(removeInfo.windowId).catch(console.error);
  }
});

browser.tabs.onActivated.addListener(activeInfo => {
  if (workspaceRestoreDepth > 0) return;
  handleActivation(activeInfo).catch(console.error);
  snapshotWindow(activeInfo.windowId).catch(console.error);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (workspaceRestoreDepth > 0) return;
  const relevant = ["url", "title", "pinned", "discarded", "autoDiscardable", "audible"];
  if (relevant.some(key => Object.hasOwn(changeInfo, key))) {
    if (workspaceRestoreDepth === 0) snapshotWindow(tab.windowId).catch(console.error);
  }

  if ("url" in changeInfo || "pinned" in changeInfo || "audible" in changeInfo || "discarded" in changeInfo) {
    const activeId = activeByWindow.get(tab.windowId);
    if (activeId === tabId && isHttpUrl(tab.url)) {
      markActivated(tab).catch(console.error);
    } else if (!tab.active && isHttpUrl(tab.url)) {
      markInactive(tab).catch(console.error);
    }
  }
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

  if (workspaceRestoreDepth === 0 && (changes[HOST_POLICIES_KEY] || changes[URL_POLICIES_KEY] || changes[AUTO_SETTINGS_KEY])) {
    // Recalculate only currently pending inactive lifecycle entries. Preserve
    // their original inactiveSince so changing the timeout does not restart it.
    browser.tabs.query({}).then(async tabs => {
      for (const tab of tabs) {
        if (!tab.active && isHttpUrl(tab.url)) await recomputeInactivePolicy(tab);
      }
      await scheduleNextDeep();
      await sweepDueTabs();
    }).catch(console.error);
  }
});

browser.tabGroups.onCreated.addListener(group => {
  if (workspaceRestoreDepth === 0) snapshotWindow(group.windowId).catch(console.error);
});
browser.tabGroups.onUpdated.addListener(group => {
  if (workspaceRestoreDepth === 0) snapshotWindow(group.windowId).catch(console.error);
});
browser.tabGroups.onMoved.addListener(group => {
  if (workspaceRestoreDepth === 0) snapshotWindow(group.windowId).catch(console.error);
});

browser.windows.onCreated.addListener(win => {
  if (workspaceRestoreDepth > 0) return;
  if (win.type === "normal") snapshotWindow(win.id).catch(console.error);
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
  if (message?.type === "cloneWorkspace") {
    return cloneActiveWorkspace(message.name);
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
  if (message?.type === "importWorkspace" && message.payload) {
    return importWorkspace(message.payload);
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
  activeByWindow.delete(windowId);
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
seedRuntimeState().catch(console.error);
ensureWatchdogAlarm().catch(console.error);
pullSettingsFromSync().catch(console.error);
