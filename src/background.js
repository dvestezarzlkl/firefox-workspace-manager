const STORAGE_KEY = "fwm.state";
const LAST_ACTIVE_CONTENT_KEY = "fwm.lastActiveContentTabs";
const HOST_POLICIES_KEY = "fwm.hostPolicies";
const URL_POLICIES_KEY = "fwm.urlPolicies";
const AUTO_SETTINGS_KEY = "fwm.autoSettings";
const TAB_LIFECYCLE_KEY = "fwm.tabLifecycle";
const HOST_STATS_KEY = "fwm.hostStats";
const NEXT_DEEP_ALARM = "fwm.nextDeep";

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

    try {
      await browser.tabs.discard(tab.id);
      lifecycle[key].deadline = null;
      lifecycle[key].discardedAt = now;
      lifecycle[key].policy = policy;
      const hostStat = ensureHostStats(stats, hostnameFromUrl(tab.url));
      if (hostStat) hostStat.autoDeepCount += 1;
      changed = true;
    } catch (error) {
      console.warn("AUTO DEEP failed", tab.id, error);
      lifecycle[key].deadline = now + 60_000;
      changed = true;
    }
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
  if (area !== "local") return;
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

browser.windows.onRemoved.addListener(async windowId => {
  activeByWindow.delete(windowId);
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
