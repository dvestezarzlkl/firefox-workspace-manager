// @ts-check

import {
  ACTIVE_WORKSPACE_KEY,
  APP_RESTORE_PENDING_KEY,
  AUTO_SETTINGS_KEY,
  HOST_POLICIES_KEY,
  HOST_STATS_KEY,
  KNOWN_HOSTS_KEY,
  LAST_ACTIVE_CONTENT_KEY,
  LAST_WORKSPACE_KEY,
  STORAGE_KEY,
  SYNC_ENABLED_KEY,
  TAB_LIFECYCLE_KEY,
  UI_PAGE_KEY,
  URL_POLICIES_KEY,
  WINDOW_WORKSPACE_MAP_KEY,
  WORKSPACES_KEY,
  WORKSPACE_DEBUG_KEY,
  WORKSPACE_SNAPSHOT_LOCK_KEY,
  defaultAutoSettings
} from "../shared/constants.js";

const APPLICATION_BACKUP_FORMAT = "firefox-workspace-manager.application";
const APPLICATION_BACKUP_VERSION = 1;
const VALID_PAGES = new Set(["panels", "workspaces", "settings", "help"]);

/**
 * Durable disaster-recovery backup boundary.
 *
 * Runtime Firefox IDs, active window mappings, lifecycle deadlines and snapshot
 * locks are deliberately not portable. Restore always resets those values and
 * leaves imported workspaces inactive until the user explicitly recovers one.
 */
export class AppBackupService {
  /**
   * Build a complete application backup around the already-portable workspace
   * collection export.
   *
   * @param {Object} options
   * @param {any} options.workspaceCollection
   * @param {{alwaysExpanded?:boolean,refreshSeconds?:number}|null|undefined} [options.panelExplorer]
   * @returns {Promise<any>}
   */
  async exportBackup({ workspaceCollection, panelExplorer = null }) {
    const stored = await browser.storage.local.get([
      WORKSPACES_KEY,
      LAST_WORKSPACE_KEY,
      AUTO_SETTINGS_KEY,
      HOST_POLICIES_KEY,
      URL_POLICIES_KEY,
      SYNC_ENABLED_KEY,
      KNOWN_HOSTS_KEY,
      HOST_STATS_KEY,
      WORKSPACE_DEBUG_KEY,
      UI_PAGE_KEY
    ]);

    const workspaceIds = Object.keys(stored[WORKSPACES_KEY] ?? {});
    const lastWorkspaceId = stored[LAST_WORKSPACE_KEY] ?? null;
    const lastWorkspaceIndex = lastWorkspaceId
      ? workspaceIds.indexOf(lastWorkspaceId)
      : -1;

    return {
      format: APPLICATION_BACKUP_FORMAT,
      version: APPLICATION_BACKUP_VERSION,
      exportedAt: Date.now(),
      extensionVersion: browser.runtime.getManifest().version,
      settings: {
        auto: {
          ...defaultAutoSettings(),
          ...(stored[AUTO_SETTINGS_KEY] ?? {})
        },
        hostPolicies: stored[HOST_POLICIES_KEY] ?? {},
        urlPolicies: Array.isArray(stored[URL_POLICIES_KEY])
          ? stored[URL_POLICIES_KEY]
          : [],
        syncEnabled: !!stored[SYNC_ENABLED_KEY]
      },
      data: {
        workspaces: workspaceCollection,
        knownHosts: Array.isArray(stored[KNOWN_HOSTS_KEY])
          ? stored[KNOWN_HOSTS_KEY]
          : [],
        hostStats: stored[HOST_STATS_KEY] ?? {}
      },
      ui: {
        page: VALID_PAGES.has(stored[UI_PAGE_KEY])
          ? stored[UI_PAGE_KEY]
          : "panels",
        panelExplorer: this.#sanitizePanelExplorer(panelExplorer)
      },
      diagnostics: {
        workspaceDebugLog: Array.isArray(stored[WORKSPACE_DEBUG_KEY])
          ? stored[WORKSPACE_DEBUG_KEY].slice(-200)
          : []
      },
      metadata: {
        lastWorkspaceIndex: lastWorkspaceIndex >= 0 ? lastWorkspaceIndex : null
      }
    };
  }

