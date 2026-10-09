// @ts-check

import {
  ACTIVE_WORKSPACE_KEY,
  HOST_POLICIES_KEY,
  LAST_WORKSPACE_KEY,
  TAB_LIFECYCLE_KEY,
  URL_POLICIES_KEY,
  WORKSPACES_KEY
} from "../shared/constants.js";
import { hostnameFromUrl, isExtensionUrl } from "../shared/url.js";
import { H } from "../shared/H.js";

const stats = document.getElementById("stats");
const refreshButton = document.getElementById("refresh");
const deepAllButton = document.getElementById("deepAll");
const openManagerButton = document.getElementById("openManager");
const versionEl = document.getElementById("version");
const workspaceTitleEl = document.getElementById("workspaceTitle");
const workspaceSubtitleEl = document.getElementById("workspaceSubtitle");
const recoverSessionButton = document.getElementById("recoverSession");

let recoveryWorkspaceId = null;

function mostRecentlyUsedWorkspace(workspaces) {
  return Object.values(workspaces ?? {})
    .filter(workspace => workspace && Object.keys(workspace.windows ?? {}).length)
    .sort((a, b) => {
      const aTime = Number(a.restoredAt ?? a.updatedAt ?? a.closedAt ?? a.createdAt ?? 0);
      const bTime = Number(b.restoredAt ?? b.updatedAt ?? b.closedAt ?? b.createdAt ?? 0);
      return bTime - aTime;
    })[0] ?? null;
}

function isInternalExtensionTab(tab) {
  return isExtensionUrl(tab?.url);
}

function exactUrlException(tab, urlPolicies) {
  return urlPolicies.some(rule => rule?.mode === "KEEP" && rule?.url === (tab?.url ?? ""));
}

function effectivePolicy(tab, hostPolicies, urlPolicies) {
  if (exactUrlException(tab, urlPolicies)) return "EXCEPT";
  const host = hostnameFromUrl(tab.url);
  return host ? (hostPolicies[host] ?? "AUTO") : "AUTO";
}

async function load() {
  const [windows, stored] = await Promise.all([
    browser.windows.getAll({ populate: true, windowTypes: ["normal"] }),
    browser.storage.local.get([HOST_POLICIES_KEY, URL_POLICIES_KEY, TAB_LIFECYCLE_KEY, WORKSPACES_KEY, ACTIVE_WORKSPACE_KEY, LAST_WORKSPACE_KEY])
  ]);

  const hostPolicies = stored[HOST_POLICIES_KEY] ?? {};
  const urlPolicies = Array.isArray(stored[URL_POLICIES_KEY]) ? stored[URL_POLICIES_KEY] : [];
  const lifecycle = stored[TAB_LIFECYCLE_KEY] ?? {};
  const workspaces = stored[WORKSPACES_KEY] ?? {};
  const activeWorkspaceId = stored[ACTIVE_WORKSPACE_KEY] ?? null;
  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null;

  const storedLastWorkspaceId = stored[LAST_WORKSPACE_KEY] ?? null;
  const explicitLastCandidate = storedLastWorkspaceId
    ? workspaces[storedLastWorkspaceId]
    : null;
  const explicitLastWorkspace =
    explicitLastCandidate &&
    Object.keys(explicitLastCandidate.windows ?? {}).length
      ? explicitLastCandidate
      : null;
  const fallbackLastWorkspace =
    explicitLastWorkspace || mostRecentlyUsedWorkspace(workspaces);

  recoveryWorkspaceId = null;

  if (activeWorkspace) {
    workspaceTitleEl.textContent = activeWorkspace.name || "Workspace";
    workspaceSubtitleEl.textContent = "Aktivní workspace";
    recoverSessionButton.hidden = true;
  } else if (fallbackLastWorkspace) {
    workspaceTitleEl.textContent = fallbackLastWorkspace.name || "Workspace";
    workspaceSubtitleEl.textContent = "Naposledy použitý · neaktivní";
    recoveryWorkspaceId = fallbackLastWorkspace.id;
    recoverSessionButton.hidden = false;
  } else {
    workspaceTitleEl.textContent = "Žádný workspace";
    workspaceSubtitleEl.textContent = "Workspace Manager";
    recoverSessionButton.hidden = true;
  }

  const tabs = windows.flatMap(win => win.tabs ?? []);

  let loaded = 0;
  let deep = 0;
  let active = 0;
  let autoPending = 0;
  let deepAlways = 0;
  let keepAlways = 0;
  let except = 0;

  for (const tab of tabs) {
    tab.discarded ? deep++ : loaded++;
    if (tab.active) active++;

    const policy = effectivePolicy(tab, hostPolicies, urlPolicies);
    if (policy === "EXCEPT") except++;
    else if (policy === "DEEP") deepAlways++;
    else if (policy === "KEEP") keepAlways++;
    else if (lifecycle[String(tab.id)]?.deadline && !tab.discarded) autoPending++;
  }

  const groupLists = await Promise.all(
    windows.map(win => browser.tabGroups.query({ windowId: win.id }))
  );
  const groups = groupLists.reduce((sum, list) => sum + list.length, 0);

  const statItems = [
    [windows.length, "oken"],
    [tabs.length, "panelů"],
    [groups, "skupin"],
    [active, "aktivní"],
    [loaded, "loaded"],
    [deep, "deep"],
    [autoPending, "AUTO čeká"],
    [deepAlways, "DEEP always"],
    [keepAlways, "KEEP always"],
    [except, "URL výjimky"]
  ];

  H.replace(
    stats,
    ...statItems.map(([value, label]) => H.el(
      "div",
      { className: "stat" },
      H.el("strong", {}, value),
      H.el("span", {}, label)
    ))
  );
}

