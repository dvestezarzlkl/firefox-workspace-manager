const STORAGE_KEY = "fwm.state";

function emptyState() {
  return {
    version: 1,
    windows: {},
    updatedAt: Date.now()
  };
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
  const win = await browser.windows.get(windowId, { populate: true });
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
  await Promise.all(windows.map(win => snapshotWindow(win.id)));
}

browser.runtime.onInstalled.addListener(() => {
  snapshotAllWindows().catch(console.error);
});

browser.runtime.onStartup.addListener(() => {
  snapshotAllWindows().catch(console.error);
});

browser.tabs.onCreated.addListener(tab => {
  if (tab.windowId >= 0) snapshotWindow(tab.windowId).catch(console.error);
});

browser.tabs.onRemoved.addListener((_tabId, removeInfo) => {
  if (!removeInfo.isWindowClosing) {
    snapshotWindow(removeInfo.windowId).catch(console.error);
  }
});

browser.tabs.onActivated.addListener(activeInfo => {
  snapshotWindow(activeInfo.windowId).catch(console.error);
});

browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  const relevant = ["url", "title", "pinned", "discarded", "autoDiscardable", "audible"];
  if (relevant.some(key => Object.hasOwn(changeInfo, key))) {
    snapshotWindow(tab.windowId).catch(console.error);
  }
});

browser.tabGroups.onCreated.addListener(group => {
  snapshotWindow(group.windowId).catch(console.error);
});

browser.tabGroups.onUpdated.addListener(group => {
  snapshotWindow(group.windowId).catch(console.error);
});

browser.tabGroups.onMoved.addListener(group => {
  snapshotWindow(group.windowId).catch(console.error);
});

browser.windows.onCreated.addListener(win => {
  if (win.type === "normal") snapshotWindow(win.id).catch(console.error);
});

browser.windows.onRemoved.addListener(async windowId => {
  const state = await loadState();
  const entry = state.windows[String(windowId)];
  if (entry) {
    entry.closedAt = Date.now();
    entry.open = false;
    await saveState(state);
  }
});

snapshotAllWindows().catch(console.error);
