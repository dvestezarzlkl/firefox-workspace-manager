// @ts-check

import {
  AUTO_SETTINGS_KEY,
  DEEP_WATCHDOG_ALARM,
  HOST_POLICIES_KEY,
  HOST_STATS_KEY,
  LAST_ACTIVE_CONTENT_KEY,
  NEXT_DEEP_ALARM,
  TAB_LIFECYCLE_KEY,
  URL_POLICIES_KEY,
  defaultAutoSettings
} from "../shared/constants.js";
import {
  hostnameFromUrl,
  isExtensionUrl,
  isHttpUrl
} from "../shared/url.js";

/**
 * Owns AUTO / KEEP / DEEP runtime lifecycle state.
 *
 * Workspace persistence is intentionally not handled here. The only bridge to
 * workspace data is the snapshot callback supplied by background.js.
 */
export class TabLifecycleManager {
  /**
   * @param {{
   *   isRestoreActive: () => boolean,
   *   snapshotWindow: (windowId: number) => Promise<unknown>
   * }} options
   */
  constructor(options) {
    this.isRestoreActive = options.isRestoreActive;
    this.snapshotWindow = options.snapshotWindow;

    /** @type {Map<number, number>} */
    this.activeByWindow = new Map();
  }

  async getConfig() {
    const stored = await browser.storage.local.get([
      HOST_POLICIES_KEY,
      URL_POLICIES_KEY,
      AUTO_SETTINGS_KEY
    ]);

    return {
      hostPolicies: stored[HOST_POLICIES_KEY] ?? {},
      urlPolicies: Array.isArray(stored[URL_POLICIES_KEY])
        ? stored[URL_POLICIES_KEY]
        : [],
      auto: {
        ...defaultAutoSettings(),
        ...(stored[AUTO_SETTINGS_KEY] ?? {})
      }
    };
  }

  /**
   * @param {browser.tabs.Tab} tab
   * @param {{hostPolicies: Record<string,string>, urlPolicies: Array<{url?:string, mode?:string}>, auto: import("../types/domain.js").AutoSettings}} config
   */
  resolvePolicy(tab, config) {
    const url = tab.url ?? "";
    if (isExtensionUrl(url)) return "KEEP";

    const urlRule = config.urlPolicies.find(rule => rule?.url === url);
    if (urlRule?.mode) return urlRule.mode;

    const host = hostnameFromUrl(url);
    if (host && config.hostPolicies[host]) return config.hostPolicies[host];
    return "AUTO";
  }

  /**
   * @param {browser.tabs.Tab} tab
   * @param {import("../types/domain.js").AutoSettings} auto
   */
  protectedByRuntime(tab, auto) {
    if (tab.id == null || tab.active || tab.discarded || isExtensionUrl(tab.url)) return true;
    if (auto.protectPinned && tab.pinned) return true;
    if (auto.protectAudible && tab.audible) return true;
    return false;
  }

  /**
   * Read/modify/write lifecycle and statistics atomically from the caller's
   * point of view. browser.storage.local itself has no transaction primitive,
   * therefore every mutation is intentionally short.
   *
   * @param {(lifecycle: Record<string, any>, stats: Record<string, any>) => Promise<void>|void} mutator
   */
  async mutate(mutator) {
    const stored = await browser.storage.local.get([TAB_LIFECYCLE_KEY, HOST_STATS_KEY]);
    const lifecycle = stored[TAB_LIFECYCLE_KEY] ?? {};
    const stats = stored[HOST_STATS_KEY] ?? {};

    await mutator(lifecycle, stats);

    await browser.storage.local.set({
      [TAB_LIFECYCLE_KEY]: lifecycle,
      [HOST_STATS_KEY]: stats
    });
  }

  /**
   * @param {Record<string, any>} stats
   * @param {string|null} host
   */
  ensureHostStats(stats, host) {
    if (!host) return null;

    stats[host] ??= {
      activations: 0,
      totalActiveMs: 0,
      totalInactiveMs: 0,
      firstSeenAt: Date.now(),
      lastActivatedAt: null,
      lastDeactivatedAt: null,
      autoDeepCount: 0
    };

    return stats[host];
  }

  /** @param {browser.tabs.Tab|null|undefined} tab */
  async rememberActiveContentTab(tab) {
    if (!tab || tab.id == null || !isHttpUrl(tab.url)) return;

    const stored = await browser.storage.local.get(LAST_ACTIVE_CONTENT_KEY);
    const map = stored[LAST_ACTIVE_CONTENT_KEY] ?? {};
    map[String(tab.windowId)] = tab.id;

    await browser.storage.local.set({ [LAST_ACTIVE_CONTENT_KEY]: map });
  }

