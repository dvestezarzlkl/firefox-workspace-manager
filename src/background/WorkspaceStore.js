// @ts-check

import {
  ACTIVE_WORKSPACE_KEY,
  LAST_WORKSPACE_KEY,
  WORKSPACES_KEY,
  WINDOW_WORKSPACE_MAP_KEY,
  WORKSPACE_DEBUG_KEY,
  WORKSPACE_SNAPSHOT_LOCK_KEY,
  WORKSPACE_SNAPSHOT_LOCK_TTL_MS
} from "../shared/constants.js";

/** @typedef {import("../types/domain.js").WorkspaceStoreState} WorkspaceStoreState */

/**
 * Persistence boundary for workspace metadata.
 *
 * Restore/lifecycle orchestration stays outside this class. This class owns
 * durable workspace records, the runtime-window mapping, snapshot locking and
 * structured debug logging.
 */
export class WorkspaceStore {
  newWorkspaceId() {
    return crypto.randomUUID();
  }

  newLogicalWindowId() {
    return crypto.randomUUID();
  }

  /**
   * @param {string} event
   * @param {Record<string, unknown>} [data]
   */
  async debug(event, data = {}) {
    const stored = await browser.storage.local.get(WORKSPACE_DEBUG_KEY);
    const log = Array.isArray(stored[WORKSPACE_DEBUG_KEY])
      ? stored[WORKSPACE_DEBUG_KEY]
      : [];

    log.push({ at: Date.now(), event, data });

    await browser.storage.local.set({
      [WORKSPACE_DEBUG_KEY]: log.slice(-200)
    });
  }

  /**
   * @param {number} restoreDepth
   */
  async snapshotLocked(restoreDepth) {
    if (restoreDepth > 0) return true;

    const stored = await browser.storage.local.get(WORKSPACE_SNAPSHOT_LOCK_KEY);
    const lock = stored[WORKSPACE_SNAPSHOT_LOCK_KEY];
    if (!lock) return false;

    const acquiredAt = Number(lock.acquiredAt) || 0;
    if (Date.now() - acquiredAt > WORKSPACE_SNAPSHOT_LOCK_TTL_MS) {
      await browser.storage.local.remove(WORKSPACE_SNAPSHOT_LOCK_KEY);
      return false;
    }

    return true;
  }

  /**
   * @param {string} workspaceId
   * @param {string} [reason]
   */
  async acquireSnapshotLock(workspaceId, reason = "restore") {
    const lock = { workspaceId, reason, acquiredAt: Date.now() };
    await browser.storage.local.set({ [WORKSPACE_SNAPSHOT_LOCK_KEY]: lock });
    await this.debug("snapshot-lock-acquired", lock);
  }

  /** @param {string|null|undefined} workspaceId */
  async releaseSnapshotLock(workspaceId) {
    const stored = await browser.storage.local.get(WORKSPACE_SNAPSHOT_LOCK_KEY);
    const lock = stored[WORKSPACE_SNAPSHOT_LOCK_KEY];
    if (!lock) return;
    if (workspaceId && lock.workspaceId && lock.workspaceId !== workspaceId) return;

    await browser.storage.local.remove(WORKSPACE_SNAPSHOT_LOCK_KEY);
    await this.debug("snapshot-lock-released", {
      workspaceId: workspaceId ?? lock.workspaceId ?? null
    });
  }

  /** @param {Record<string, import("../types/domain.js").Workspace>} workspaces */
  normalizeGroupKeys(workspaces) {
    let changed = false;

    for (const workspace of Object.values(workspaces ?? {})) {
      for (const win of Object.values(workspace?.windows ?? {})) {
        const groups = win.groups ?? [];
        const tabs = win.tabs ?? [];
        const keyByRuntimeId = new Map();

        groups.forEach((group, index) => {
          if (!group.groupKey) {
            group.groupKey = "g" + index;
            changed = true;
          }
          keyByRuntimeId.set(group.runtimeGroupId, group.groupKey);
        });

        for (const tab of tabs) {
          // groupKey:null means intentionally ungrouped. Never reinterpret it
          // through a stale Firefox runtimeGroupId.
          if (Object.prototype.hasOwnProperty.call(tab, "groupKey")) continue;

          const key = keyByRuntimeId.get(tab.runtimeGroupId);
          tab.groupKey = key ?? null;
          changed = true;
        }
      }
    }

    return changed;
  }

