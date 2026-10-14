// @ts-check
// Local, explicitly configured device label. No fingerprinting or hostname APIs.

/** @param {unknown} value @returns {string} */
export function normalizeDeviceName(value) {
  const name = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name) ? name : "";
}

/**
 * Always place the device label immediately after yyyyMMddHHmmss.
 * @param {string} timestamp
 * @param {string} deviceName
 * @param {string} baseName
 */
export function backupFilename(timestamp, deviceName, baseName) {
  const name = normalizeDeviceName(deviceName);
  if (!name) throw new Error("Device name must be defined before export");
  if (!/^\d{14}$/.test(timestamp)) throw new Error("Invalid export timestamp");
  const suffix = String(baseName).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!suffix || suffix === "." || suffix === "..") throw new Error("Invalid export name");
  return timestamp + "_" + name + "_" + suffix + ".json";
}
