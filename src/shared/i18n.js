// @ts-check
/**
 * Fetch a string from the native WebExtension catalog. String IDs are stable UI
 * keys, never serialized into workspace, lifecycle or backup records.
 *
 * @param {string} key
 * @param {...unknown} values
 * @returns {string}
 */
export function t(key, ...values) {
  const replacements = values.map(value => String(value ?? ""));
  const message = browser.i18n.getMessage(key, replacements);
  if (message) return message;
  console.error("Missing i18n message:", key);
  return key;
}

/** @type {string} */
export const uiLocale = browser.i18n.getMessage("@@ui_locale") ||
  browser.i18n.getUILanguage() || "en";

/**
 * Only replaces static text and literal attributes; no HTML is parsed or inserted.
 * Safe for AMO validation and for markup containing live event handlers / child IDs.
 *
 * @param {Document} [root]
 */
export function localizeDocument(root = document) {
  root.documentElement.lang = uiLocale;
  const attributeKeys = {
    "data-i18n-title": "title",
    "data-i18n-placeholder": "placeholder",
    "data-i18n-aria-label": "aria-label"
  };

  for (const node of root.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.getAttribute("data-i18n") || "");
  }

  for (const [lookup, attribute] of Object.entries(attributeKeys)) {
    for (const node of root.querySelectorAll("[" + lookup + "]")) {
      node.setAttribute(attribute, t(node.getAttribute(lookup) || ""));
    }
  }
}
