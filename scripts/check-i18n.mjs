// @ts-check
// Dependency-free localization check. Kept outside packaged WebExtension sources.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const read = file => readFileSync(join(root, file), "utf8");
const cs = JSON.parse(read("_locales/cs/messages.json"));
const en = JSON.parse(read("_locales/en/messages.json"));
const manifest = JSON.parse(read("manifest.json"));
const catalogs = { cs, en };
const keys = new Set([...Object.keys(cs), ...Object.keys(en)]);
const uiFiles = [
  "src/manager/manager.js",
  "src/manager/manager.html",
  "src/popup/popup.js",
  "src/popup/popup.html"
];
const uiSource = uiFiles.map(read).join("\n");

if (manifest.default_locale !== "en") {
  failures.push("Expected manifest.default_locale=en");
}
for (const key of keys) {
  for (const [locale, data] of Object.entries(catalogs)) {
    if (typeof data[key]?.message !== "string" || !data[key].message.trim()) {
      failures.push(locale + ": missing or empty key " + key);
    }
  }
  if (cs[key]?.message && en[key]?.message) {
    const slots = text => [...text.matchAll(/\$([1-9])/g)]
      .map(match => match[1]).sort().join(",");
    if (slots(cs[key].message) !== slots(en[key].message)) {
      failures.push("Mismatch of $n placeholders: " + key);
    }
  }
}
const refs = [
  ...uiSource.matchAll(/\bt\("([^"]+)"/g),
  ...uiSource.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)
];
for (const match of refs) {
  if (!cs[match[1]] || !en[match[1]]) {
    failures.push("Missing referenced translation key: " + match[1]);
  }
}
for (const [, stem] of uiSource.matchAll(/\b(?:pluralLabel|formatCount)\([^,\n]+,\s*"([^"]+)"\)/g)) {
  for (const suffix of ["One", "Few", "Other"]) {
    const key = stem + suffix;
    if (!cs[key] || !en[key]) {
      failures.push("Missing count-dependent translation: " + key);
    }
  }
}
for (const match of JSON.stringify(manifest).matchAll(/__MSG_([a-z0-9_]+)__/gi)) {
  if (!cs[match[1]] || !en[match[1]]) {
    failures.push("Missing manifest i18n entry: " + match[1]);
  }
}
for (const file of ["src/manager/manager.js", "src/popup/popup.js"]) {
  const code = read(file);
  if (/\b(?:alert|confirm|prompt)\s*\(/.test(code)) {
    failures.push("Suppressible native browser dialog found: " + file);
  }
}
for (const file of ["src/manager/manager.js", "src/popup/popup.js"]) {
  const data = read(file);
  if (/[áčďéěíňóřšťúůýž]/i.test(data)) {
    failures.push("Untranslated Czech literal in runtime UI: " + file);
  }
}
function jsFiles(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(item => {
    const child = dir + "/" + item.name;
    return item.isDirectory() ? jsFiles(child) : item.name.endsWith(".js") ? [child] : [];
  });
}
for (const path of [...jsFiles("src"), "scripts/check-i18n.mjs", "scripts/test-i18n.mjs", "scripts/test-backup-label.mjs"]) {
  try {
    execFileSync(process.execPath, ["--input-type=module", "--check"], {
      input: read(path),
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (error) {
    failures.push("JS syntax error in " + path + ": " + (error.stderr?.toString() || error.message));
  }
}
if (failures.length) {
  failures.forEach(item => console.error("ERROR: " + item));
  process.exitCode = 1;
} else {
  console.log("i18n OK: " + keys.size + " mirrored CZ/EN keys; references and JS syntax verified.");
}
