// @ts-check
import { t } from "./i18n.js";

// Firefox may suppress window.alert/confirm/prompt for an extension document.
// These dialogs remain available and default to Cancel on Escape.
let queue = Promise.resolve();

/**
 * @param {"confirm"|"prompt"|"message"} kind
 * @param {string} message
 * @param {string} initialValue
 * @param {boolean} danger
 * @returns {Promise<string|boolean|null>}
 */
function present(kind, message, initialValue, danger) {
  const pending = queue.catch(() => {}).then(() => new Promise((resolve, reject) => {
    const dialog = document.createElement("dialog");
    dialog.className = "fwm-dialog";
    dialog.setAttribute("aria-label", t(kind === "prompt" ? "dialogPromptTitle" :
      kind === "message" ? "dialogMessageTitle" : "dialogConfirmTitle"));

    const title = document.createElement("h2");
    title.textContent = t(kind === "prompt" ? "dialogPromptTitle" :
      kind === "message" ? "dialogMessageTitle" : "dialogConfirmTitle");

    const body = document.createElement("p");
    body.className = "fwm-dialog-message";
    body.textContent = message;

    const actions = document.createElement("div");
    actions.className = "fwm-dialog-actions";
    const input = kind === "prompt" ? document.createElement("input") : null;
    if (input) {
      input.type = "text";
      input.className = "fwm-dialog-input";
      input.value = initialValue;
      input.setAttribute("aria-label", t("dialogPromptTitle"));
    }

    let settled = false;
    /** @param {string|boolean|null} value */
    const finish = value => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    };

    const button = (label, className, handler) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = className;
      el.textContent = label;
      el.addEventListener("click", handler);
      actions.appendChild(el);
      return el;
    };

    const cancel = kind === "message" ? null :
      button(t("dialogCancelButton"), "fwm-dialog-cancel", () => finish(null));
    const accept = button(
      t(kind === "message" ? "dialogOkButton" : "dialogConfirmButton"),
      "fwm-dialog-accept" + (danger ? " fwm-dialog-danger" : ""),
      () => finish(kind === "prompt" ? input.value : true)
    );
    dialog.append(title, body);
    if (input) dialog.append(input);
    dialog.append(actions);
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      finish(null);
    });
    dialog.addEventListener("close", () => finish(null));
    if (input) input.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        finish(input.value);
      }
    });
    document.body.append(dialog);
    try {
      dialog.showModal();
      if (input) { input.focus(); input.select(); }
      else (cancel ?? accept).focus();
    } catch (error) {
      dialog.remove();
      reject(error);
    }
  }));
  queue = pending.then(() => {}, () => {});
  return pending;
}

/** @param {string} message @param {{danger?:boolean}} [options] */
export async function confirmDialog(message, options = {}) {
  return await present("confirm", message, "", !!options.danger) === true;
}

/** @param {string} message @param {string} [value] */
export async function promptDialog(message, value = "") {
  const answer = await present("prompt", message, String(value), false);
  return typeof answer === "string" ? answer : null;
}

/** @param {string} message */
export async function messageDialog(message) {
  await present("message", message, "", false);
}