  /** @param {browser.tabs.Tab|null|undefined} tab */
  async markActivated(tab) {
    if (!tab || tab.id == null || !isHttpUrl(tab.url)) return;

    const now = Date.now();
    const host = hostnameFromUrl(tab.url);

    await this.mutate(async (lifecycle, stats) => {
      const key = String(tab.id);
      const previous = lifecycle[key] ?? {};
      const sameActiveVisit = previous.activeSince && previous.url === tab.url;

      if (!sameActiveVisit && previous.inactiveSince && previous.host) {
        const previousStat = this.ensureHostStats(stats, previous.host);
        if (previousStat) {
          previousStat.totalInactiveMs =
            (previousStat.totalInactiveMs || 0) +
            Math.max(0, now - previous.inactiveSince);
        }
      }

      if (!sameActiveVisit && previous.activeSince && previous.host) {
        const previousStat = this.ensureHostStats(stats, previous.host);
        if (previousStat) {
          previousStat.totalActiveMs += Math.max(0, now - previous.activeSince);
          previousStat.lastDeactivatedAt = now;
        }
      }

      lifecycle[key] = {
        ...previous,
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url,
        host,
        activeSince: sameActiveVisit ? previous.activeSince : now,
        inactiveSince: null,
        deadline: null,
        policy: "ACTIVE"
      };

      if (!sameActiveVisit) {
        const hostStat = this.ensureHostStats(stats, host);
        if (hostStat) {
          hostStat.activations += 1;
          hostStat.lastActivatedAt = now;
        }
      }
    });

    await this.rememberActiveContentTab(tab);
  }

  /** @param {browser.tabs.Tab|null|undefined} tab */
  async markInactive(tab) {
    if (!tab || tab.id == null || !isHttpUrl(tab.url)) return;

    const now = Date.now();
    const config = await this.getConfig();
    const policy = this.resolvePolicy(tab, config);
    const host = hostnameFromUrl(tab.url);

    await this.mutate(async (lifecycle, stats) => {
      const key = String(tab.id);
      const previous = lifecycle[key] ?? {};

      if (previous.activeSince) {
        const hostStat = this.ensureHostStats(stats, host);
        if (hostStat) {
          hostStat.totalActiveMs += Math.max(0, now - previous.activeSince);
          hostStat.lastDeactivatedAt = now;
        }
      }

      let deadline = null;
      if (!this.protectedByRuntime(tab, config.auto)) {
        if (policy === "DEEP") {
          deadline = now;
        } else if (policy === "AUTO") {
          deadline = config.auto.deepOnLeave
            ? now
            : now + Math.max(2, Number(config.auto.minutes) || 60) * 60_000;
        }
      }

      lifecycle[key] = {
        ...previous,
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url,
        host,
        activeSince: null,
        inactiveSince: now,
        deadline,
        policy
      };
    });

    await this.scheduleNextDeep();
  }

  /** @param {browser.tabs.Tab|null|undefined} tab */
  async recomputeInactivePolicy(tab) {
    if (this.isRestoreActive()) return;
    if (!tab || tab.id == null || !isHttpUrl(tab.url) || tab.active) return;

    const config = await this.getConfig();
    const policy = this.resolvePolicy(tab, config);
    const host = hostnameFromUrl(tab.url);
    const now = Date.now();

    await this.mutate(async lifecycle => {
      const key = String(tab.id);
      const previous = lifecycle[key] ?? {};
      const inactiveSince = previous.inactiveSince || now;

      let deadline = null;
      if (!this.protectedByRuntime(tab, config.auto)) {
        if (policy === "DEEP") {
          deadline = now;
        } else if (policy === "AUTO") {
          deadline = config.auto.deepOnLeave
            ? now
            : inactiveSince + Math.max(2, Number(config.auto.minutes) || 60) * 60_000;
        }
      }

      lifecycle[key] = {
        ...previous,
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url,
        host,
        activeSince: null,
        inactiveSince,
        deadline,
        policy
      };
    });
  }

  /** @param {{tabId:number, windowId:number}} activeInfo */
  async handleActivation(activeInfo) {
    if (this.isRestoreActive()) return;

    let nextTab;
    try {
      nextTab = await browser.tabs.get(activeInfo.tabId);
    } catch {
      return;
    }

    const previousId = this.activeByWindow.get(activeInfo.windowId);

    // Extension UI is a control surface, not user content. Keep the previous
    // content tab as the logical active tab for lifecycle/statistics.
    if (isExtensionUrl(nextTab.url)) return;

    this.activeByWindow.set(activeInfo.windowId, activeInfo.tabId);

    if (previousId != null && previousId !== activeInfo.tabId) {
      try {
        const previousTab = await browser.tabs.get(previousId);
        if (!isExtensionUrl(previousTab.url)) await this.markInactive(previousTab);
      } catch {}
    }

    await this.markActivated(nextTab);
  }

