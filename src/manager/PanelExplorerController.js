// @ts-check

import { PANEL_EXPLORER_STATE_KEY } from "../shared/constants.js";

/**
 * UI-only state for the collapsible Panels explorer.
 *
 * This deliberately never writes into workspace snapshots. Expanded/collapsed
 * state is a manager preference, not browser-session data.
 */
export class PanelExplorerController {
  /**
   * @param {{
   *   root: HTMLElement,
   *   alwaysExpandedInput: HTMLInputElement,
   *   refreshSelect: HTMLSelectElement,
   *   isFilterActive: () => boolean,
   *   reload: () => Promise<void>
   * }} options
   */
  constructor(options) {
    this.root = options.root;
    this.alwaysExpandedInput = options.alwaysExpandedInput;
    this.refreshSelect = options.refreshSelect;
    this.isFilterActive = options.isFilterActive;
    this.reload = options.reload;

    this.state = this.#loadState();
    this.timer = null;
    this.busy = false;

    this.alwaysExpandedInput.checked = this.state.alwaysExpanded;
    this.refreshSelect.value = String(this.state.refreshSeconds);
  }

  #loadState() {
    try {
      const raw = localStorage.getItem(PANEL_EXPLORER_STATE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const refreshSeconds = [0, 5, 10, 30, 60].includes(Number(parsed.refreshSeconds))
        ? Number(parsed.refreshSeconds)
        : 0;

      return {
        windows: new Set(Array.isArray(parsed.windows) ? parsed.windows : []),
        groups: new Set(Array.isArray(parsed.groups) ? parsed.groups : []),
        alwaysExpanded: !!parsed.alwaysExpanded,
        refreshSeconds
      };
    } catch {
      return {
        windows: new Set(),
        groups: new Set(),
        alwaysExpanded: false,
        refreshSeconds: 0
      };
    }
  }

  save() {
    try {
      localStorage.setItem(PANEL_EXPLORER_STATE_KEY, JSON.stringify({
        windows: [...this.state.windows],
        groups: [...this.state.groups],
        alwaysExpanded: this.state.alwaysExpanded,
        refreshSeconds: this.state.refreshSeconds
      }));
    } catch {}
  }

  captureOpenState() {
    if (this.isFilterActive() || this.state.alwaysExpanded) return;

    const windowDetails = this.root.querySelectorAll("details[data-panel-window-key]");
    const groupDetails = this.root.querySelectorAll("details[data-panel-group-key]");
    if (!windowDetails.length && !groupDetails.length) return;

    this.state.windows.clear();
    this.state.groups.clear();

    windowDetails.forEach(details => {
      if (details instanceof HTMLDetailsElement && details.open) {
        this.state.windows.add(details.dataset.panelWindowKey);
      }
    });

    groupDetails.forEach(details => {
      if (details instanceof HTMLDetailsElement && details.open) {
        this.state.groups.add(details.dataset.panelGroupKey);
      }
    });

    this.save();
  }

  /** @param {string} key */
  shouldOpenWindow(key) {
    return this.state.alwaysExpanded || this.state.windows.has(key);
  }

  /** @param {string} key */
  shouldOpenGroup(key) {
    return this.state.alwaysExpanded || this.state.groups.has(key);
  }

  /**
   * @param {browser.windows.Window[]} windows
   * @param {Map<number, browser.tabGroups.TabGroup[]>} groupsByWindow
   */
  expandAll(windows, groupsByWindow) {
    for (const win of windows) {
      this.state.windows.add(String(win.id));

      const groups = groupsByWindow.get(win.id) ?? [];
      for (const group of groups) {
        this.state.groups.add(String(win.id) + ":" + String(group.id));
      }

      if ((win.tabs ?? []).some(tab => tab.groupId == null || tab.groupId === -1)) {
        this.state.groups.add(String(win.id) + ":ungrouped");
      }
    }

    this.save();
  }

  collapseAll() {
    this.state.alwaysExpanded = false;
    this.state.windows.clear();
    this.state.groups.clear();
    this.alwaysExpandedInput.checked = false;
    this.save();
  }

  /** @param {boolean} value */
  setAlwaysExpanded(value) {
    this.state.alwaysExpanded = value;
    this.alwaysExpandedInput.checked = value;
    this.save();
  }

  /** @param {number} seconds */
  setRefreshSeconds(seconds) {
    this.state.refreshSeconds = [0, 5, 10, 30, 60].includes(seconds) ? seconds : 0;
    this.refreshSelect.value = String(this.state.refreshSeconds);
    this.save();
    this.configureAutoRefresh();
  }

  configureAutoRefresh() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const seconds = this.state.refreshSeconds;
    this.refreshSelect.value = String(seconds);
    if (!seconds) return;

    this.timer = setInterval(async () => {
      if (this.busy || document.hidden) return;

      this.busy = true;
      try {
        await this.reload();
      } catch (error) {
        console.error("Panel auto refresh failed", error);
      } finally {
        this.busy = false;
      }
    }, seconds * 1000);
  }

  /** @param {Event} event */
  rememberToggle(event) {
    if (this.isFilterActive() || this.state.alwaysExpanded) return;

    const details = event.target;
    if (!(details instanceof HTMLDetailsElement)) return;

    const windowKey = details.dataset.panelWindowKey;
    const groupKey = details.dataset.panelGroupKey;

    if (windowKey) {
      if (details.open) this.state.windows.add(windowKey);
      else this.state.windows.delete(windowKey);
    }

    if (groupKey) {
      if (details.open) this.state.groups.add(groupKey);
      else this.state.groups.delete(groupKey);
    }

    if (windowKey || groupKey) this.save();
  }
}
