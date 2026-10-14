// @ts-check

import { UI_LANGUAGE_KEY } from "./constants.js";

const browserLocale = (browser.i18n.getUILanguage() ||
  browser.i18n.getMessage("@@ui_locale") || "en").replaceAll("_", "-");
const automaticLocale = browserLocale.toLowerCase().startsWith("cs") ? "cs" : "en";
const supportedLanguages = new Set(["auto", "cs", "en"]);

/** @param {unknown} value @returns {"auto"|"cs"|"en"} */
export function normalizeLanguage(value) {
  return value === "cs" || value === "en" ? value : "auto";
}

/** Current preference, independent of Firefox Sync and workspace snapshots. */
export let languagePreference = "auto";
/** Resolved CZ/EN translation catalog. */
export let translationLocale = automaticLocale;
/** Locale used by date/time formatting in manager UI. */
export let uiLocale = browserLocale;

/** @type {Record<string,{message:string}>|null} */
let manualCatalog = null;

/**
 * Read a local UI preference. In automatic mode, preserve native WebExtension
 * localization. Manual mode reads only the packaged CZ or EN catalog.
 * Failure safely falls back to native Firefox localization, never remote code.
 */
export async function initializeLocale() {
  let storedValue;
  try {
    const stored = await browser.storage.local.get(UI_LANGUAGE_KEY);
    storedValue = stored[UI_LANGUAGE_KEY];
  } catch (error) {
    console.error("Unable to read UI language preference:", error);
  }

  const requested = normalizeLanguage(storedValue);
  languagePreference = requested;
  translationLocale = automaticLocale;
  uiLocale = browserLocale;
  manualCatalog = null;

  if (requested === "auto") return;

  try {
    const url = browser.runtime.getURL("_locales/" + requested + "/messages.json");
    const response = await fetch(url);
    if (!response.ok) throw new Error("HTTP " + response.status);
    const catalog = await response.json();
    if (!catalog || typeof catalog !== "object" ||
        typeof catalog.extensionName?.message !== "string") {
      throw new Error("Invalid packaged translation catalog");
    }
    manualCatalog = catalog;
    translationLocale = requested;
    uiLocale = requested;
  } catch (error) {
    console.error("Unable to activate selected UI language; using Firefox locale:", error);
    languagePreference = "auto";
  }
}

/**
 * Return a translated string, with positional $1-$9 substitution in manual
 * mode. All messages are bundled in the extension; never render as HTML.
 *
 * @param {string} key
 * @param {...unknown} values
 * @returns {string}
 */
export function t(key, ...values) {
  const replacements = values.map(value => String(value ?? ""));
  const custom = manualCatalog?.[key]?.message;
  if (typeof custom === "string") {
    return custom.replace(/\$([1-9])(?![0-9])/g, (match, number) =>
      replacements[Number(number) - 1] ?? match);
  }
  const message = browser.i18n.getMessage(key, replacements);
  if (message) return message;
  console.error("Missing i18n message:", key);
  return key;
}

/**
 * Derive plural forms from the selected UI locale, not the system or Firefox
 * locale when an explicit override is active.
 *
 * @param {number} count
 * @param {string} stem
 * @returns {string}
 */
export function pluralLabel(count, stem) {
  const category = new Intl.PluralRules(translationLocale).select(count);
  return t(stem + category.charAt(0).toUpperCase() + category.slice(1));
}

/**
 * @param {number} count
 * @param {string} stem
 * @returns {string}
 */
export function formatCount(count, stem) {
  return String(count) + " " + pluralLabel(count, stem);
}

/**
 * Translate static text and attributes without unsafe HTML string parsing.
 *
 * @param {Document} [root]
 */
export function localizeDocument(root = document) {
  root.documentElement.lang = translationLocale;
  const attributes = {
    "data-i18n-title": "title",
    "data-i18n-placeholder": "placeholder",
    "data-i18n-aria-label": "aria-label"
  };

  for (const node of root.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.getAttribute("data-i18n") || "");
  }
  for (const [lookup, attribute] of Object.entries(attributes)) {
    for (const node of root.querySelectorAll("[" + lookup + "]")) {
      node.setAttribute(attribute, t(node.getAttribute(lookup) || ""));
    }
  }
}