  async scheduleNextDeep() {
    if (this.isRestoreActive()) return;

    const stored = await browser.storage.local.get(TAB_LIFECYCLE_KEY);
    const lifecycle = stored[TAB_LIFECYCLE_KEY] ?? {};
    const now = Date.now();

    const deadlines = Object.values(lifecycle)
      .map(item => item?.deadline)
      .filter(deadline => Number.isFinite(deadline) && deadline > 0);

    await browser.alarms.clear(NEXT_DEEP_ALARM);
    if (!deadlines.length) return;

    const next = Math.max(now + 1000, Math.min(...deadlines));
    browser.alarms.create(NEXT_DEEP_ALARM, { when: next });
  }

  /**
   * @param {browser.tabs.Tab|null|undefined} tab
   * @param {string} reason
   */
  async discardWithDiagnostics(tab, reason) {
    if (!tab || tab.id == null) return false;

    const attemptAt = Date.now();

    await this.mutate(async lifecycle => {
      const key = String(tab.id);
      lifecycle[key] = {
        ...(lifecycle[key] ?? {}),
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url,
        host: hostnameFromUrl(tab.url),
        lastDiscardAttemptAt: attemptAt,
        lastDiscardReason: reason,
        lastDiscardResult: "pending"
      };
    });

    try {
      await browser.tabs.discard(tab.id);

      let refreshed = null;
      try {
        refreshed = await browser.tabs.get(tab.id);
      } catch {}

      const success = refreshed?.discarded === true;
      const completedAt = Date.now();

      await this.mutate(async lifecycle => {
        const key = String(tab.id);
        lifecycle[key] = {
          ...(lifecycle[key] ?? {}),
          lastDiscardResult: success ? "discarded" : "not-discarded",
          lastDiscardCompletedAt: completedAt,
          discardedAt: success
            ? completedAt
            : lifecycle[key]?.discardedAt ?? null
        };
      });

      return success;
    } catch (error) {
      const completedAt = Date.now();

      await this.mutate(async lifecycle => {
        const key = String(tab.id);
        lifecycle[key] = {
          ...(lifecycle[key] ?? {}),
          lastDiscardResult: "error",
          lastDiscardError: String(error?.message ?? error),
          lastDiscardCompletedAt: completedAt
        };
      });

      console.warn("Discard failed", tab.id, reason, error);
      return false;
    }
  }

  async deepAlwaysWatchdog() {
    if (this.isRestoreActive()) return;

    const config = await this.getConfig();
    const tabs = await browser.tabs.query({});
    const stored = await browser.storage.local.get(TAB_LIFECYCLE_KEY);
    const lifecycle = stored[TAB_LIFECYCLE_KEY] ?? {};

    for (const tab of tabs) {
      if (!isHttpUrl(tab.url) || tab.id == null) continue;

      const policy = this.resolvePolicy(tab, config);
      const item = lifecycle[String(tab.id)];

      if (policy === "DEEP") {
        if (this.protectedByRuntime(tab, config.auto)) continue;
        await this.discardWithDiagnostics(tab, "deep-always-watchdog");
        continue;
      }

      if (policy === "AUTO" && !tab.active && !tab.discarded) {
        if (!item || !item.inactiveSince || !item.deadline || item.url !== tab.url) {
          await this.recomputeInactivePolicy(tab);
        }
      }
    }

    await this.scheduleNextDeep();
  }

  async ensureWatchdogAlarm() {
    const existing = await browser.alarms.get(DEEP_WATCHDOG_ALARM);
    if (!existing) {
      browser.alarms.create(DEEP_WATCHDOG_ALARM, {
        delayInMinutes: 0.5,
        periodInMinutes: 0.5
      });
    }
  }

  async sweepDueTabs() {
    if (this.isRestoreActive()) return;

    const config = await this.getConfig();
    const stored = await browser.storage.local.get([TAB_LIFECYCLE_KEY, HOST_STATS_KEY]);
    const lifecycle = stored[TAB_LIFECYCLE_KEY] ?? {};
    const stats = stored[HOST_STATS_KEY] ?? {};
    const now = Date.now();
    let changed = false;

    for (const [key, item] of Object.entries(lifecycle)) {
      if (!item?.deadline || item.deadline > now) continue;

      let tab;
      try {
        tab = await browser.tabs.get(Number(key));
      } catch {
        delete lifecycle[key];
        changed = true;
        continue;
      }

      const policy = this.resolvePolicy(tab, config);
      if (policy === "KEEP" || this.protectedByRuntime(tab, config.auto)) {
        lifecycle[key].deadline = null;
        lifecycle[key].policy = policy;
        changed = true;
        continue;
      }

      const success = await this.discardWithDiagnostics(
        tab,
        policy === "DEEP" ? "deep-always-deadline" : "auto-deadline"
      );

      lifecycle[key].deadline = success ? null : now + 60_000;
      lifecycle[key].policy = policy;

      if (success) {
        const hostStat = this.ensureHostStats(stats, hostnameFromUrl(tab.url));
        if (hostStat) hostStat.autoDeepCount += 1;
      }

      changed = true;
    }

    if (changed) {
      await browser.storage.local.set({
        [TAB_LIFECYCLE_KEY]: lifecycle,
        [HOST_STATS_KEY]: stats
      });
    }

    await this.scheduleNextDeep();
  }

