// @ts-check

/**
 * @typedef {Node|string|number|null|undefined|false} HChild
 */

/**
 * @typedef {Object} HProps
 * @property {string} [className]
 * @property {Record<string, string|number|boolean|null|undefined>} [dataset]
 * @property {Record<string, string|number|boolean|null|undefined>} [attrs]
 * @property {string} [id]
 * @property {string} [title]
 * @property {string} [type]
 * @property {string} [value]
 * @property {boolean} [disabled]
 * @property {boolean} [selected]
 * @property {boolean} [open]
 * @property {boolean} [hidden]
 * @property {boolean} [checked]
 */

/**
 * Small HTML/DOM helper used by extension UI renderers.
 *
 * H deliberately creates real DOM nodes instead of parsing HTML strings.
 * Dynamic values therefore become text nodes/properties and cannot accidentally
 * turn into executable markup. Keep this class focused on DOM construction;
 * unrelated application helpers belong in their own modules.
 */
export class H {
  /**
   * Create a typed HTML element, apply common properties and append children.
   *
   * @template {keyof HTMLElementTagNameMap} K
   * @param {K} tag
   * @param {HProps & Record<string, unknown>} [props]
   * @param {...HChild} children
   * @returns {HTMLElementTagNameMap[K]}
   */
  static el(tag, props = {}, ...children) {
    const element = document.createElement(tag);

    for (const [key, value] of Object.entries(props)) {
      if (value == null) continue;

      if (key === "className") {
        element.className = String(value);
        continue;
      }

      if (key === "dataset" && typeof value === "object") {
        for (const [dataKey, dataValue] of Object.entries(value)) {
          if (dataValue == null) continue;
          element.dataset[dataKey] = String(dataValue);
        }
        continue;
      }

      if (key === "attrs" && typeof value === "object") {
        for (const [attrName, attrValue] of Object.entries(value)) {
          if (attrValue == null || attrValue === false) continue;
          element.setAttribute(attrName, attrValue === true ? "" : String(attrValue));
        }
        continue;
      }

      if (key in element) {
        Reflect.set(element, key, value);
      } else {
        element.setAttribute(key, String(value));
      }
    }

    H.append(element, ...children);
    return element;
  }

  /**
   * Create an explicit text node.
   *
   * Most callers can pass strings directly to H.el(); H.txt() is useful when a
   * Text instance is required or when mixed DOM construction reads more clearly.
   *
   * @param {string|number} value
   * @returns {Text}
   */
  static txt(value) {
    return document.createTextNode(String(value));
  }

  /**
   * Append DOM/text children while ignoring nullish/false optional children.
   *
   * @param {Node} parent
   * @param {...HChild} children
   * @returns {Node}
   */
  static append(parent, ...children) {
    for (const child of children) {
      if (child == null || child === false) continue;

      parent.appendChild(
        child instanceof Node
          ? child
          : document.createTextNode(String(child))
      );
    }

    return parent;
  }

  /**
   * Remove all children from an element.
   *
   * @param {Element} element
   * @returns {void}
   */
  static clear(element) {
    element.replaceChildren();
  }

  /**
   * Replace all children with the supplied DOM/text children.
   *
   * @param {Element} element
   * @param {...HChild} children
   * @returns {void}
   */
  static replace(element, ...children) {
    element.replaceChildren();
    H.append(element, ...children);
  }
}
