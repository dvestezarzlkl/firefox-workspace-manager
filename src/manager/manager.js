// @ts-check

import {
  ACTIVE_WORKSPACE_KEY,
  AUTO_SETTINGS_KEY,
  HOST_POLICIES_KEY,
  HOST_RESULT_LIMIT,
  HOST_STATS_KEY,
  KNOWN_HOSTS_KEY,
  LAST_ACTIVE_CONTENT_KEY,
  SYNC_ENABLED_KEY,
  TAB_LIFECYCLE_KEY,
  UI_PAGE_KEY,
  URL_POLICIES_KEY,
  WORKSPACES_KEY,
  WORKSPACE_DEBUG_KEY
} from "../shared/constants.js";
import { hostnameFromUrl, isExtensionUrl } from "../shared/url.js";
import { H } from "../shared/H.js";
import { PanelExplorerController } from "./PanelExplorerController.js";

const app = document.getElementById("app");
const summary = document.getElementById("summary");
const refreshButton = document.getElementById("refresh");
const deepAllButton = document.getElementById("deepAll");
const closeButton = document.getElementById("closeManager");
const hostPoliciesEl = document.getElementById("hostPolicies");
const hostResultInfo = document.getElementById("hostResultInfo");
const hostFilter = document.getElementById("hostFilter");
const autoMinutes = document.getElementById("autoMinutes");
const autoDeepOnLeave = document.getElementById("autoDeepOnLeave");
const autoProtectPinned = document.getElementById("autoProtectPinned");
const autoProtectAudible = document.getElementById("autoProtectAudible");
const urlPattern = document.getElementById("urlPattern");
const useLastPage = document.getElementById("useLastPage");
const addUrlKeep = document.getElementById("addUrlKeep");
const urlPoliciesEl = document.getElementById("urlPolicies");
const syncEnabled = document.getElementById("syncEnabled");
const workspaceListEl = document.getElementById("workspaceList");
const snapshotWorkspaceButton = document.getElementById("snapshotWorkspace");
const cloneWorkspaceButton = document.getElementById("cloneWorkspace");
const importWorkspaceButton = document.getElementById("importWorkspace");
const importWorkspaceFile = document.getElementById("importWorkspaceFile");
const backupWorkspacesButton = document.getElementById("backupWorkspaces");
const restoreWorkspacesButton = document.getElementById("restoreWorkspaces");
const restoreWorkspacesFile = document.getElementById("restoreWorkspacesFile");
const managerVersion = document.getElementById("managerVersion");
const managerDeveloper = document.getElementById("managerDeveloper");
const panelSearch = document.getElementById("panelSearch");
const panelFilterReset = document.getElementById("panelFilterReset");
const panelStateFilters = document.getElementById("panelStateFilters");
const panelPolicyFilters = document.getElementById("panelPolicyFilters");
const panelFilterInfo = document.getElementById("panelFilterInfo");
const panelExpandAll = document.getElementById("panelExpandAll");
const panelCollapseAll = document.getElementById("panelCollapseAll");
const panelAlwaysExpanded = document.getElementById("panelAlwaysExpanded");
const panelAutoRefresh = document.getElementById("panelAutoRefresh");

let managerTabId = null;
let managerWindowId = null;
let lastActiveContentTabId = null;
let currentOpenHosts = [];
let knownHosts = [];
let currentWindows = [];
let currentWindowGroups = new Map();
let lifecycleMap = {};
let hostStats = {};
let urlPolicies = [];
let hostPolicies = {};
let workspaces = {};
let activeWorkspaceId = null;
let expandedWorkspaceId = null;
let workspaceDebugLog = [];
let panelStateFilterSet = new Set();
let panelPolicyFilterSet = new Set();

const panelExplorer = new PanelExplorerController({
  root: app,
  alwaysExpandedInput: panelAlwaysExpanded,
  refreshSelect: panelAutoRefresh,
  isFilterActive: panelFilterActive,
  reload: load
});
const panelExplorerState = panelExplorer.state;
panelExplorer.configureAutoRefresh();

