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

const activeByWindow = new Map();

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


function newWorkspaceId() {
  return crypto.randomUUID();
}

async function saveWorkspaceSnapshot(win, groups) {
  const stored = await browser.storage.local.get([WORKSPACES_KEY, WINDOW_WORKSPACE_MAP_KEY]);
  const workspaces = stored[WORKSPACES_KEY] ?? {};
  const windowMap = stored[WINDOW_WORKSPACE_MAP_KEY] ?? {};
  const windowKey = String(win.id);

  let workspaceId = windowMap[windowKey];
  if (!workspaceId || !workspaces[workspaceId]) {
    workspaceId = newWorkspaceId();
    windowMap[windowKey] = workspaceId;
    workspaces[workspaceId] = {
      id: workspaceId,
      name: "Workspace " + (Object.keys(workspaces).length + 1),
      persistent: true,
      createdAt: Date.now()
    };
  }

  const previous = workspaces[workspaceId] ?? {};
  workspaces[workspaceId] = {
    ...previous,
    id: workspaceId,
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
    groups: groups.map(group => ({
      runtimeGroupId: group.id,
      title: group.title,
      color: group.color,
      collapsed: group.collapsed
    })),
    tabs: (win.tabs ?? []).map(tab => ({
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
      runtimeGroupId: tab.groupId
    }))
  };

  await browser.storage.local.set({
    [WORKSPACES_KEY]: workspaces,
    [WINDOW_WORKSPACE_MAP_KEY]: windowMap
  });

  return workspaceId;
}

async function markWorkspaceClosed(windowId) {
  const stored = await browser.storage.local.get([WORKSPACES_KEY, WINDOW_WORKSPACE_MAP_KEY]);
  const workspaces = stored[WORKSPACES_KEY] ?? {};
  const windowMap = stored[WINDOW_WORKSPACE_MAP_KEY] ?? {};
  const key = String(windowId);
  const workspaceId = windowMap[key];

  if (workspaceId && workspaces[workspaceId]) {
    workspaces[workspaceId] = {
      ...workspaces[workspaceId],
      open: false,
      runtimeWindowId: null,
      closedAt: Date.now(),
      updatedAt: Date.now()
    };
    delete windowMap[key];
    await browser.storage.local.set({
      [WORKSPACES_KEY]: workspaces,
      [WINDOW_WORKSPACE_MAP_KEY]: windowMap
    });
  }
}