  /**
   * Validate an application backup before any destructive restore operation.
   *
   * @param {any} payload
   */
  validate(payload) {
    if (
      !payload ||
      payload.format !== APPLICATION_BACKUP_FORMAT ||
      Number(payload.version) !== APPLICATION_BACKUP_VERSION
    ) {
      throw new Error("Unsupported application backup JSON format");
    }

    if (
      !payload.data?.workspaces ||
      payload.data.workspaces.format !== "firefox-workspace-manager.workspaces" ||
      Number(payload.data.workspaces.version) !== 1 ||
      !Array.isArray(payload.data.workspaces.workspaces)
    ) {
      throw new Error("Application backup neobsahuje platnou workspace collection");
    }

    if (!payload.settings || typeof payload.settings !== "object") {
      throw new Error("Application backup neobsahuje nastavení");
    }
  }

  /**
   * Replace durable application data and explicitly invalidate every runtime
   * attachment that is unsafe to carry between Firefox sessions/profiles.
   *
   * The caller must provide freshly rebuilt imported workspaces whose runtime
   * IDs are already detached.
   *
   * @param {any} payload
   * @param {Record<string, any>} restoredWorkspaces
   * @param {string[]} restoredWorkspaceIds Workspace IDs in bundle order.
   * @returns {Promise<{panelExplorer:any,page:string,lastWorkspaceId:string|null}>}
   */
  async restoreBackup(payload, restoredWorkspaces, restoredWorkspaceIds) {
    this.validate(payload);

    const settings = payload.settings ?? {};
    const data = payload.data ?? {};
    const ui = payload.ui ?? {};
    const diagnostics = payload.diagnostics ?? {};
    const now = Date.now();

    const lastIndex = Number(payload.metadata?.lastWorkspaceIndex);
    const lastWorkspaceId = Number.isInteger(lastIndex) &&
      lastIndex >= 0 &&
      lastIndex < restoredWorkspaceIds.length
      ? restoredWorkspaceIds[lastIndex]
      : null;

    const page = VALID_PAGES.has(ui.page) ? ui.page : "panels";

    await browser.storage.local.set({
      [WORKSPACES_KEY]: restoredWorkspaces,
      [LAST_WORKSPACE_KEY]: lastWorkspaceId,
      [ACTIVE_WORKSPACE_KEY]: null,
      [APP_RESTORE_PENDING_KEY]: { at: now, lastWorkspaceId },
      [WINDOW_WORKSPACE_MAP_KEY]: {},
      [STORAGE_KEY]: {
        version: 1,
        windows: {},
        updatedAt: now
      },
      [TAB_LIFECYCLE_KEY]: {},
      [LAST_ACTIVE_CONTENT_KEY]: {},
      [AUTO_SETTINGS_KEY]: {
        ...defaultAutoSettings(),
        ...(settings.auto ?? {})
      },
      [HOST_POLICIES_KEY]:
        settings.hostPolicies && typeof settings.hostPolicies === "object"
          ? settings.hostPolicies
          : {},
      [URL_POLICIES_KEY]: Array.isArray(settings.urlPolicies)
        ? settings.urlPolicies
        : [],
      [SYNC_ENABLED_KEY]: !!settings.syncEnabled,
      [KNOWN_HOSTS_KEY]: Array.isArray(data.knownHosts)
        ? data.knownHosts.slice(-1000)
        : [],
      [HOST_STATS_KEY]:
        data.hostStats && typeof data.hostStats === "object"
          ? data.hostStats
          : {},
      [WORKSPACE_DEBUG_KEY]: Array.isArray(diagnostics.workspaceDebugLog)
        ? diagnostics.workspaceDebugLog.slice(-200)
        : [],
      [UI_PAGE_KEY]: page
    });

    // A persisted restore lock from another profile/session would block future
    // snapshots. It is runtime state and must never survive disaster recovery.
    await browser.storage.local.remove(WORKSPACE_SNAPSHOT_LOCK_KEY);

    return {
      panelExplorer: this.#sanitizePanelExplorer(ui.panelExplorer),
      page,
      lastWorkspaceId
    };
  }

  /**
   * Only stable manager preferences are portable. Expanded window/group keys
   * contain ephemeral Firefox runtime IDs and are intentionally excluded.
   *
   * @param {any} value
   * @returns {{alwaysExpanded:boolean,refreshSeconds:number}}
   */
  #sanitizePanelExplorer(value) {
    const refreshSeconds = [0, 5, 10, 30, 60].includes(
      Number(value?.refreshSeconds)
    )
      ? Number(value.refreshSeconds)
      : 0;

    return {
      alwaysExpanded: !!value?.alwaysExpanded,
      refreshSeconds
    };
  }
}
