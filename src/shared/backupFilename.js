// @ts-check
// Local per-profile device label, never a hardware or browser fingerprint.

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

/** Reserved generated-name syntax, eight hexadecimal digits. */
const GENERATED_NAME_PATTERN = /^FFWM-[0-9A-F]{8}$/i;

/** @param {unknown} value @returns {boolean} */
export function isGeneratedDeviceName(value) {
  return GENERATED_NAME_PATTERN.test(String(value ?? ""));
}

/**
 * Generate a stable per-profile label using 32 cryptographically random bits.
 * Only tests should inject explicit bytes; production always uses Web Crypto.
 *
 * @param {Uint8Array} [randomBytes]
 * @returns {string}
 */
export function generateDeviceName(randomBytes = crypto.getRandomValues(new Uint8Array(4))) {
  if (randomBytes.length !== 4) throw new Error("Expected four random bytes");
  return "FFWM-" + [...randomBytes].map(byte => byte.toString(16).padStart(2, "0"))
    .join("").toUpperCase();
}

/**
 * Decide whether application-restore may carry a source profile's PC label.
 * A restored label never modifies the local name until the restore succeeded.
 *
 * @param {unknown} current
 * @param {unknown} fromBackup
 * @returns {{action:"keep"|"adopt"|"ask",name:string}}
 */
export function planDeviceNameRestore(current, fromBackup) {
  const saved = normalizeDeviceName(fromBackup);
  const local = normalizeDeviceName(current);
  if (!saved || saved === local) return { action: "keep", name: local };
  if (!local || isGeneratedDeviceName(local)) {
    return { action: "adopt", name: saved };
  }
  return { action: "ask", name: saved };
}