  /**
   * Load the canonical workspace store and migrate the pre-multi-window model
   * if an old profile is encountered.
   *
   * @returns {Promise<WorkspaceStoreState>}
   */
  async load() {
    const stored = await browser.storage.local.get([
      WORKSPACES_KEY,
      WINDOW_WORKSPACE_MAP_KEY,
      ACTIVE_WORKSPACE_KEY
    ]);

    let workspaces = stored[WORKSPACES_KEY] ?? {};
    let windowMap = stored[WINDOW_WORKSPACE_MAP_KEY] ?? {};
    let activeWorkspaceId = stored[ACTIVE_WORKSPACE_KEY] ?? null;

    const legacy = Object.values(workspaces)
      .filter(workspace => workspace && !workspace.windows && workspace.window);

    if (legacy.length) {
      const mergedId = this.newWorkspaceId();
      const merged = {
        id: mergedId,
        name: legacy[0]?.name || "Workspace 1",
        persistent: true,
        active: false,
        open: false,
        createdAt: Math.min(...legacy.map(workspace => workspace.createdAt || Date.now())),
        updatedAt: Date.now(),
        windows: {}
      };

      /** @type {Record<string, import("../types/domain.js").WorkspaceWindowMapping>} */
      const newMap = {};

      for (const workspace of legacy) {
        const logicalWindowId = this.newLogicalWindowId();
        merged.windows[logicalWindowId] = {
          id: logicalWindowId,
          open: !!workspace.open,
          runtimeWindowId: workspace.runtimeWindowId ?? null,
          closedAt: workspace.closedAt ?? null,
          updatedAt: workspace.updatedAt ?? Date.now(),
          window: workspace.window ?? {},
          groups: workspace.groups ?? [],
          tabs: workspace.tabs ?? []
        };

        if (workspace.runtimeWindowId != null) {
          newMap[String(workspace.runtimeWindowId)] = {
            workspaceId: mergedId,
            logicalWindowId
          };
        }
      }

      workspaces = { [mergedId]: merged };
      windowMap = newMap;
      activeWorkspaceId = Object.values(merged.windows).some(win => win.open)
        ? mergedId
        : null;

      merged.open = !!activeWorkspaceId;
      merged.active = !!activeWorkspaceId;

      await browser.storage.local.set({
        [WORKSPACES_KEY]: workspaces,
        [WINDOW_WORKSPACE_MAP_KEY]: windowMap,
        [ACTIVE_WORKSPACE_KEY]: activeWorkspaceId,
        ...(activeWorkspaceId ? { [LAST_WORKSPACE_KEY]: activeWorkspaceId } : {})
      });
    }

    if (this.normalizeGroupKeys(workspaces)) {
      await browser.storage.local.set({ [WORKSPACES_KEY]: workspaces });
    }

    return { workspaces, windowMap, activeWorkspaceId };
  }

  /**
   * Return the active workspace, creating the very first workspace (or an
   * explicitly requested one) only when allowed.
   *
   * @param {{allowCreate?: boolean}} [options]
   * @returns {Promise<WorkspaceStoreState>}
   */
  async ensureActive(options = {}) {
    const { allowCreate = false } = options;
    const store = await this.load();
    let { workspaces, windowMap, activeWorkspaceId } = store;

    if (activeWorkspaceId && workspaces[activeWorkspaceId]) return store;

    const firstEverWorkspace = Object.keys(workspaces).length === 0;
    if (!allowCreate && !firstEverWorkspace) {
      return { workspaces, windowMap, activeWorkspaceId: null };
    }

    activeWorkspaceId = this.newWorkspaceId();
    workspaces[activeWorkspaceId] = {
      id: activeWorkspaceId,
      name: "Workspace " + (Object.keys(workspaces).length + 1),
      persistent: true,
      active: true,
      open: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      windows: {}
    };

    await browser.storage.local.set({
      [WORKSPACES_KEY]: workspaces,
      [ACTIVE_WORKSPACE_KEY]: activeWorkspaceId,
      [LAST_WORKSPACE_KEY]: activeWorkspaceId
    });

    await this.debug("workspace-created", {
      workspaceId: activeWorkspaceId,
      reason: firstEverWorkspace ? "first-ever" : "explicit"
    });

    return { workspaces, windowMap, activeWorkspaceId };
  }
}