function restorableUrl(url) {
  if (!url) return null;
  if (/^(moz|chrome)-extension:\/\//i.test(url)) return null;
  return url;
}

async function restoreWorkspace(workspaceId) {
  const stored = await browser.storage.local.get([WORKSPACES_KEY, WINDOW_WORKSPACE_MAP_KEY]);
  const workspaces = stored[WORKSPACES_KEY] ?? {};
  const windowMap = stored[WINDOW_WORKSPACE_MAP_KEY] ?? {};
  const workspace = workspaces[workspaceId];

  if (!workspace) throw new Error("Workspace not found");
  if (workspace.open && workspace.runtimeWindowId != null) {
    try {
      await browser.windows.update(workspace.runtimeWindowId, { focused: true });
      return { windowId: workspace.runtimeWindowId, reused: true };
    } catch {}
  }

  const sourceTabs = (workspace.tabs ?? [])
    .slice()
    .sort((a, b) => a.index - b.index)
    .filter(tab => restorableUrl(tab.url));

  const urls = sourceTabs.map(tab => restorableUrl(tab.url)).filter(Boolean);
  const createData = {
    url: urls.length ? urls : ["about:blank"],
    focused: true
  };

  if (workspace.window?.state === "normal") {
    for (const key of ["left", "top", "width", "height"]) {
      if (Number.isFinite(workspace.window[key])) createData[key] = workspace.window[key];
    }
  }

  const win = await browser.windows.create(createData);
  const liveTabs = (await browser.tabs.query({ windowId: win.id }))
    .slice()
    .sort((a, b) => a.index - b.index);

  const refreshed = await browser.storage.local.get([WORKSPACES_KEY, WINDOW_WORKSPACE_MAP_KEY]);
  const currentWorkspaces = refreshed[WORKSPACES_KEY] ?? {};
  const currentMap = refreshed[WINDOW_WORKSPACE_MAP_KEY] ?? {};
  const temporaryWorkspaceId = currentMap[String(win.id)];

  if (temporaryWorkspaceId && temporaryWorkspaceId !== workspaceId) {
    delete currentWorkspaces[temporaryWorkspaceId];
  }
  currentMap[String(win.id)] = workspaceId;
  currentWorkspaces[workspaceId] = {
    ...workspace,
    open: true,
    runtimeWindowId: win.id,
    closedAt: null,
    restoredAt: Date.now(),
    updatedAt: Date.now()
  };

  await browser.storage.local.set({
    [WORKSPACES_KEY]: currentWorkspaces,
    [WINDOW_WORKSPACE_MAP_KEY]: currentMap
  });

  const newTabByOldRuntimeId = new Map();
  for (let i = 0; i < Math.min(sourceTabs.length, liveTabs.length); i++) {
    newTabByOldRuntimeId.set(sourceTabs[i].runtimeTabId, liveTabs[i].id);
    try {
      if (sourceTabs[i].pinned) await browser.tabs.update(liveTabs[i].id, { pinned: true });
    } catch {}
  }

  for (const group of workspace.groups ?? []) {
    const tabIds = sourceTabs
      .filter(tab => tab.runtimeGroupId === group.runtimeGroupId)
      .map(tab => newTabByOldRuntimeId.get(tab.runtimeTabId))
      .filter(id => id != null);

    if (!tabIds.length) continue;

    try {
      const newGroupId = await browser.tabs.group({
        tabIds,
        createProperties: { windowId: win.id }
      });
      await browser.tabGroups.update(newGroupId, {
        title: group.title ?? "",
        color: group.color,
        collapsed: !!group.collapsed
      });
    } catch (error) {
      console.warn("Unable to restore tab group", workspaceId, error);
    }
  }

  const activeSource = sourceTabs.find(tab => tab.active);
  const activeTabId = activeSource ? newTabByOldRuntimeId.get(activeSource.runtimeTabId) : null;
  if (activeTabId != null) {
    try { await browser.tabs.update(activeTabId, { active: true }); } catch {}
  }

  for (const source of sourceTabs) {
    if (!source.discarded || source.active) continue;
    const tabId = newTabByOldRuntimeId.get(source.runtimeTabId);
    if (tabId == null) continue;
    try { await browser.tabs.discard(tabId); } catch {}
  }

  await snapshotWindow(win.id);
  return { windowId: win.id, reused: false };
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
  snapshotAllWindows().catch(console.error);
  seedRuntimeState().catch(console.error);
});

browser.runtime.onStartup.addListener(() => {
  snapshotAllWindows().catch(console.error);
  seedRuntimeState().catch(console.error);
});

browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === NEXT_DEEP_ALARM) sweepDueTabs().catch(console.error);
  if (alarm.name === DEEP_WATCHDOG_ALARM) deepAlwaysWatchdog().catch(console.error);
});

browser.tabs.onCreated.addListener(tab => {
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
  if (!removeInfo.isWindowClosing) snapshotWindow(removeInfo.windowId).catch(console.error);
});

browser.tabs.onActivated.addListener(activeInfo => {
  handleActivation(activeInfo).catch(console.error);
  snapshotWindow(activeInfo.windowId).catch(console.error);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const relevant = ["url", "title", "pinned", "discarded", "autoDiscardable", "audible"];
  if (relevant.some(key => Object.hasOwn(changeInfo, key))) {
    snapshotWindow(tab.windowId).catch(console.error);
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

  if (changes[HOST_POLICIES_KEY] || changes[URL_POLICIES_KEY] || changes[AUTO_SETTINGS_KEY]) {
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

browser.tabGroups.onCreated.addListener(group => snapshotWindow(group.windowId).catch(console.error));
browser.tabGroups.onUpdated.addListener(group => snapshotWindow(group.windowId).catch(console.error));
browser.tabGroups.onMoved.addListener(group => snapshotWindow(group.windowId).catch(console.error));

browser.windows.onCreated.addListener(win => {
  if (win.type === "normal") snapshotWindow(win.id).catch(console.error);
});

browser.runtime.onMessage.addListener(message => {
  if (message?.type === "restoreWorkspace" && message.workspaceId) {
    return restoreWorkspace(message.workspaceId);
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

snapshotAllWindows().catch(console.error);
seedRuntimeState().catch(console.error);
ensureWatchdogAlarm().catch(console.error);
pullSettingsFromSync().catch(console.error);
