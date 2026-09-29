const stats = document.getElementById("stats");
const refreshButton = document.getElementById("refresh");
const deepAllButton = document.getElementById("deepAll");
const openManagerButton = document.getElementById("openManager");
const versionEl = document.getElementById("version");

const HOST_POLICIES_KEY = "fwm.hostPolicies";
const URL_POLICIES_KEY = "fwm.urlPolicies";
const TAB_LIFECYCLE_KEY = "fwm.tabLifecycle";

function isInternalExtensionTab(tab) {
  return /^(moz|chrome)-extension:\/\//i.test(tab?.url ?? "");
}

function hostnameFromUrl(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
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
    browser.storage.local.get([HOST_POLICIES_KEY, URL_POLICIES_KEY, TAB_LIFECYCLE_KEY])
  ]);

  const hostPolicies = stored[HOST_POLICIES_KEY] ?? {};
  const urlPolicies = Array.isArray(stored[URL_POLICIES_KEY]) ? stored[URL_POLICIES_KEY] : [];
  const lifecycle = stored[TAB_LIFECYCLE_KEY] ?? {};
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

  stats.innerHTML = `
    <div class="stat"><strong>${windows.length}</strong><span>oken</span></div>
    <div class="stat"><strong>${tabs.length}</strong><span>panelů</span></div>
    <div class="stat"><strong>${groups}</strong><span>skupin</span></div>
    <div class="stat"><strong>${active}</strong><span>aktivní</span></div>
    <div class="stat"><strong>${loaded}</strong><span>loaded</span></div>
    <div class="stat"><strong>${deep}</strong><span>deep</span></div>
    <div class="stat"><strong>${autoPending}</strong><span>AUTO čeká</span></div>
    <div class="stat"><strong>${deepAlways}</strong><span>DEEP always</span></div>
    <div class="stat"><strong>${keepAlways}</strong><span>KEEP always</span></div>
    <div class="stat"><strong>${except}</strong><span>URL výjimky</span></div>
  `;
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