const manifestMeta = browser.runtime.getManifest();
if (managerVersion) managerVersion.textContent = "v" + manifestMeta.version;
if (managerDeveloper) {
  managerDeveloper.textContent = manifestMeta.developer?.name || manifestMeta.author || "dvestezar.cz";
  managerDeveloper.href = manifestMeta.developer?.url || manifestMeta.homepage_url || "https://dvestezar.cz/";
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stateBadge(tab) {
  if (tab.active) {
    return H.el("span", {
      className: "state state-active",
      title: "Aktivní"
    }, "●");
  }

  if (tab.discarded) {
    return H.el("span", {
      className: "state state-deep",
      title: "DEEP / uvolněno z paměti"
    }, "○");
  }

  return H.el("span", {
    className: "state state-loaded",
    title: "Načteno v paměti"
  }, "✓");
}

function extraFlags(tab) {
  const flags = [];
  if (tab.audible) flags.push("🔊");
  if (tab.pinned) flags.push("📌");
  if (tab.autoDiscardable === false) flags.push("⏻");
  return flags;
}

function isInternalExtensionTab(tab) {
  return isExtensionUrl(tab?.url);
}

function isProtectedFromDeep(tab) {
  return tab.id == null ||
    tab.id === managerTabId ||
    tab.id === lastActiveContentTabId ||
    tab.active ||
    tab.discarded ||
    tab.audible ||
    tab.pinned ||
    isInternalExtensionTab(tab) ||
    exactUrlException(tab);
}

async function loadHostPolicies() {
  const stored = await browser.storage.local.get(HOST_POLICIES_KEY);
  return stored[HOST_POLICIES_KEY] ?? {};
}

async function saveHostPolicy(host, mode) {
  const policies = await loadHostPolicies();
  if (mode === "AUTO") delete policies[host];
  else policies[host] = mode;
  await browser.storage.local.set({ [HOST_POLICIES_KEY]: policies });
}

async function updateKnownHosts(openHosts) {
  const stored = await browser.storage.local.get(KNOWN_HOSTS_KEY);
  const previous = Array.isArray(stored[KNOWN_HOSTS_KEY]) ? stored[KNOWN_HOSTS_KEY] : [];
  knownHosts = [...new Set([...previous, ...openHosts])].sort().slice(-1000);
  await browser.storage.local.set({ [KNOWN_HOSTS_KEY]: knownHosts });
}

async function loadSyncSetting() {
  const stored = await browser.storage.local.get(SYNC_ENABLED_KEY);
  syncEnabled.checked = !!stored[SYNC_ENABLED_KEY];
}

async function saveSyncSetting() {
  const enabled = !!syncEnabled.checked;
  await browser.storage.local.set({ [SYNC_ENABLED_KEY]: enabled });
  if (enabled) {
    await browser.runtime.sendMessage({ type: "pushSyncSettings" });
  }
}

async function loadAutoSettings() {
  const stored = await browser.storage.local.get(AUTO_SETTINGS_KEY);
  const value = {
    minutes: 60,
    deepOnLeave: false,
    protectPinned: true,
    protectAudible: true,
    ...(stored[AUTO_SETTINGS_KEY] ?? {})
  };
  autoMinutes.value = value.minutes;
  autoDeepOnLeave.checked = value.deepOnLeave;
  autoProtectPinned.checked = value.protectPinned;
  autoProtectAudible.checked = value.protectAudible;
}

async function saveAutoSettings() {
  await browser.storage.local.set({
    [AUTO_SETTINGS_KEY]: {
      minutes: Math.max(2, Math.min(10080, Number(autoMinutes.value) || 60)),
      deepOnLeave: autoDeepOnLeave.checked,
      protectPinned: autoProtectPinned.checked,
      protectAudible: autoProtectAudible.checked
    }
  });
}

function formatRemaining(deadline) {
  const remaining = Math.max(0, Number(deadline) - Date.now());
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes + ":" + String(seconds).padStart(2, "0");
}

function exactUrlException(tab) {
  const url = tab?.url ?? "";
  return urlPolicies.some(rule => rule?.mode === "KEEP" && rule?.url === url);
}

function policyBadge(tab) {
  if (exactUrlException(tab)) {
    return H.el("span", {
      className: "policy-badge policy-keep",
      title: "Přesná URL je výjimka KEEP"
    }, "EXCEPT");
  }

  const host = hostnameFromUrl(tab.url);
  const mode = host ? hostPolicies[host] : null;

  if (mode === "DEEP") {
    return H.el("span", {
      className: "policy-badge policy-deep",
      title: "Hostname má politiku DEEP"
    }, "DEEP ALWAYS");
  }

  if (mode === "KEEP") {
    return H.el("span", {
      className: "policy-badge policy-keep",
      title: "Hostname má politiku KEEP"
    }, "KEEP ALWAYS");
  }

  return null;
}

function tabPolicyFilterKey(tab) {
  if (exactUrlException(tab)) return "except";
  const host = hostnameFromUrl(tab.url);
  const mode = host ? hostPolicies[host] : null;
  if (mode === "KEEP") return "keep";
  if (mode === "DEEP") return "deep-always";
  return "auto";
}

function shortTabUrl(url) {
  const raw = String(url ?? "");
  try {
    const parsed = new URL(raw);
    if (["http:", "https:"].includes(parsed.protocol)) {
      const value = parsed.host + parsed.pathname + parsed.search + parsed.hash;
      return value.length > 120 ? value.slice(0, 117) + "…" : value;
    }
  } catch {}
  return raw.length > 120 ? raw.slice(0, 117) + "…" : raw;
}

function panelFilterActive() {
  return !!panelSearch?.value.trim() || panelStateFilterSet.size > 0 || panelPolicyFilterSet.size > 0;
}

function panelSearchActive() {
  return !!panelSearch?.value.trim();
}

function tabMatchesPanelFilters(tab, groupTitle = "") {
  const query = panelSearch?.value.trim().toLocaleLowerCase("cs-CZ") ?? "";
  if (query) {
    const haystack = [
      tab.title ?? "",
      tab.url ?? "",
      groupTitle ?? ""
    ].join("\n").toLocaleLowerCase("cs-CZ");
    if (!haystack.includes(query)) return false;
  }

  if (panelStateFilterSet.size) {
    const states = new Set();
    if (tab.active) states.add("active");
    if (tab.discarded) states.add("deep");
    else states.add("loaded");
    if (![...panelStateFilterSet].some(value => states.has(value))) return false;
  }

  if (panelPolicyFilterSet.size && !panelPolicyFilterSet.has(tabPolicyFilterKey(tab))) {
    return false;
  }

  return true;
}

function updatePanelFilterUi(allTabs, visibleTabs) {
  const counts = {
    active: allTabs.filter(tab => tab.active).length,
    loaded: allTabs.filter(tab => !tab.discarded).length,
    deep: allTabs.filter(tab => tab.discarded).length,
    auto: allTabs.filter(tab => tabPolicyFilterKey(tab) === "auto").length,
    keep: allTabs.filter(tab => tabPolicyFilterKey(tab) === "keep").length,
    "deep-always": allTabs.filter(tab => tabPolicyFilterKey(tab) === "deep-always").length,
    except: allTabs.filter(tab => tabPolicyFilterKey(tab) === "except").length
  };

  for (const [key, value] of Object.entries(counts)) {
    const el = document.querySelector('[data-panel-filter-count="' + key + '"]');
    if (el) el.textContent = String(value);
  }

  document.querySelectorAll(".panel-filter").forEach(button => {
    const set = button.dataset.panelFilterCategory === "state"
      ? panelStateFilterSet
      : panelPolicyFilterSet;
    const active = set.has(button.dataset.panelFilter);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });

  const filtered = panelFilterActive();
  if (panelFilterReset) panelFilterReset.hidden = !filtered;
  if (panelFilterInfo) {
    panelFilterInfo.textContent = filtered
      ? visibleTabs + " z " + allTabs.length + " panelů"
      : allTabs.length + " panelů";
  }
}

function formatClock(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("cs-CZ", { hour12: false });
}


/**
 * Format a persistent timestamp for compact workspace provenance UI.
 *
 * @param {number|null|undefined} ts
 * @returns {string}
 */
function formatDateTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("cs-CZ", { hour12: false });
}

/**
 * Local-time backup prefix required by the backup/export naming convention.
 *
 * @param {Date} [date]
 * @returns {string}
 */
function backupTimestamp(date = new Date()) {
  const part = value => String(value).padStart(2, "0");
  return String(date.getFullYear()) +
    part(date.getMonth() + 1) +
    part(date.getDate()) +
    part(date.getHours()) +
    part(date.getMinutes()) +
    part(date.getSeconds());
}

/**
 * Convert a user-visible workspace name to a filesystem-safe filename part.
 *
 * @param {string} value
 * @returns {string}
 */
function safeFilenamePart(value) {
  const safe = String(value || "workspace")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^_+|_+$/g, "");
  return safe || "workspace";
}

/**
 * Download one JSON payload without introducing an additional extension API.
 *
 * @param {unknown} payload
 * @param {string} filename
 */
