// @ts-check

import { isExtensionUrl } from "./url.js";

/** @typedef {import("../types/domain.js").WorkspaceWindow} WorkspaceWindow */

const FINGERPRINT_FORMAT = "fwm-window-fingerprint-v1";

/** @param {unknown} value */
export function normalizeFingerprintText(value) {
  return String(value ?? "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** @param {unknown} value */
export function normalizeFingerprintUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}

/** @param {string} value */
async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** @param {WorkspaceWindow} savedWindow */
export function savedWindowFingerprintRows(savedWindow) {
  const groupTitleByKey = new Map(
    (savedWindow?.groups ?? []).map(group => [
      group.groupKey ?? null,
      normalizeFingerprintText(group.title || "")
    ])
  );

  return (savedWindow?.tabs ?? [])
    .filter(tab => !isExtensionUrl(tab.url))
    .map(tab => {
      const groupTitle = tab.groupKey
        ? (groupTitleByKey.get(tab.groupKey) ?? "<unknown-group>")
        : "<ungrouped>";
      return groupTitle + "|" + normalizeFingerprintUrl(tab.url);
    })
    .sort();
}

/**
 * @param {import("../types/domain.js").BrowserWindow} liveWindow
 * @param {import("../types/domain.js").BrowserTabGroup[]} liveGroups
 */
export function liveWindowFingerprintRows(liveWindow, liveGroups) {
  const groupTitleByRuntimeId = new Map(
    (liveGroups ?? []).map(group => [
      group.id,
      normalizeFingerprintText(group.title || "")
    ])
  );

  return (liveWindow?.tabs ?? [])
    .filter(tab => !isExtensionUrl(tab.url))
    .map(tab => {
      const groupTitle = tab.groupId != null && tab.groupId !== -1
        ? (groupTitleByRuntimeId.get(tab.groupId) ?? "<unknown-group>")
        : "<ungrouped>";
      return groupTitle + "|" + normalizeFingerprintUrl(tab.url);
    })
    .sort();
}

/** @param {string[]} rows */
async function fingerprintRows(rows) {
  return sha256Hex([FINGERPRINT_FORMAT, ...rows].join("\n"));
}

/** @param {WorkspaceWindow} savedWindow */
export function fingerprintSavedWindow(savedWindow) {
  return fingerprintRows(savedWindowFingerprintRows(savedWindow));
}

/**
 * @param {import("../types/domain.js").BrowserWindow} liveWindow
 * @param {import("../types/domain.js").BrowserTabGroup[]} liveGroups
 */
export function fingerprintLiveWindow(liveWindow, liveGroups) {
  return fingerprintRows(liveWindowFingerprintRows(liveWindow, liveGroups));
}

/** @param {string[]} valuesA @param {string[]} valuesB */
function multisetOverlap(valuesA, valuesB) {
  const counts = new Map();
  for (const value of valuesA) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  let overlap = 0;
  for (const value of valuesB) {
    if (!value) continue;
    const count = counts.get(value) ?? 0;
    if (count > 0) {
      overlap++;
      if (count === 1) counts.delete(value);
      else counts.set(value, count - 1);
    }
  }
  return overlap;
}

/** @param {string|null|undefined} url */
function isGenericSessionUrl(url) {
  return ["about:blank", "about:newtab", "about:home"].includes(url ?? "");
}

/**
 * Fuzzy fallback for a native Firefox window whose exact fingerprint changed.
 * Exact fingerprint matching must always be preferred by callers.
 *
 * @param {WorkspaceWindow} savedWindow
 * @param {import("../types/domain.js").BrowserWindow} liveWindow
 * @param {import("../types/domain.js").BrowserTabGroup[]} liveGroups
 */
export function scoreWorkspaceWindowMatch(savedWindow, liveWindow, liveGroups) {
  const savedTabs = (savedWindow?.tabs ?? []).filter(tab => !isExtensionUrl(tab.url));
  const liveTabs = (liveWindow?.tabs ?? []).filter(tab => !isExtensionUrl(tab.url));
  if (!savedTabs.length || !liveTabs.length) return null;

  const savedUrls = savedTabs.map(tab => tab.url).filter(url => url && !isGenericSessionUrl(url));
  const liveUrls = liveTabs.map(tab => tab.url ?? "").filter(url => url && !isGenericSessionUrl(url));
  const savedTitles = savedTabs.map(tab => tab.title).filter(Boolean);
  const liveTitles = liveTabs.map(tab => tab.title ?? "").filter(Boolean);
  const savedGroupTitles = (savedWindow.groups ?? []).map(group => group.title).filter(Boolean);
  const liveGroupTitles = (liveGroups ?? []).map(group => group.title ?? "").filter(Boolean);

  const urlOverlap = multisetOverlap(savedUrls, liveUrls);
  const titleOverlap = multisetOverlap(savedTitles, liveTitles);
  const groupOverlap = multisetOverlap(savedGroupTitles, liveGroupTitles);

  const maxTabs = Math.max(savedTabs.length, liveTabs.length);
  const minTabs = Math.min(savedTabs.length, liveTabs.length);
  const countSimilarity = maxTabs ? minTabs / maxTabs : 0;
  const contentOverlap = Math.max(urlOverlap, titleOverlap);
  const contentCoverage = maxTabs ? contentOverlap / maxTabs : 0;
  const maxGroups = Math.max(savedGroupTitles.length, liveGroupTitles.length);
  const groupCoverage = maxGroups ? groupOverlap / maxGroups : 1;

  const score = (contentCoverage * 0.72) + (countSimilarity * 0.20) + (groupCoverage * 0.08);

  let accepted = false;
  if (maxTabs <= 2) {
    accepted = savedTabs.length === liveTabs.length && contentCoverage === 1;
  } else if (maxTabs <= 7) {
    accepted = countSimilarity >= 0.75 && contentCoverage >= 0.70;
  } else {
    accepted = countSimilarity >= 0.70 && contentCoverage >= 0.55 && contentOverlap >= 3;
  }

  return {
    score,
    accepted,
    savedTabCount: savedTabs.length,
    liveTabCount: liveTabs.length,
    urlOverlap,
    titleOverlap,
    groupOverlap,
    contentCoverage,
    countSimilarity,
    groupCoverage
  };
}
