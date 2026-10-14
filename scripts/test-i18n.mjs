// @ts-check
// Pure Node test of the packaged CZ/EN catalogs and the locale override contract.
// Does not load Firefox, modify a user profile, or ship inside the XPI.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = path => readFileSync(join(root, path), "utf8");
const cs = JSON.parse(read("_locales/cs/messages.json"));
const en = JSON.parse(read("_locales/en/messages.json"));
const constants = Object.fromEntries(
  [...read("src/shared/constants.js").matchAll(
    /export const ([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)";/g
  )].map(match => [match[1], match[2]])
);
const LANGUAGE_KEY = constants.UI_LANGUAGE_KEY;
assert.equal(LANGUAGE_KEY, "fwm.ui.language");
assert(!read("src/shared/constants.js").match(/SYNC_KEYS\s*=\s*\[[^\]]*UI_LANGUAGE_KEY/));

// Data URL imports keep the real source as a native ES module without
// introducing npm/DOM/browser dependencies or requiring package type=module.
const i18nSource = read("src/shared/i18n.js").replace(
  'import { UI_LANGUAGE_KEY } from "./constants.js";',
  'const UI_LANGUAGE_KEY = "fwm.ui.language";'
);
assert(!i18nSource.includes('from "./constants.js"'));
const i18nURL = "data:text/javascript;base64," +
  Buffer.from(i18nSource).toString("base64");

const cases = [
  { name: "automatic Czech", firefox: "cs-CZ", choice: "auto", expected: "cs", fetches: 0 },
  { name: "automatic English", firefox: "en-US", choice: "auto", expected: "en", fetches: 0 },
  { name: "English over Czech Firefox", firefox: "cs-CZ", choice: "en", expected: "en", fetches: 1 },
  { name: "Czech over English Firefox", firefox: "en-US", choice: "cs", expected: "cs", fetches: 1 },
  { name: "unsupported browser locale", firefox: "fr-FR", choice: "auto", expected: "en", fetches: 0 },
  { name: "invalid stored preference", firefox: "cs-CZ", choice: "xx", expected: "cs", fetches: 0 },
  { name: "manual catalog unavailable", firefox: "cs-CZ", choice: "en", expected: "cs", fetches: 1, failFetch: true }
];
let passed = 0;

for (const [index, testcase] of cases.entries()) {
  let fetches = 0;
  const errors = [];
  globalThis.browser = {
    i18n: {
      getUILanguage: () => testcase.firefox,
      getMessage: (key, substitutions = []) => {
        if (key === "@@ui_locale") return testcase.firefox;
        const catalog = testcase.firefox.startsWith("cs") ? cs : en;
        return (catalog[key]?.message ?? "").replace(/\$([1-9])/g,
          (match, number) => substitutions[Number(number) - 1] ?? match);
      }
    },
    runtime: { getURL: path => "moz-extension://test/" + path },
    storage: { local: { get: async key => ({ [key]: testcase.choice }) } }
  };
  globalThis.fetch = async url => {
    fetches++;
    if (testcase.failFetch) throw new Error("Mocked missing catalog");
    assert(url.startsWith("moz-extension://test/_locales/"));
    return { ok: true, json: async () => url.includes("/cs/") ? cs : en };
  };
  const originalError = console.error;
  try {
    console.error = (...args) => errors.push(args);
    const lib = await import(i18nURL + "#" + index);
    await lib.initializeLocale();
    assert.equal(lib.translationLocale, testcase.expected, testcase.name);
    assert.equal(fetches, testcase.fetches, testcase.name);
    const wanted = testcase.expected === "cs"
      ? ["panelů", "panel", "panely", "panelů"]
      : ["tabs", "tab", "tabs", "tabs"];
    assert.deepEqual([0, 1, 2, 5].map(n => lib.pluralLabel(n, "countTab")), wanted);
    assert.equal(lib.formatCount(2, "countTab"),
      testcase.expected === "cs" ? "2 panely" : "2 tabs");
    const dialog = lib.t("confirmRecoverAdditionalWindows", 4, 2);
    assert(dialog.includes("4") && dialog.includes("2") && !dialog.includes("$1"));
    const node = { textContent: "", getAttribute: key => key === "data-i18n" ? "languageHeading" : null };
    const documentMock = {
      documentElement: { lang: "" },
      querySelectorAll: selector => selector === "[data-i18n]" ? [node] : []
    };
    lib.localizeDocument(documentMock);
    assert.equal(documentMock.documentElement.lang, testcase.expected);
    assert.equal(node.textContent,
      testcase.expected === "cs" ? "Jazyk rozhraní" : "Interface language");
    assert.equal(errors.length, testcase.failFetch ? 1 : 0);
    passed++;
  } finally {
    console.error = originalError;
  }
}

// Verify that the original v1 application backup accepts the optional
// language preference without changing the backup version or persisted IDs.
const backupImports = read("src/background/AppBackupService.js");
const importHeader = /^import\s+\{[\s\S]*?\}\s+from\s+"\.\.\/shared\/constants\.js";/;
assert(importHeader.test(backupImports));
const importedConstants = {
  ...constants,
  defaultAutoSettings: () => ({
    minutes: 60, deepOnLeave: false, protectPinned: true, protectAudible: true
  })
};
globalThis.__testBackupConstants = importedConstants;
const nameHelperURL = "data:text/javascript;base64," +
  Buffer.from(read("src/shared/backupFilename.js")).toString("base64");
globalThis.__testNormalizeDeviceName = (await import(nameHelperURL)).normalizeDeviceName;
const backupSource = backupImports.replace(
  importHeader,
  "const { " +
    [...backupImports.match(importHeader)[0].matchAll(/\b([A-Z][A-Z0-9_]*|defaultAutoSettings)\b/g)]
      .map(match => match[1]).filter(name => name !== "OBJECT").join(", ") +
    " } = globalThis.__testBackupConstants;"
).replace(
  'import { normalizeDeviceName } from "../shared/backupFilename.js";',
  "const normalizeDeviceName = globalThis.__testNormalizeDeviceName;"
);
assert(!backupSource.includes('from "../shared/backupFilename.js"'));
const backupURL = "data:text/javascript;base64," +
  Buffer.from(backupSource).toString("base64");
const { AppBackupService } = await import(backupURL);
const collection = {
  format: "firefox-workspace-manager.workspaces",
  version: 1,
  workspaces: []
};
for (const choice of ["auto", "cs", "en"]) {
  const store = {
    [constants.UI_LANGUAGE_KEY]: choice,
    [constants.UI_PAGE_KEY]: "settings",
    [constants.UI_DEVICE_NAME_KEY]: "SOURCE-PC"
  };
  globalThis.browser = {
    runtime: { getManifest: () => ({ version: "1.0.0" }) },
    storage: { local: {
      get: async keys => Object.fromEntries(keys.map(key => [key, store[key]])),
      set: async changes => Object.assign(store, changes),
      remove: async key => { delete store[key]; }
    } }
  };
  const service = new AppBackupService();
  const payload = await service.exportBackup({ workspaceCollection: collection });
  assert.equal(payload.version, 1);
  assert.equal(payload.ui.language, choice);
  assert.equal(payload.ui.deviceName, "SOURCE-PC");
  store[constants.UI_DEVICE_NAME_KEY] = "TARGET-PC";
  const restored = await service.restoreBackup(payload, {}, []);
  assert.equal(restored.language, choice);
  assert.equal(store[constants.UI_LANGUAGE_KEY], choice);
  assert.equal(store[constants.UI_DEVICE_NAME_KEY], "TARGET-PC",
    "Background restore must never silently overwrite the target device name");
  const legacy = JSON.parse(JSON.stringify(payload));
  delete legacy.ui.language;
  delete legacy.ui.deviceName;
  const legacyResult = await service.restoreBackup(legacy, {}, []);
  assert.equal(legacyResult.language, "auto");
  assert.equal(store[constants.UI_LANGUAGE_KEY], "auto");
  assert.equal(store[constants.UI_DEVICE_NAME_KEY], "TARGET-PC");
}
console.log("i18n behavior OK: " + passed +
  " language cases, plural forms and portable v1 backup compatibility.");