function downloadJson(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** @param {string} value */
function normalizeWorkspaceName(value) {
  return String(value ?? "").trim().toLocaleLowerCase("cs-CZ");
}

/**
 * Resolve duplicate imported workspace names before writing anything.
 *
 * Returning null means the user cancelled the complete import operation.
 *
 * @param {any[]} payloads
 * @returns {string[]|null}
 */
function resolveImportNames(payloads) {
  const reserved = new Set(
    Object.values(workspaces ?? {})
      .map(workspace => normalizeWorkspaceName(workspace?.name))
      .filter(Boolean)
  );
  const resolved = [];

  for (const payload of payloads) {
    const original = String(payload?.name || "Importovaný workspace").trim() ||
      "Importovaný workspace";
    let candidate = original;

    while (
      !candidate ||
      reserved.has(normalizeWorkspaceName(candidate))
    ) {
      const conflict = candidate
        ? 'Workspace s názvem "' + candidate + '" už existuje.'
        : "Název workspace nesmí být prázdný.";

      const entered = prompt(
        conflict + "\n\n" +
        "Zadej nový název, nebo dej Storno pro zrušení celého importu:",
        original + " import"
      );

      if (entered == null) return null;
      candidate = entered.trim();
    }

    reserved.add(normalizeWorkspaceName(candidate));
    resolved.push(candidate);
  }

  return resolved;
}

/**
 * Human-readable provenance shown directly on a workspace card.
 *
 * @param {any} workspace
 * @returns {string}
 */
function workspaceProvenanceText(workspace) {
  const parts = [];

  if (workspace?.createdAt) {
    parts.push("Vytvořeno " + formatDateTime(workspace.createdAt));
  }

  if (workspace?.importedAt) {
    let imported = "Importováno " + formatDateTime(workspace.importedAt);
    if (workspace.importSource) imported += " z " + workspace.importSource;
    if (
      workspace.originalName &&
      workspace.originalName !== workspace.name
    ) {
      imported += ' · původně "' + workspace.originalName + '"';
    }
    parts.push(imported);
  }

  return parts.join(" · ");
}

function discardDebugText(tab) {
  const item = lifecycleMap[String(tab.id)];
  if (!item?.lastDiscardAttemptAt) return null;

  const result = item.lastDiscardResult ?? "—";
  const reason = item.lastDiscardReason ?? "—";
  const discardedAt = item.discardedAt
    ? " · discarded " + formatClock(item.discardedAt)
    : "";

  return H.el("span", {
    className: "discard-debug",
    title: "Poslední pokus o discard"
  },
  "discard ",
  formatClock(item.lastDiscardAttemptAt),
  " · ",
  reason,
  " · ",
  result,
  discardedAt);
}

function lifecycleText(tab) {
  const item = lifecycleMap[String(tab.id)];
  if (!item || tab.active || tab.discarded) return null;

  const host = hostnameFromUrl(tab.url);
  const mode = host ? hostPolicies[host] : null;
  if (exactUrlException(tab) || mode === "KEEP" || mode === "DEEP") return null;
  if (!item.deadline) return null;

  return H.el("span", {
    className: "countdown",
    dataset: { deadline: item.deadline }
  }, "DEEP za " + formatRemaining(item.deadline));
}

function renderTab(tab) {
  const disabled = isProtectedFromDeep(tab);
  const excepted = exactUrlException(tab);

  const meta = H.el(
    "div",
    { className: "meta" },
    stateBadge(tab),
    H.el("span", {}, "#" + tab.id),
    H.el(
      "span",
      {
        className: "flags",
        title: "Další stavové příznaky"
      },
      extraFlags(tab).join(" ")
    ),
    policyBadge(tab),
    lifecycleText(tab),
    discardDebugText(tab)
  );

  const main = H.el(
    "div",
    { className: "tab-main" },
    H.el(
      "div",
      { className: "tab-title-row" },
      H.el("span", {
        className: "entity-icon tab-icon",
        attrs: { "aria-hidden": "true" }
      }),
      H.el(
        "div",
        {
          className: "tab-title",
          title: tab.url ?? ""
        },
        tab.title || tab.url || "(bez názvu)"
      )
    ),
    H.el(
      "div",
      {
        className: "tab-url",
        title: tab.url ?? ""
      },
      shortTabUrl(tab.url)
    ),
    meta
  );

  const actions = H.el(
    "div",
    { className: "tab-actions" },
    H.el(
      "button",
      {
        type: "button",
        className: excepted ? "except-active" : "",
        dataset: {
          action: "except",
          tabId: tab.id
        }
      },
      excepted ? "EXCEPT ✓" : "EXCEPT"
    ),
    H.el(
      "button",
      {
        type: "button",
        disabled: disabled || excepted,
        dataset: {
          action: "deep",
          tabId: tab.id
        }
      },
      "DEEP"
    )
  );

  return H.el(
    "div",
    {
      className: "tab",
      dataset: { tabId: tab.id }
    },
    main,
    actions
  );
}

function liveHostUsage(host) {
  const base = hostStats[host] ?? {};
  let activeMs = Number(base.totalActiveMs) || 0;
  let inactiveMs = Number(base.totalInactiveMs) || 0;
  const now = Date.now();

  for (const item of Object.values(lifecycleMap)) {
    if (item?.host !== host) continue;
    if (item.activeSince) activeMs += Math.max(0, now - item.activeSince);
    if (item.inactiveSince) inactiveMs += Math.max(0, now - item.inactiveSince);
  }

  const total = activeMs + inactiveMs;
  return {
    activeMs,
    inactiveMs,
    total,
    activePct: total ? (activeMs / total) * 100 : null,
    inactivePct: total ? (inactiveMs / total) * 100 : null
  };
}

function formatDuration(ms) {
  const seconds = Math.round((ms || 0) / 1000);
  if (seconds < 60) return seconds + " s";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + " min";
  return (minutes / 60).toFixed(1) + " h";
}

async function renderHostPolicies() {
  const policies = await loadHostPolicies();
  const filter = hostFilter.value.trim().toLowerCase();

  const baseHosts = filter
    ? [...new Set([...knownHosts, ...Object.keys(policies), ...currentOpenHosts])]
        .filter(host => host.includes(filter))
    : currentOpenHosts;

  const hosts = baseHosts.slice(0, HOST_RESULT_LIMIT);

  if (!hosts.length) {
    H.replace(hostPoliciesEl, H.el("div", { className: "empty" }, "Nic nenalezeno."));
  } else {
    const grid = H.el("div", { className: "policy-grid" });

    for (const host of hosts) {
      const mode = policies[host] ?? "AUTO";
      const stat = hostStats[host];
      const usage = liveHostUsage(host);

      const hostLabel = H.el(
        "span",
        { className: "policy-host", title: host },
        host
      );

      if (stat?.activations || usage.total) {
        const activations = stat?.activations || 0;
        const avg = activations
          ? formatDuration(usage.activeMs / activations)
          : "—";
        const pct = usage.total
          ? Math.round(usage.activePct) + "% aktivní / " +
            Math.round(usage.inactivePct) + "% pozadí"
          : "bez historie";

        H.append(
          hostLabel,
          H.el(
            "span",
            { className: "host-stats" },
            activations + "× aktivní · průměr " + avg +
              " · " + pct + " · z " + formatDuration(usage.total)
          )
        );
      }

      const select = H.el("select", {
        dataset: { hostPolicy: host }
      });

      for (const optionMode of ["AUTO", "KEEP", "DEEP"]) {
        select.appendChild(H.el(
          "option",
          {
            value: optionMode,
            selected: mode === optionMode
          },
          optionMode
        ));
      }

      grid.appendChild(H.el(
        "label",
        { className: "policy-row" },
        hostLabel,
        select
      ));
    }

    H.replace(hostPoliciesEl, grid);
  }

  const total = baseHosts.length;
  hostResultInfo.textContent = filter
    ? `Nalezeno ${total}; zobrazeno max. ${Math.min(total, HOST_RESULT_LIMIT)}.`
    : `Zobrazeny pouze hostname z aktuálně otevřených panelů; max. ${HOST_RESULT_LIMIT}.`;
}

function workspaceStats(workspace) {
  const windows = Object.values(workspace?.windows ?? {});
  return {
    windows: windows.length,
    openWindows: windows.filter(win => win.open).length,
    closedWindows: windows.filter(win => !win.open).length,
    tabs: windows.reduce((sum, win) => sum + (win.tabs ?? []).length, 0),
    groups: windows.reduce((sum, win) => sum + (win.groups ?? []).length, 0)
  };
}


function workspaceDebugText(workspace) {
  const version = browser.runtime.getManifest().version;
  const relatedLog = workspaceDebugLog
    .filter(item => item?.data?.workspaceId === workspace.id)
    .slice(-100);

  const lines = [
    "Firefox Workspace Manager v" + version,
    "Workspace: " + (workspace.name || "Workspace"),
    "Workspace ID: " + workspace.id,
    ""
  ];

  for (const item of relatedLog) {
    const ts = item?.at ? new Date(item.at).toLocaleTimeString("cs-CZ", { hour12: false }) : "--:--:--";
    lines.push(ts + " | " + (item?.event || "event") + " | " + JSON.stringify(item?.data ?? {}));
  }

  return lines.join("\n");
}

function renderWorkspaceTree(workspace) {
  const windows = Object.values(workspace?.windows ?? {});

  if (!windows.length) {
    return H.el(
      "div",
      { className: "workspace-tree-empty" },
      "Workspace nemá uložená okna."
    );
  }

  const tree = H.el("div", { className: "workspace-tree" });
  tree.appendChild(
    H.el(
      "div",
      { className: "workspace-tree-name" },
      workspace.name || "Workspace"
    )
  );

  for (const [logicalWindowId, win] of Object.entries(workspace?.windows ?? {})) {
    const windowIndex = Object.keys(workspace?.windows ?? {}).indexOf(logicalWindowId);
    const tabs = (win.tabs ?? [])
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const groups = win.groups ?? [];
    const groupedRuntimeIds = new Set();

    const windowNode = H.el(
      "div",
      { className: "workspace-tree-window" },
      H.el(
        "div",
        { className: "workspace-tree-window-head" },
        H.el("strong", {}, "window" + windowIndex),
        H.el(
          "button",
          {
            type: "button",
            dataset: {
              workspaceWindowAction: "remove",
              workspaceId: workspace.id,
              logicalWindowId
            }
          },
          "Vyřadit"
        )
      )
    );

    for (const [groupIndex, group] of groups.entries()) {
      const groupTabs = tabs.filter(
        tab => tab.runtimeGroupId === group.runtimeGroupId
      );

      groupTabs.forEach(tab => groupedRuntimeIds.add(tab.runtimeTabId));
      if (!groupTabs.length) continue;

      const list = H.el("ul");
      for (const tab of groupTabs) {
        list.appendChild(
          H.el(
            "li",
            {},
            H.el("span", {}, tab.title || "(bez názvu)"),
            " ",
            H.el("code", {}, tab.url || "")
          )
        );
      }

      windowNode.appendChild(
        H.el(
          "div",
          { className: "workspace-tree-group" },
          H.el("strong", {}, group.title || ("group" + groupIndex)),
          list
        )
      );
    }

    const ungrouped = tabs.filter(
      tab => !groupedRuntimeIds.has(tab.runtimeTabId)
    );

    if (ungrouped.length) {
      const list = H.el("ul");

      for (const tab of ungrouped) {
        list.appendChild(
          H.el(
            "li",
            {},
            H.el("span", {}, tab.title || "(bez názvu)"),
            " ",
            H.el("code", {}, tab.url || "")
          )
        );
      }

      windowNode.appendChild(
        H.el(
          "div",
          { className: "workspace-tree-group" },
          H.el("strong", {}, "Bez skupiny"),
          list
        )
      );
    }

    tree.appendChild(windowNode);
  }

  const relatedLog = workspaceDebugLog
    .filter(item => item?.data?.workspaceId === workspace.id)
    .slice(-30)
    .reverse();

  const debugList = H.el("div", { className: "workspace-debug-list" });

  if (relatedLog.length) {
    for (const item of relatedLog) {
      debugList.appendChild(
        H.el(
          "div",
          { className: "workspace-debug-row" },
          H.el("code", {}, formatClock(item.at)),
          H.el("strong", {}, item.event),
          H.el("code", {}, JSON.stringify(item.data ?? {}))
        )
      );
    }
  } else {
    debugList.appendChild(
      H.el(
        "div",
        { className: "empty" },
        "Pro tento workspace zatím není debug záznam."
      )
    );
  }

  tree.appendChild(
    H.el(
      "details",
      { className: "workspace-debug" },
      H.el(
        "summary",
        {},
        H.el("span", {}, "Debug log (" + relatedLog.length + ")"),
        H.el(
          "button",
          {
            type: "button",
            className: "workspace-debug-copy",
            dataset: { copyWorkspaceLog: workspace.id }
          },
          "Copy"
        )
      ),
      debugList
    )
  );

  return tree;
}

function renderWorkspaces() {
  const entries = Object.values(workspaces ?? {}).sort((a, b) => {
    if (a.id === activeWorkspaceId) return -1;
    if (b.id === activeWorkspaceId) return 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  if (!entries.length) {
    H.replace(
      workspaceListEl,
      H.el(
        "div",
        { className: "empty" },
        "Zatím není uložený žádný workspace."
      )
    );
    return;
  }

  const cards = entries.map(workspace => {
    const stat = workspaceStats(workspace);
    const active =
      workspace.id === activeWorkspaceId &&
      stat.openWindows > 0;
    const status = active
      ? "AKTIVNÍ"
      : (stat.openWindows > 0 ? "OTEVŘENÝ" : "ZAVŘENÝ");
    const statusClass = active
      ? "active"
      : (stat.openWindows > 0 ? "open" : "closed");

    const nameRow = H.el(
      "div",
      { className: "workspace-name-row" },
      H.el("strong", {}, workspace.name || "Workspace"),
      H.el(
        "span",
        {
          className:
            "workspace-status workspace-status-" + statusClass
        },
        status
      )
    );

    const provenanceText = workspaceProvenanceText(workspace);

    const info = H.el(
      "div",
      {},
      nameRow,
      H.el(
        "div",
        { className: "workspace-meta" },
        stat.openWindows + " otevřená / " +
          stat.windows + " uložená okna · " +
          stat.tabs + " panelů · " +
          stat.groups + " skupin"
      ),
      provenanceText
        ? H.el(
            "div",
            { className: "workspace-provenance" },
            provenanceText
          )
        : null
    );

    const action = (name, label, disabled = false) =>
      H.el(
        "button",
        {
          type: "button",
          disabled,
          dataset: {
            workspaceAction: name,
            workspaceId: workspace.id
          }
        },
        label
      );

    const actions = H.el(
      "div",
      { className: "workspace-actions" },
      action(
        "details",
        expandedWorkspaceId === workspace.id
          ? "Skrýt"
          : "👁 Detail"
      ),
      action("export", "Export JSON"),
      action(
        "switch",
        activeWorkspaceId ? "Přepnout" : "Recover session",
        active
      ),
      action("rename", "Přejmenovat"),
      action("delete", "Smazat")
    );

    const card = H.el(
      "section",
      {
        className:
          "workspace-card" +
          (active ? " workspace-active" : "")
      },
      H.el(
        "div",
        { className: "workspace-card-main" },
        info,
        actions
      )
    );

    if (expandedWorkspaceId === workspace.id) {
      card.appendChild(renderWorkspaceTree(workspace));
    }

    return card;
  });

  H.replace(workspaceListEl, ...cards);
}

function renderPanels() {
  const windowNodes = [];
  const allTabs = currentWindows.flatMap(win => win.tabs ?? []);
  let visibleTabCount = 0;
  const filtering = panelFilterActive();

  for (const win of currentWindows) {
    const groups = currentWindowGroups.get(win.id) ?? [];
    const tabs = win.tabs ?? [];
    const groupedIds = new Set();
    const groupNodes = [];

    for (const group of groups) {
      const groupTabs = tabs.filter(tab => tab.groupId === group.id);
      groupTabs.forEach(tab => groupedIds.add(tab.id));

      const title = group.title || "(skupina bez názvu)";
      const visibleTabs = groupTabs.filter(tab => tabMatchesPanelFilters(tab, title));
      if (filtering && !visibleTabs.length) continue;

      visibleTabCount += visibleTabs.length;
      const groupKey = String(win.id) + ":" + String(group.id);
      const groupOpen = filtering || panelExplorer.shouldOpenGroup(groupKey);
      const shownTabs = filtering ? visibleTabs : groupTabs;
      const deepCount = shownTabs.filter(tab => tab.discarded).length;
      const countText = filtering
        ? shownTabs.length + "/" + groupTabs.length + " panelů"
        : groupTabs.length + " panelů";

      const titleNode = H.el(
        "span",
        { className: "disclosure-title" },
        H.el("strong", {}, title),
        H.el("span", { className: "header-meta" },
          " · " + countText + " · " + deepCount + " DEEP")
      );

      const summaryNode = H.el(
        "summary",
        {
          className: "group-header",
          dataset: { groupColor: group.color }
        },
        H.el(
          "span",
          { className: "group-header-main" },
          H.el("span", {
            className: "entity-icon group-icon",
            attrs: { "aria-hidden": "true" }
          }),
          H.el("span", {
            className: "group-color-dot",
            attrs: { "aria-hidden": "true" }
          }),
          titleNode
        ),
        H.el(
          "button",
          {
            type: "button",
            dataset: {
              action: "deep-group",
              groupId: group.id
            }
          },
          "DEEP skupinu"
        )
      );

      const detailsNode = H.el(
        "details",
        {
          className: "group",
          open: groupOpen,
          dataset: { panelGroupKey: groupKey }
        },
        summaryNode
      );

      if (shownTabs.length) {
        for (const tab of shownTabs) {
          detailsNode.appendChild(renderTab(tab));
        }
      } else {
        detailsNode.appendChild(
          H.el("div", { className: "empty" }, "Prázdná skupina")
        );
      }

      groupNodes.push(detailsNode);
    }

    const ungrouped = tabs.filter(tab => !groupedIds.has(tab.id));
    const visibleUngrouped = ungrouped.filter(tab =>
      tabMatchesPanelFilters(tab, "Bez skupiny")
    );

    if (!filtering || visibleUngrouped.length) {
      const groupKey = String(win.id) + ":ungrouped";
      const groupOpen = filtering || panelExplorer.shouldOpenGroup(groupKey);
      const shownTabs = filtering ? visibleUngrouped : ungrouped;

      if (shownTabs.length) {
        visibleTabCount += shownTabs.length;
        const deepCount = shownTabs.filter(tab => tab.discarded).length;
        const countText = filtering
          ? shownTabs.length + "/" + ungrouped.length + " panelů"
          : ungrouped.length + " panelů";

        const detailsNode = H.el(
          "details",
          {
            className: "group",
            open: groupOpen,
            dataset: { panelGroupKey: groupKey }
          },
          H.el(
            "summary",
            { className: "group-header ungrouped-header" },
            H.el(
              "span",
              { className: "group-header-main" },
              H.el("span", {
                className: "entity-icon group-icon ungrouped-icon",
                attrs: { "aria-hidden": "true" }
              }),
              H.el(
                "span",
                { className: "disclosure-title" },
                H.el("strong", {}, "Bez skupiny"),
                H.el(
                  "span",
                  { className: "header-meta" },
                  " · " + countText + " · " + deepCount + " DEEP"
                )
              )
            )
          )
        );

        for (const tab of shownTabs) {
          detailsNode.appendChild(renderTab(tab));
        }

        groupNodes.push(detailsNode);
      }
    }

    if (filtering && !groupNodes.length) continue;

    const visibleInWindow = filtering
      ? tabs.filter(tab => {
          const group = groups.find(item => item.id === tab.groupId);
          return tabMatchesPanelFilters(tab, group?.title || "Bez skupiny");
        }).length
      : tabs.length;

    const windowKey = String(win.id);
    const windowOpen = filtering || panelExplorer.shouldOpenWindow(windowKey);
    const windowDeep = tabs.filter(tab => tab.discarded).length;
    const countText = filtering
      ? visibleInWindow + "/" + tabs.length + " panelů"
      : tabs.length + " panelů";

    const windowNode = H.el(
      "details",
      {
        className: "window",
        open: windowOpen,
        dataset: { panelWindowKey: windowKey }
      },
      H.el(
        "summary",
        { className: "window-header" },
        H.el("span", {
          className: "entity-icon window-icon",
          attrs: { "aria-hidden": "true" }
        }),
        H.el(
          "span",
          { className: "disclosure-title" },
          H.el("strong", {}, "Okno #" + win.id),
          H.el(
            "span",
            { className: "header-meta" },
            " · " + countText +
              " · " + groups.length +
              " skupin · " + windowDeep + " DEEP"
          )
        )
      ),
      H.el("div", { className: "groups" }, ...groupNodes)
    );

    windowNodes.push(windowNode);
  }

  H.replace(
    app,
    ...(windowNodes.length
      ? windowNodes
      : [
          H.el(
            "div",
            { className: "empty panel-empty" },
            "Žádné panely neodpovídají aktuálnímu filtru."
          )
        ])
  );

  updatePanelFilterUi(
    allTabs,
    filtering ? visibleTabCount : allTabs.length
  );
}

async function load() {
  panelExplorer.captureOpenState();
  app.textContent = "Načítám…";

  const stored = await browser.storage.local.get([TAB_LIFECYCLE_KEY, HOST_STATS_KEY, URL_POLICIES_KEY, HOST_POLICIES_KEY, WORKSPACES_KEY, ACTIVE_WORKSPACE_KEY, WORKSPACE_DEBUG_KEY]);
  lifecycleMap = stored[TAB_LIFECYCLE_KEY] ?? {};
  hostStats = stored[HOST_STATS_KEY] ?? {};
  urlPolicies = Array.isArray(stored[URL_POLICIES_KEY]) ? stored[URL_POLICIES_KEY] : [];
  hostPolicies = stored[HOST_POLICIES_KEY] ?? {};
  workspaces = stored[WORKSPACES_KEY] ?? {};
  activeWorkspaceId = stored[ACTIVE_WORKSPACE_KEY] ?? null;
  workspaceDebugLog = Array.isArray(stored[WORKSPACE_DEBUG_KEY]) ? stored[WORKSPACE_DEBUG_KEY] : [];
  renderUrlPolicies();
  renderWorkspaces();

  currentWindows = await browser.windows.getAll({ populate: true, windowTypes: ["normal"] });
  currentWindowGroups = new Map();

  for (const win of currentWindows) {
    currentWindowGroups.set(win.id, await browser.tabGroups.query({ windowId: win.id }));
  }

  const allTabs = currentWindows.flatMap(win => win.tabs ?? []);
  const deepTabs = allTabs.filter(tab => tab.discarded).length;
  const activeTabs = allTabs.filter(tab => tab.active).length;
  const loadedTabs = allTabs.filter(tab => !tab.discarded).length;

  summary.textContent = `${currentWindows.length} oken · ${allTabs.length} panelů · ${loadedTabs} loaded · ${deepTabs} deep · ${activeTabs} active`;
  renderPanels();

  currentOpenHosts = [...new Set(
    allTabs.map(tab => hostnameFromUrl(tab.url)).filter(Boolean)
  )].sort();

  await updateKnownHosts(currentOpenHosts);
  await renderHostPolicies();
}


function renderUrlPolicies() {
  const rules = urlPolicies
    .slice()
    .filter(rule => rule?.url)
    .sort((a, b) => b.url.length - a.url.length);

  if (!rules.length) {
    H.replace(
      urlPoliciesEl,
      H.el("div", { className: "empty" }, "Žádné URL výjimky.")
    );
    return;
  }

  const nodes = rules.map(rule => H.el(
    "div",
    { className: "url-rule" },
    H.el("strong", {}, rule.mode || "KEEP"),
    H.el("code", { title: rule.url }, rule.url),
    H.el(
      "button",
      {
        type: "button",
        dataset: { removeUrlRule: rule.url }
      },
      "Smazat"
    )
  ));

  H.replace(urlPoliciesEl, ...nodes);
}

async function saveUrlPolicies() {
  await browser.storage.local.set({ [URL_POLICIES_KEY]: urlPolicies });
  renderUrlPolicies();
}

async function setPage(page) {
  document.querySelectorAll(".page-tab").forEach(button => {
    button.classList.toggle("active", button.dataset.page === page);
  });
  document.getElementById("panelsPage").classList.toggle("active", page === "panels");
  document.getElementById("workspacesPage").classList.toggle("active", page === "workspaces");
  document.getElementById("settingsPage").classList.toggle("active", page === "settings");
  document.getElementById("helpPage").classList.toggle("active", page === "help");
  await browser.storage.local.set({ [UI_PAGE_KEY]: page });
}

document.querySelector(".page-tabs").addEventListener("click", event => {
  const button = event.target.closest(".page-tab");
  if (button) setPage(button.dataset.page).catch(console.error);
});

// Manager event wiring ---------------------------------------------------------
panelSearch.addEventListener("input", () => renderPanels());

panelExpandAll.addEventListener("click", () => {
  panelExplorer.expandAll(currentWindows, currentWindowGroups);
  renderPanels();
});

panelCollapseAll.addEventListener("click", () => {
  panelExplorer.collapseAll();
  renderPanels();
});

panelAlwaysExpanded.addEventListener("change", () => {
  panelExplorer.setAlwaysExpanded(panelAlwaysExpanded.checked);
  renderPanels();
});

panelAutoRefresh.addEventListener("change", () => {
  panelExplorer.setRefreshSeconds(Number(panelAutoRefresh.value) || 0);
});

function togglePanelFilter(button) {
  const targetSet = button.dataset.panelFilterCategory === "state"
    ? panelStateFilterSet
    : panelPolicyFilterSet;
  const value = button.dataset.panelFilter;
  if (targetSet.has(value)) targetSet.delete(value);
  else targetSet.add(value);
  renderPanels();
}

panelStateFilters.addEventListener("click", event => {
  const button = event.target.closest(".panel-filter");
  if (button) togglePanelFilter(button);
});

panelPolicyFilters.addEventListener("click", event => {
  const button = event.target.closest(".panel-filter");
  if (button) togglePanelFilter(button);
});

panelFilterReset.addEventListener("click", () => {
  panelSearch.value = "";
  panelStateFilterSet.clear();
  panelPolicyFilterSet.clear();
  renderPanels();
  panelSearch.focus();
});

app.addEventListener("toggle", event => {
  panelExplorer.rememberToggle(event);
}, true);

app.addEventListener("click", async event => {
  const exceptButton = event.target.closest('button[data-action="except"]');
  if (exceptButton) {
    const tabId = Number(exceptButton.dataset.tabId);
    let tab;
    try {
      tab = await browser.tabs.get(tabId);
    } catch {
      return;
    }

    const url = tab.url ?? "";
    if (!/^https?:\/\//i.test(url)) return;

    const exists = urlPolicies.some(rule => rule?.mode === "KEEP" && rule?.url === url);
    const question = exists
      ? "Opravdu vyjmout tuto přesnou URL z výjimek?\n\n" + url
      : "Opravdu vložit tuto přesnou URL do výjimek?\n\n" + url;

    if (!confirm(question)) return;

    urlPolicies = urlPolicies.filter(rule => rule.url !== url);
    if (!exists) urlPolicies.push({ url, mode: "KEEP" });
    await saveUrlPolicies();
    await load();
    return;
  }

  const tabButton = event.target.closest('button[data-action="deep"]');
  if (tabButton) {
    const tabId = Number(tabButton.dataset.tabId);
    const tab = await browser.tabs.get(tabId);
    if (isProtectedFromDeep(tab)) return;
    tabButton.disabled = true;
    try { await browser.tabs.discard(tabId); }
    catch (error) { console.error("DEEP discard failed", error); }
    await load();
    return;
  }

  const groupButton = event.target.closest('button[data-action="deep-group"]');
  if (groupButton) {
    event.preventDefault();
    event.stopPropagation();
    const groupId = Number(groupButton.dataset.groupId);
    groupButton.disabled = true;
    try {
      const tabs = await browser.tabs.query({ groupId });
      for (const tab of tabs) {
        if (isProtectedFromDeep(tab)) continue;
        try { await browser.tabs.discard(tab.id); }
        catch (error) { console.warn("Group DEEP skipped tab", tab.id, error); }
      }
    } finally {
      groupButton.disabled = false;
      await load();
    }
  }
});

deepAllButton.addEventListener("click", async () => {
  deepAllButton.disabled = true;
  try {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (isProtectedFromDeep(tab)) continue;
      try { await browser.tabs.discard(tab.id); }
      catch (error) { console.warn("Bulk DEEP skipped tab", tab.id, error); }
    }
  } finally {
    deepAllButton.disabled = false;
    await load();
  }
});

refreshButton.addEventListener("click", () => load().catch(console.error));

closeButton.addEventListener("click", async () => {
  if (lastActiveContentTabId != null) {
    try {
      const lastTab = await browser.tabs.get(lastActiveContentTabId);
      if (lastTab.windowId === managerWindowId) {
        await browser.tabs.update(lastActiveContentTabId, { active: true });
      }
    } catch {
      lastActiveContentTabId = null;
    }
  }

  if (managerTabId != null) {
    await browser.tabs.remove(managerTabId);
  }
});

hostPoliciesEl.addEventListener("change", async event => {
  const select = event.target.closest("select[data-host-policy]");
  if (!select) return;
  await saveHostPolicy(select.dataset.hostPolicy, select.value);
});


workspaceListEl.addEventListener("click", async event => {
  const copyButton = event.target.closest("button[data-copy-workspace-log]");
  if (copyButton) {
    event.preventDefault();
    event.stopPropagation();
    const workspace = workspaces[copyButton.dataset.copyWorkspaceLog];
    if (!workspace) return;

    const text = workspaceDebugText(workspace);
    try {
      await navigator.clipboard.writeText(text);
      const oldText = copyButton.textContent;
      copyButton.textContent = "Copied";
      setTimeout(() => {
        copyButton.textContent = oldText;
      }, 1200);
    } catch (error) {
      console.error("Copy debug log failed", error);
      alert("Kopírování logu selhalo: " + (error?.message ?? error));
    }
    return;
  }

  const windowButton = event.target.closest("button[data-workspace-window-action]");
  if (windowButton) {
    const workspaceId = windowButton.dataset.workspaceId;
    const logicalWindowId = windowButton.dataset.logicalWindowId;
    if (windowButton.dataset.workspaceWindowAction === "remove") {
      if (!confirm("Vyřadit toto uložené okno z workspace?\n\nAktuálně otevřené Firefox okno se nezavře.")) return;
      await browser.runtime.sendMessage({
        type: "removeWorkspaceWindow",
        workspaceId,
        logicalWindowId
      });
      await load();
    }
    return;
  }

  const button = event.target.closest("button[data-workspace-action]");
  if (!button) return;

  const workspaceId = button.dataset.workspaceId;
  const workspace = workspaces[workspaceId];
  if (!workspace) return;

  if (button.dataset.workspaceAction === "details") {
    expandedWorkspaceId = expandedWorkspaceId === workspaceId ? null : workspaceId;
    renderWorkspaces();
    return;
  }

  if (button.dataset.workspaceAction === "export") {
    const payload = await browser.runtime.sendMessage({
      type: "exportWorkspace",
      workspaceId
    });
    downloadJson(
      payload,
      backupTimestamp() + "_" +
        safeFilenamePart(workspace.name || "workspace") +
        ".json"
    );
    return;
  }

  if (button.dataset.workspaceAction === "switch") {
    const hasActiveWorkspace =
      !!activeWorkspaceId &&
      !!workspaces[activeWorkspaceId] &&
      activeWorkspaceId !== workspaceId;

    const message = hasActiveWorkspace
      ? (
          "Přepnout na workspace \"" + (workspace.name || "Workspace") +
          "\"?\n\nAktuální stav se uloží a okna současného workspace se zavřou."
        )
      : (
          "Obnovit session workspace \"" + (workspace.name || "Workspace") +
          "\"?\n\nOtevřou se jeho uložená okna, skupiny a panely."
        );

    if (!confirm(message)) return;

    button.disabled = true;
    await browser.runtime.sendMessage({
      type: hasActiveWorkspace ? "switchWorkspace" : "restoreWorkspace",
      workspaceId
    });
    return;
  }

  if (button.dataset.workspaceAction === "rename") {
    const name = prompt("Název workspace:", workspace.name || "Workspace");
    if (name == null || !name.trim()) return;
    await browser.runtime.sendMessage({ type: "renameWorkspace", workspaceId, name: name.trim() });
    await load();
    return;
  }

  if (button.dataset.workspaceAction === "delete") {
    const active = workspaceId === activeWorkspaceId;
    const message = active
      ? "Smazat aktivní workspace \"" + (workspace.name || "Workspace") + "\"?\n\nOtevřená okna zůstanou a budou převedena do nového workspace."
      : "Opravdu smazat workspace \"" + (workspace.name || "Workspace") + "\"?";
    if (!confirm(message)) return;
    await browser.runtime.sendMessage({ type: "deleteWorkspace", workspaceId });
    await load();
  }
});


importWorkspaceButton.addEventListener("click", () => {
  importWorkspaceFile.click();
});

importWorkspaceFile.addEventListener("change", async () => {
  const file = importWorkspaceFile.files?.[0];
  if (!file) return;

  try {
    const payload = JSON.parse(await file.text());
    const names = resolveImportNames([payload]);
    if (!names) return;

    await browser.runtime.sendMessage({
      type: "importWorkspace",
      payload,
      name: names[0],
      sourceName: file.name
    });

    await load();
  } catch (error) {
    console.error("Workspace import failed", error);
    alert("Import workspace selhal: " + (error?.message ?? error));
  } finally {
    importWorkspaceFile.value = "";
  }
});

backupWorkspacesButton.addEventListener("click", async () => {
  backupWorkspacesButton.disabled = true;

  try {
    const payload = await browser.runtime.sendMessage({
      type: "exportWorkspaceCollection"
    });

    downloadJson(
      payload,
      backupTimestamp() + "_workspaces.json"
    );
  } catch (error) {
    console.error("Workspace collection backup failed", error);
    alert("Backup workspaces selhal: " + (error?.message ?? error));
  } finally {
    backupWorkspacesButton.disabled = false;
  }
});

restoreWorkspacesButton.addEventListener("click", () => {
  restoreWorkspacesFile.click();
});

restoreWorkspacesFile.addEventListener("change", async () => {
  const file = restoreWorkspacesFile.files?.[0];
  if (!file) return;

  try {
    const payload = JSON.parse(await file.text());

    if (
      payload?.format !== "firefox-workspace-manager.workspaces" ||
      Number(payload?.version) !== 1 ||
      !Array.isArray(payload?.workspaces)
    ) {
      throw new Error("Soubor není workspace collection backup");
    }

    const names = resolveImportNames(payload.workspaces);
    if (!names) return;

    if (
      !confirm(
        "Importovat " + payload.workspaces.length +
        " workspace z backupu?\n\n" +
        "Existující workspace zůstanou beze změny."
      )
    ) {
      return;
    }

    restoreWorkspacesButton.disabled = true;

    const result = await browser.runtime.sendMessage({
      type: "importWorkspaceCollection",
      payload,
      names,
      sourceName: file.name
    });

    await load();
    alert("Importováno workspace: " + (result?.imported ?? 0));
  } catch (error) {
    console.error("Workspace collection restore failed", error);
    alert("Restore workspaces selhal: " + (error?.message ?? error));
  } finally {
    restoreWorkspacesButton.disabled = false;
    restoreWorkspacesFile.value = "";
  }
});

snapshotWorkspaceButton.addEventListener("click", async () => {
  snapshotWorkspaceButton.disabled = true;
  try {
    await browser.runtime.sendMessage({ type: "snapshotWorkspace" });
    await load();
  } finally {
    snapshotWorkspaceButton.disabled = false;
  }
});

cloneWorkspaceButton.addEventListener("click", async () => {
  const defaultName = "Workspace " + (Object.keys(workspaces ?? {}).length + 1);
  const name = prompt("Název nového workspace z aktuálního stavu Firefoxu:", defaultName);
  if (name == null || !name.trim()) return;

  cloneWorkspaceButton.disabled = true;
  try {
    const result = await browser.runtime.sendMessage({
      type: "createWorkspaceFromCurrentState",
      name: name.trim()
    });

    if (!result?.workspaceId || !result?.active || result.windows < 1 || result.tabs < 1) {
      throw new Error("Nový workspace se nepodařilo ověřit");
    }

    expandedWorkspaceId = result.workspaceId;
    await load();
  } catch (error) {
    console.error("Create workspace from current state failed", error);
    alert("Uložení aktuálního stavu jako nového workspace selhalo: " + (error?.message ?? error));
  } finally {
    cloneWorkspaceButton.disabled = false;
  }
});

hostFilter.addEventListener("input", () => renderHostPolicies().catch(console.error));
syncEnabled.addEventListener("change", () => saveSyncSetting().catch(console.error));

useLastPage.addEventListener("click", async () => {
  if (lastActiveContentTabId == null) return;
  try {
    const tab = await browser.tabs.get(lastActiveContentTabId);
    if (/^https?:\/\//i.test(tab.url ?? "")) urlPattern.value = tab.url;
  } catch {}
});

addUrlKeep.addEventListener("click", async () => {
  const url = urlPattern.value.trim();
  if (!/^https?:\/\//i.test(url)) return;

  if (!confirm("Opravdu vložit tuto přesnou URL do výjimek?\n\n" + url)) return;

  urlPolicies = urlPolicies.filter(rule => rule.url !== url);
  urlPolicies.push({ url, mode: "KEEP" });
  await saveUrlPolicies();
  urlPattern.value = "";
  await load();
});

urlPoliciesEl.addEventListener("click", async event => {
  const button = event.target.closest("button[data-remove-url-rule]");
  if (!button) return;
  urlPolicies = urlPolicies.filter(rule => rule.url !== button.dataset.removeUrlRule);
  await saveUrlPolicies();
});
[autoMinutes, autoDeepOnLeave, autoProtectPinned, autoProtectAudible].forEach(el => {
  el.addEventListener("change", () => saveAutoSettings().catch(console.error));
});

browser.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if ("discarded" in changeInfo || "status" in changeInfo || "audible" in changeInfo || "pinned" in changeInfo || "url" in changeInfo) {
    load().catch(console.error);
  }
});
browser.tabs.onActivated.addListener(() => load().catch(console.error));
browser.tabs.onCreated.addListener(() => load().catch(console.error));
browser.tabs.onRemoved.addListener(tabId => {
  if (tabId !== managerTabId) load().catch(console.error);
});
browser.tabGroups.onCreated.addListener(() => load().catch(console.error));
browser.tabGroups.onUpdated.addListener(() => load().catch(console.error));
browser.tabGroups.onRemoved.addListener(() => load().catch(console.error));

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[TAB_LIFECYCLE_KEY] || changes[HOST_STATS_KEY] || changes[URL_POLICIES_KEY] || changes[HOST_POLICIES_KEY] || changes[WORKSPACES_KEY] || changes[ACTIVE_WORKSPACE_KEY] || changes[WORKSPACE_DEBUG_KEY]) {
    load().catch(console.error);
  }
});

