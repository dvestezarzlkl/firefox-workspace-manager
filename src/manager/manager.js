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

const HOST_POLICIES_KEY = "fwm.hostPolicies";
const KNOWN_HOSTS_KEY = "fwm.knownHosts";
const AUTO_SETTINGS_KEY = "fwm.autoSettings";
const UI_PAGE_KEY = "fwm.ui.page";
const HOST_RESULT_LIMIT = 30;

let managerTabId = null;
let currentOpenHosts = [];
let knownHosts = [];
let currentWindows = [];

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stateBadge(tab) {
  if (tab.active) return '<span class="state state-active" title="Aktivní">●</span>';
  if (tab.discarded) return '<span class="state state-deep" title="DEEP / uvolněno z paměti">○</span>';
  return '<span class="state state-loaded" title="Načteno v paměti">✓</span>';
}

function extraFlags(tab) {
  const flags = [];
  if (tab.audible) flags.push("🔊");
  if (tab.pinned) flags.push("📌");
  if (tab.autoDiscardable === false) flags.push("⏻");
  return flags;
}

function isInternalExtensionTab(tab) {
  const url = tab?.url ?? "";
  return url.startsWith("moz-extension://") || url.startsWith("chrome-extension://");
}

function isProtectedFromDeep(tab) {
  return tab.id == null ||
    tab.id === managerTabId ||
    tab.active ||
    tab.discarded ||
    tab.audible ||
    tab.pinned ||
    isInternalExtensionTab(tab);
}

function hostnameFromUrl(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
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
      minutes: Math.max(1, Math.min(10080, Number(autoMinutes.value) || 60)),
      deepOnLeave: autoDeepOnLeave.checked,
      protectPinned: autoProtectPinned.checked,
      protectAudible: autoProtectAudible.checked
    }
  });
}

function renderTab(tab) {
  const disabled = isProtectedFromDeep(tab);
  return `
    <div class="tab" data-tab-id="${tab.id}">
      <div class="tab-main">
        <div class="tab-title" title="${esc(tab.url)}">${esc(tab.title || tab.url || "(bez názvu)")}</div>
        <div class="meta">
          ${stateBadge(tab)}
          <span>#${tab.id}</span>
          <span class="flags" title="Další stavové příznaky">${esc(extraFlags(tab).join(" "))}</span>
        </div>
      </div>
      <button type="button" data-action="deep" data-tab-id="${tab.id}" ${disabled ? "disabled" : ""}>DEEP</button>
    </div>`;
}

async function renderHostPolicies() {
  const policies = await loadHostPolicies();
  const filter = hostFilter.value.trim().toLowerCase();

  const baseHosts = filter
    ? [...new Set([...knownHosts, ...Object.keys(policies), ...currentOpenHosts])]
        .filter(host => host.includes(filter))
    : currentOpenHosts;

  const hosts = baseHosts.slice(0, HOST_RESULT_LIMIT);

  hostPoliciesEl.innerHTML = hosts.length ? `
    <div class="policy-grid">
      ${hosts.map(host => {
        const mode = policies[host] ?? "AUTO";
        return `
          <label class="policy-row">
            <span class="policy-host" title="${esc(host)}">${esc(host)}</span>
            <select data-host-policy="${esc(host)}">
              <option value="AUTO" ${mode === "AUTO" ? "selected" : ""}>AUTO</option>
              <option value="KEEP" ${mode === "KEEP" ? "selected" : ""}>KEEP</option>
              <option value="DEEP" ${mode === "DEEP" ? "selected" : ""}>DEEP</option>
            </select>
          </label>`;
      }).join("")}
    </div>` : '<div class="empty">Nic nenalezeno.</div>';

  const total = baseHosts.length;
  hostResultInfo.textContent = filter
    ? `Nalezeno ${total}; zobrazeno max. ${Math.min(total, HOST_RESULT_LIMIT)}.`
    : `Zobrazeny pouze hostname z aktuálně otevřených panelů; max. ${HOST_RESULT_LIMIT}.`;
}

