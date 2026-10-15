// @ts-check

/** @param {string|null|undefined} url */
export function isHttpUrl(url) {
  return /^https?:\/\//i.test(url ?? "");
}

/** @param {string|null|undefined} url */
export function hostnameFromUrl(url) {
  try {
    const parsed = new URL(url ?? "");
    return ["http:", "https:"].includes(parsed.protocol)
      ? parsed.hostname.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

/** @param {string|null|undefined} url */
export function isExtensionUrl(url) {
  return /^(moz|chrome)-extension:\/\//i.test(url ?? "");
}

/** @param {string|null|undefined} url */
export function isTransientBlankUrl(url) {
  return ["about:blank", "about:newtab", "about:home"].includes(String(url ?? ""));
}

/** @param {import("../types/domain.js").BrowserWindow} win */
export function hasWorkspaceContent(win) {
  return (win?.tabs ?? []).some(tab => {
    const url = tab?.url ?? "";
    if (isExtensionUrl(url)) return false;
    return !isTransientBlankUrl(url);
  });
}

/**
 * Return a URL that WebExtensions can create directly.
 * Privileged about:* pages are deliberately excluded.
 *
 * @param {string|null|undefined} url
 */
export function restorableUrl(url) {
  if (!url || isExtensionUrl(url)) return null;

  try {
    const parsed = new URL(url);
    if (["http:", "https:", "file:"].includes(parsed.protocol)) return url;
    if (url === "about:blank") return url;
  } catch {}

  return null;
}

/** @param {string|null|undefined} url */
export function restoreUrlOrBlank(url) {
  return restorableUrl(url) ?? "about:blank";
}