deepAllButton.addEventListener("click", async () => {
  deepAllButton.disabled = true;
  try {
    const stored = await browser.storage.local.get([HOST_POLICIES_KEY, URL_POLICIES_KEY]);
    const hostPolicies = stored[HOST_POLICIES_KEY] ?? {};
    const urlPolicies = Array.isArray(stored[URL_POLICIES_KEY]) ? stored[URL_POLICIES_KEY] : [];
    const tabs = await browser.tabs.query({});

    for (const tab of tabs) {
      const policy = effectivePolicy(tab, hostPolicies, urlPolicies);
      if (
        tab.id == null ||
        tab.active ||
        tab.discarded ||
        tab.audible ||
        tab.pinned ||
        isInternalExtensionTab(tab) ||
        policy === "EXCEPT" ||
        policy === "KEEP"
      ) continue;

      try {
        await browser.tabs.discard(tab.id);
      } catch (error) {
        console.warn("Popup DEEP ALL skipped tab", tab.id, error);
      }
    }
  } finally {
    deepAllButton.disabled = false;
    await load();
  }
});

recoverSessionButton.addEventListener("click", async () => {
  if (!recoveryWorkspaceId) return;

  recoverSessionButton.disabled = true;
  const originalText = recoverSessionButton.textContent;
  recoverSessionButton.textContent = "Obnovuji…";

  try {
    const preview = await browser.runtime.sendMessage({
      type: "previewWorkspaceRecovery",
      workspaceId: recoveryWorkspaceId
    });
    const duplicateRisk =
      !!preview?.pendingApplicationRestore && preview.liveContentWindows > 0;

    if (duplicateRisk && !confirm(
      "POZOR: Obsah otevřených oken se liší od obnovené zálohy.\n\n" +
      "Recover vytvoří dalších " + preview.restoreWindowCount +
      " oken vedle " + preview.liveContentWindows +
      " existujících. Mohou vzniknout duplicity.\n\n" +
      "Vytvořit nová okna?"
    )) {
      recoverSessionButton.textContent = originalText;
      recoverSessionButton.disabled = false;
      return;
    }

    const result = await browser.runtime.sendMessage({
      type: "restoreWorkspace",
      workspaceId: recoveryWorkspaceId,
      allowAdditionalWindows: duplicateRisk
    });

    if (!result?.windowIds?.length) {
      throw new Error("Workspace recovery nevytvořilo žádné okno");
    }

    await load();
    window.close();
  } catch (error) {
    console.error("Popup workspace recovery failed", error);
    recoverSessionButton.textContent = "Recovery selhalo";
    setTimeout(() => {
      recoverSessionButton.textContent = originalText;
      recoverSessionButton.disabled = false;
    }, 1600);
  }
});

openManagerButton.addEventListener("click", async () => {
  const url = browser.runtime.getURL("src/manager/manager.html");
  const existing = await browser.tabs.query({ url });
  if (existing.length) {
    await browser.tabs.update(existing[0].id, { active: true });
    await browser.windows.update(existing[0].windowId, { focused: true });
  } else {
    await browser.tabs.create({ url });
  }
  window.close();
});

refreshButton.addEventListener("click", () => load().catch(console.error));
load().catch(error => {
  console.error(error);
  stats.textContent = "Chyba při načítání.";
});

versionEl.textContent = "v" + browser.runtime.getManifest().version;