async function load() {
  app.textContent = "Načítám…";
  currentWindows = await browser.windows.getAll({ populate: true, windowTypes: ["normal"] });

  let totalTabs = 0;
  let deepTabs = 0;
  let loadedTabs = 0;
  let activeTabs = 0;
  const chunks = [];

  for (const win of currentWindows) {
    const groups = await browser.tabGroups.query({ windowId: win.id });
    const tabs = win.tabs ?? [];
    totalTabs += tabs.length;
    deepTabs += tabs.filter(tab => tab.discarded).length;
    activeTabs += tabs.filter(tab => tab.active).length;
    loadedTabs += tabs.filter(tab => !tab.discarded).length;

    const groupedIds = new Set();
    const groupHtml = groups.map(group => {
      const groupTabs = tabs.filter(tab => tab.groupId === group.id);
      groupTabs.forEach(tab => groupedIds.add(tab.id));
      const groupDeep = groupTabs.filter(tab => tab.discarded).length;
      return `
        <section class="group">
          <div class="group-header">
            <h3>${esc(group.title || "(skupina bez názvu)")} · ${groupTabs.length} tabů · ${groupDeep} DEEP · ${esc(group.color)}</h3>
            <button type="button" data-action="deep-group" data-group-id="${group.id}">DEEP skupinu</button>
          </div>
          ${groupTabs.length ? groupTabs.map(renderTab).join("") : '<div class="empty">Prázdná skupina</div>'}
        </section>`;
    }).join("");

    const ungrouped = tabs.filter(tab => !groupedIds.has(tab.id));
    const ungroupedHtml = ungrouped.length ? `
      <section class="group">
        <div class="group-header">
          <h3>Bez skupiny · ${ungrouped.length} tabů · ${ungrouped.filter(tab => tab.discarded).length} DEEP</h3>
        </div>
        ${ungrouped.map(renderTab).join("")}
      </section>` : "";

    chunks.push(`
      <section class="window">
        <h2>Okno #${win.id} · ${tabs.length} tabů · ${groups.length} skupin</h2>
        <div class="groups">${groupHtml}${ungroupedHtml}</div>
      </section>`);
  }

  summary.textContent = `${currentWindows.length} oken · ${totalTabs} tabů · ${loadedTabs} loaded · ${deepTabs} deep · ${activeTabs} active`;
  app.innerHTML = chunks.length ? chunks.join("") : '<div class="empty">Žádné normální Firefox okno.</div>';

  currentOpenHosts = [...new Set(
    currentWindows.flatMap(win => (win.tabs ?? []).map(tab => hostnameFromUrl(tab.url)).filter(Boolean))
  )].sort();

  await updateKnownHosts(currentOpenHosts);
  await renderHostPolicies();
}

async function setPage(page) {
  document.querySelectorAll(".page-tab").forEach(button => {
    button.classList.toggle("active", button.dataset.page === page);
  });
  document.getElementById("panelsPage").classList.toggle("active", page === "panels");
  document.getElementById("settingsPage").classList.toggle("active", page === "settings");
  await browser.storage.local.set({ [UI_PAGE_KEY]: page });
}

document.querySelector(".page-tabs").addEventListener("click", event => {
  const button = event.target.closest(".page-tab");
  if (button) setPage(button.dataset.page).catch(console.error);
});

app.addEventListener("click", async event => {
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
  if (managerTabId != null) await browser.tabs.remove(managerTabId);
});

hostPoliciesEl.addEventListener("change", async event => {
  const select = event.target.closest("select[data-host-policy]");
  if (!select) return;
  await saveHostPolicy(select.dataset.hostPolicy, select.value);
});

hostFilter.addEventListener("input", () => renderHostPolicies().catch(console.error));
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

(async () => {
  const current = await browser.tabs.getCurrent();
  managerTabId = current?.id ?? null;

  const uiState = await browser.storage.local.get(UI_PAGE_KEY);
  await setPage(uiState[UI_PAGE_KEY] === "settings" ? "settings" : "panels");
  await loadAutoSettings();
  await load();
})().catch(error => {
  console.error(error);
  app.textContent = "Chyba při načítání. Podrobnosti jsou v konzoli rozšíření.";
});