setInterval(() => {
  document.querySelectorAll(".countdown[data-deadline]").forEach(el => {
    const deadline = Number(el.dataset.deadline);
    el.textContent = deadline > Date.now()
      ? "DEEP za " + formatRemaining(deadline)
      : "DEEP…";
  });
}, 1000);

(async () => {
  const current = await browser.tabs.getCurrent();
  managerTabId = current?.id ?? null;
  managerWindowId = current?.windowId ?? null;

  if (managerWindowId != null) {
    const stored = await browser.storage.local.get(LAST_ACTIVE_CONTENT_KEY);
    const candidate = stored[LAST_ACTIVE_CONTENT_KEY]?.[String(managerWindowId)] ?? null;
    if (candidate != null && candidate !== managerTabId) {
      try {
        const tab = await browser.tabs.get(candidate);
        if (tab.windowId === managerWindowId && /^https?:\/\//i.test(tab.url ?? "")) {
          lastActiveContentTabId = candidate;
        }
      } catch {
        lastActiveContentTabId = null;
      }
    }
  }

  const uiState = await browser.storage.local.get(UI_PAGE_KEY);
  await setPage(["panels", "workspaces", "settings", "help"].includes(uiState[UI_PAGE_KEY]) ? uiState[UI_PAGE_KEY] : "panels");
  await loadSyncSetting();
  await loadAutoSettings();
  await load();
})().catch(error => {
  console.error(error);
  app.textContent = "Chyba při načítání. Podrobnosti jsou v konzoli rozšíření.";
});