  async seedRuntimeState() {
    const tabs = await browser.tabs.query({});
    const stored = await browser.storage.local.get(TAB_LIFECYCLE_KEY);
    const lifecycle = stored[TAB_LIFECYCLE_KEY] ?? {};

    for (const tab of tabs) {
      if (tab.id == null || tab.windowId < 0) continue;
      const item = lifecycle[String(tab.id)];

      if (tab.active) {
        if (!isExtensionUrl(tab.url)) {
          this.activeByWindow.set(tab.windowId, tab.id);
        }

        if (isHttpUrl(tab.url) && (!item || !item.activeSince || item.deadline)) {
          await this.markActivated(tab);
        }
        continue;
      }

      if (!isHttpUrl(tab.url)) continue;

      if (!item || item.activeSince || item.url !== tab.url) {
        await this.markInactive(tab);
      }
    }

    await this.scheduleNextDeep();
  }

  /** @param {string} alarmName */
  handleAlarm(alarmName) {
    if (this.isRestoreActive()) return;

    if (alarmName === NEXT_DEEP_ALARM) {
      this.sweepDueTabs().catch(console.error);
    }

    if (alarmName === DEEP_WATCHDOG_ALARM) {
      this.deepAlwaysWatchdog().catch(console.error);
    }
  }

  /**
   * @param {number} tabId
   * @param {{windowId:number, isWindowClosing:boolean}} removeInfo
   */
  async handleTabRemoved(tabId, removeInfo) {
    const stored = await browser.storage.local.get([TAB_LIFECYCLE_KEY, HOST_STATS_KEY]);
    const lifecycle = stored[TAB_LIFECYCLE_KEY] ?? {};
    const stats = stored[HOST_STATS_KEY] ?? {};
    const item = lifecycle[String(tabId)];
    const now = Date.now();

    if (item?.host) {
      const hostStat = this.ensureHostStats(stats, item.host);
      if (hostStat) {
        if (item.activeSince) {
          hostStat.totalActiveMs += Math.max(0, now - item.activeSince);
        }
        if (item.inactiveSince) {
          hostStat.totalInactiveMs =
            (hostStat.totalInactiveMs || 0) +
            Math.max(0, now - item.inactiveSince);
        }
      }
    }

    delete lifecycle[String(tabId)];

    await browser.storage.local.set({
      [TAB_LIFECYCLE_KEY]: lifecycle,
      [HOST_STATS_KEY]: stats
    });

    await this.scheduleNextDeep();

    if (!removeInfo.isWindowClosing) {
      this.snapshotWindow(removeInfo.windowId).catch(console.error);
    }
  }

  /**
   * Lifecycle-only part of a tab update. Workspace snapshot/reattach is handled
   * by background.js because that belongs to a separate domain.
   *
   * @param {number} tabId
   * @param {Record<string, unknown>} changeInfo
   * @param {browser.tabs.Tab} tab
   */
  handleTabUpdated(tabId, changeInfo, tab) {
    if (this.isRestoreActive()) return;

    if (
      "url" in changeInfo ||
      "pinned" in changeInfo ||
      "audible" in changeInfo ||
      "discarded" in changeInfo
    ) {
      const activeId = this.activeByWindow.get(tab.windowId);

      if (activeId === tabId && isHttpUrl(tab.url)) {
        this.markActivated(tab).catch(console.error);
      } else if (!tab.active && isHttpUrl(tab.url)) {
        this.markInactive(tab).catch(console.error);
      }
    }
  }

  async handleSettingsChanged() {
    if (this.isRestoreActive()) return;

    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (!tab.active && isHttpUrl(tab.url)) {
        await this.recomputeInactivePolicy(tab);
      }
    }

    await this.scheduleNextDeep();
    await this.sweepDueTabs();
  }

  /** @param {number} windowId */
  forgetWindow(windowId) {
    this.activeByWindow.delete(windowId);
  }
}
