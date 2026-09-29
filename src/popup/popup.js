const app = document.getElementById("app");
const refreshButton = document.getElementById("refresh");
const deepAllButton = document.getElementById("deepAll");
const openManagerButton = document.getElementById("openManager");

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function flags(tab) {
  const out = [];
  if (tab.active) out.push("active");
  if (tab.discarded) out.push("discarded");
  if (tab.audible) out.push("audible");
  if (tab.pinned) out.push("pinned");
  return out;
}

function renderTab(tab) {
  const tabFlags = flags(tab);
  const disabled = tab.active || tab.discarded;
  return `
    <div class="tab" data-tab-id="${tab.id}">
      <div>
        <div class="tab-title" title="${esc(tab.url)}">${esc(tab.title || tab.url || "(bez názvu)")}</div>
        <div class="meta">
          #${tab.id}
          ${tabFlags.map(flag => `<span class="badge">${esc(flag)}</span>`).join("")}
        </div>
      </div>
      <button class="deep" type="button" data-action="deep" data-tab-id="${tab.id}" ${disabled ? "disabled" : ""}>
        DEEP
      </button>
    </div>`;
}

async function load() {
  app.textContent = "Načítám…";

  const windows = await browser.windows.getAll({
    populate: true,
    windowTypes: ["normal"]
  });

  const chunks = [];

  for (const win of windows) {
    const groups = await browser.tabGroups.query({ windowId: win.id });
    const tabs = win.tabs ?? [];
    const groupedIds = new Set();

    const groupHtml = groups.map(group => {
      const groupTabs = tabs.filter(tab => tab.groupId === group.id);
      groupTabs.forEach(tab => groupedIds.add(tab.id));
      return `
        <section class="group">
          <h3>${esc(group.title || "(skupina bez názvu)")} · ${groupTabs.length} tabů · ${esc(group.color)}${group.collapsed ? " · collapsed" : ""}</h3>
          ${groupTabs.length ? groupTabs.map(renderTab).join("") : '<div class="empty">Prázdná skupina</div>'}
        </section>`;
    }).join("");

    const ungrouped = tabs.filter(tab => !groupedIds.has(tab.id));
    const ungroupedHtml = ungrouped.length
      ? `
        <section class="ungrouped">
          <h3>Bez skupiny · ${ungrouped.length} tabů</h3>
          ${ungrouped.map(renderTab).join("")}
        </section>`
      : "";

    chunks.push(`
      <section class="window">
        <h2>Okno #${win.id} · ${tabs.length} tabů · ${groups.length} skupin</h2>
        ${groupHtml}
        ${ungroupedHtml}
      </section>`);
  }

  app.innerHTML = chunks.length ? chunks.join("") : '<div class="empty">Žádné normální Firefox okno.</div>';
}

app.addEventListener("click", async event => {
  const button = event.target.closest('button[data-action="deep"]');
  if (!button) return;

  const tabId = Number(button.dataset.tabId);
  button.disabled = true;

  try {
    await browser.tabs.discard(tabId);
  } catch (error) {
    console.error("DEEP discard failed", error);
    button.disabled = false;
  }

  await load();
});

refreshButton.addEventListener("click", () => load().catch(console.error));
load().catch(error => {
  console.error(error);
  app.textContent = "Chyba při načítání. Podrobnosti jsou v konzoli rozšíření.";
});


deepAllButton.addEventListener("click", async () => {
  deepAllButton.disabled = true;

  try {
    const tabs = await browser.tabs.query({});
    const candidates = tabs.filter(tab =>
      !tab.active &&
      !tab.discarded &&
      !tab.audible &&
      !tab.pinned &&
      tab.id != null
    );

    for (const tab of candidates) {
      try {
        await browser.tabs.discard(tab.id);
      } catch (error) {
        console.warn("Bulk DEEP skipped tab", tab.id, error);
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
