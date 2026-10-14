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
const { normalizeDeviceName, backupFilename } = await import(moduleUrl);

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
assert(!backup.includes("UI_DEVICE_NAME_KEY"),
  "Machine identity must never overwrite the target computer during restore");
assert(!/SYNC_KEYS\s*=\s*\[[^\]]*UI_DEVICE_NAME_KEY/.test(constants));
assert(manager.includes("await loadDeviceName();"));
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
console.log("Backup label OK: mandatory explicit local label, safe filenames, portable restore unaffected, custom dialogs only.");
