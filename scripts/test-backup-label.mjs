// @ts-check
// Self-hosted Node checks: export identity never requires a native OS hostname,
// and no exported JSON format or machine-to-machine restore behavior changes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = path => readFileSync(join(root, path), "utf8");
const backupFilenameSource = read("src/shared/backupFilename.js");
const moduleUrl = "data:text/javascript;base64," +
  Buffer.from(backupFilenameSource).toString("base64");
const {
  normalizeDeviceName, backupFilename, generateDeviceName,
  isGeneratedDeviceName, planDeviceNameRestore
} = await import(moduleUrl);

assert.equal(generateDeviceName(new Uint8Array([0xa8, 0x3f, 0x92, 0xc1])), "FFWM-A83F92C1");
assert(isGeneratedDeviceName(generateDeviceName()));
assert(isGeneratedDeviceName("FFWM-a83f92c1"));
for (const invalidAuto of ["PC-ZEDNIK", "FFWM-short", "FFWM-000000000", "FFWM-ZZFF0011"]) {
  assert(!isGeneratedDeviceName(invalidAuto));
}
for (const [current, backup, wantedAction] of [
  ["FFWM-A83F92C1", "PC-ZEDNIK", "adopt"],
  ["FFWM-A83F92C1", "FFWM-0123ABCD", "adopt"],
  ["PC-ZEDNIK", "HOME-PC", "ask"],
  ["PC-ZEDNIK", "FFWM-0123ABCD", "ask"],
  ["PC-ZEDNIK", "PC-ZEDNIK", "keep"],
  ["PC-ZEDNIK", null, "keep"],
  ["FFWM-A83F92C1", null, "keep"],
  ["", "PC-ZEDNIK", "adopt"],
  ["PC-ZEDNIK", "../unsafe", "keep"]
]) {
  assert.equal(planDeviceNameRestore(current, backup).action, wantedAction,
    "Restore classification: " + current + " / " + backup);
}

assert.equal(normalizeDeviceName(" PC-ZEDNIK "), "PC-ZEDNIK");
assert.equal(normalizeDeviceName("HOME_02"), "HOME_02");
assert.equal(normalizeDeviceName("Lab.pc"), "Lab.pc");
assert.equal(normalizeDeviceName("x".repeat(40)), "x".repeat(40));
for (const invalid of ["", "  ", "..", "a/b", "a\\b", "../tmp", "C:", "x".repeat(41), "My PC"]) {
  assert.equal(normalizeDeviceName(invalid), "", "Rejected invalid name: " + invalid);
}
const stamp = "20261014125100";
assert.equal(backupFilename(stamp, "PC-ZEDNIK", "workspace_manager"),
  "20261014125100_PC-ZEDNIK_workspace_manager.json");
assert.equal(backupFilename(stamp, "HOME_02", "workspaces"),
  "20261014125100_HOME_02_workspaces.json");
assert.equal(backupFilename(stamp, "PC-A", "Práce/old"),
  "20261014125100_PC-A_Pr_ce_old.json");
assert.throws(() => backupFilename(stamp, "", "workspaces"));
assert.throws(() => backupFilename("no-date", "PC-A", "workspaces"));
assert.throws(() => backupFilename(stamp, "PC-A", "../"));

const manager = read("src/manager/manager.js");
const managerHtml = read("src/manager/manager.html");
const popup = read("src/popup/popup.js");
const backup = read("src/background/AppBackupService.js");
const constants = read("src/shared/constants.js");
assert(constants.includes('UI_DEVICE_NAME_KEY = "fwm.ui.deviceName"'));
assert(backup.includes('deviceName: normalizeDeviceName(stored[UI_DEVICE_NAME_KEY]) || null'),
  "Complete application backup must export its local device label");
assert(!/\[UI_DEVICE_NAME_KEY\]\s*:/.test(backup.slice(backup.indexOf("async restoreBackup("))),
  "Background must not overwrite target PC identity during application restore");
assert(!/SYNC_KEYS\s*=\s*\[[^\]]*UI_DEVICE_NAME_KEY/.test(constants));
assert(manager.includes("await loadDeviceName();"));
assert(manager.includes("saved = generateDeviceName();"));
assert(manager.includes("planDeviceNameRestore(deviceName, payload?.ui?.deviceName)"));
assert(manager.includes('t("deviceNameRestoreAsk", deviceName, labelPlan.name)'));
assert(manager.includes('if (renameAccepted) selectedRestoredName = labelPlan.name;'));
assert(manager.indexOf("await browser.storage.local.set({ [UI_DEVICE_NAME_KEY]: selectedRestoredName });") >
       manager.indexOf('type: "restoreApplicationBackup"'));
assert(manager.includes("if (!deviceName) return;"));
assert(manager.includes('action("export", t("exportJson"), !deviceName)'));
assert(manager.match(/backupFilename\(backupTimestamp\(\), deviceName/g)?.length === 3);
for (const btn of ["backupWorkspaces", "backupApplication"]) {
  assert(new RegExp('<button id="' + btn + '"[^>]*disabled').test(managerHtml));
}
assert(managerHtml.includes('id="deviceName"'));
assert(managerHtml.includes('id="saveDeviceName"'));
for (const source of [manager, popup]) {
  assert(!/\b(?:alert|confirm|prompt)\s*\(/.test(source));
}
assert(manager.includes('await confirmDialog('));
assert(popup.includes('await confirmDialog('));
console.log("Backup label OK: random persistent labels, safe filenames, source-name restore policy, legacy preservation and custom dialogs.");
