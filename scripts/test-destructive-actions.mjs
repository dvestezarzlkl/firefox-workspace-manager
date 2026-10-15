// @ts-check
// Execute the actual manager KEEP deletion listener with mocked storage/DOM.
// Only this Node test compiles source text; it is excluded from the extension ZIP.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manager = readFileSync(join(root, "src/manager/manager.js"), "utf8");
const marker = 'urlPoliciesEl.addEventListener("click", async event => {';
const start = manager.indexOf(marker);
assert(start !== -1, "Missing KEEP URL delete handler");
const end = manager.indexOf("\n});", start);
assert(end > start, "Incomplete KEEP URL delete handler");
const listenerSource = manager.slice(start, end + 4);
assert(listenerSource.includes('confirmDialog(t("confirmDeleteUrlException", url), { danger: true })'));
assert(listenerSource.indexOf("confirmDialog") < listenerSource.indexOf("current.filter("));
assert(listenerSource.includes("await browser.storage.local.get(URL_POLICIES_KEY)"));

const initial = [
  { url: "https://example.test/keep", mode: "KEEP" },
  { url: "https://other.test/keep", mode: "KEEP" }
];

async function scenario({ approve = false, clickedUrl = initial[0].url, concurrent, disabled = false, saveError = false } = {}) {
  const key = "fwm.urlPolicies";
  const copy = data => structuredClone(data);
  const store = { [key]: copy(initial) };
  let listener, writes = 0, confirmations = [], messages = [];
  const button = { disabled, dataset: { removeUrlRule: clickedUrl } };
  const deps = {
    urlPoliciesEl: {
      addEventListener(name, cb) { assert.equal(name, "click"); listener = cb; }
    },
    URL_POLICIES_KEY: key,
    browser: { storage: { local: { get: async requested => {
      assert.equal(requested, key);
      return { [key]: copy(store[key]) };
    } } } },
    confirmDialog: async (message, options) => {
      confirmations.push({ message, options });
      if (concurrent !== undefined) store[key] = copy(concurrent);
      return approve;
    },
    t: (keyName, value = "") => keyName + ": " + value,
    messageDialog: async message => { messages.push(message); },
    console: { error() {} },
    save: async rules => {
      if (saveError) throw Error("Injected write failure");
      writes++;
      store[key] = copy(rules);
    }
  };
  const constructor = new Function("deps", "initial", 
    'const {urlPoliciesEl, URL_POLICIES_KEY, browser, confirmDialog, t, messageDialog, console, save} = deps;\n' +
    'let urlPolicies = initial;\n' +
    'async function saveUrlPolicies() { await save(urlPolicies); }\n' +
    listenerSource + '\nreturn { getLocal: () => urlPolicies };'
  );
  constructor(deps, copy(initial));
  assert.equal(typeof listener, "function");
  await listener({ target: { closest: () => button } });
  return { stored: copy(store[key]), button, writes, confirmations, messages };
}

const canceled = await scenario({ approve: false });
assert.equal(canceled.writes, 0);
assert.deepEqual(canceled.stored, initial, "Cancel/ESC must never delete");
assert.equal(canceled.confirmations.length, 1);
assert.equal(canceled.confirmations[0].options.danger, true);
assert(canceled.confirmations[0].message.includes(initial[0].url));
assert.equal(canceled.button.disabled, false);

const confirmed = await scenario({ approve: true });
assert.equal(confirmed.writes, 1);
assert.deepEqual(confirmed.stored, [initial[1]], "Only target URL is deleted");
assert.equal(confirmed.button.disabled, false);

const extra = { url: "https://new.test/rule", mode: "KEEP" };
const raced = await scenario({ approve: true, concurrent: [...initial, extra] });
assert.deepEqual(raced.stored, [initial[1], extra],
  "Keep concurrent changes while modal is open");

const alreadyRemoved = await scenario({ approve: true, concurrent: [initial[1]] });
assert.equal(alreadyRemoved.writes, 0, "Do not write if rule vanished concurrently");
assert.deepEqual(alreadyRemoved.stored, [initial[1]]);

const absent = await scenario({ approve: true, clickedUrl: "https://absent.test" });
assert.equal(absent.confirmations.length, 0);
assert.equal(absent.writes, 0);
const disabled = await scenario({ approve: true, disabled: true });
assert.equal(disabled.confirmations.length, 0);
assert.equal(disabled.writes, 0);

const failed = await scenario({ approve: true, saveError: true });
assert.equal(failed.writes, 0);
assert.equal(failed.messages.length, 1);
assert.equal(failed.button.disabled, false);

for (const [anchor, guard] of [
  ['if (windowButton.dataset.workspaceWindowAction === "remove")', 'await confirmDialog'],
  ['if (button.dataset.workspaceAction === "delete")', 'await confirmDialog'],
  ['const accepted = await confirmDialog(t("confirmRestoreApplication"', 'confirmDialog']
]) {
  const offset = manager.indexOf(anchor);
  assert(offset >= 0 && manager.slice(offset, offset + 470).includes(guard),
    "Missing confirmation guard near " + anchor);
}
console.log("Destructive action safety OK: Cancel/no-write, explicit delete, concurrent edits, errors and other delete guards.");
