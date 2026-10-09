// @ts-check

export const STORAGE_KEY = "fwm.state";
export const LAST_ACTIVE_CONTENT_KEY = "fwm.lastActiveContentTabs";
export const HOST_POLICIES_KEY = "fwm.hostPolicies";
export const KNOWN_HOSTS_KEY = "fwm.knownHosts";
export const URL_POLICIES_KEY = "fwm.urlPolicies";
export const AUTO_SETTINGS_KEY = "fwm.autoSettings";
export const TAB_LIFECYCLE_KEY = "fwm.tabLifecycle";
export const HOST_STATS_KEY = "fwm.hostStats";
export const NEXT_DEEP_ALARM = "fwm.nextDeep";
export const DEEP_WATCHDOG_ALARM = "fwm.deepWatchdog";
export const WORKSPACES_KEY = "fwm.workspaces";
export const WINDOW_WORKSPACE_MAP_KEY = "fwm.windowWorkspaceMap";
export const ACTIVE_WORKSPACE_KEY = "fwm.activeWorkspaceId";
export const LAST_WORKSPACE_KEY = "fwm.lastWorkspaceId";
export const SYNC_ENABLED_KEY = "fwm.sync.enabled";
export const SYNC_KEYS = [AUTO_SETTINGS_KEY, HOST_POLICIES_KEY, URL_POLICIES_KEY];
export const WORKSPACE_DEBUG_KEY = "fwm.workspaceDebugLog";
export const WORKSPACE_SNAPSHOT_LOCK_KEY = "fwm.workspaceSnapshotLock";
export const APP_RESTORE_PENDING_KEY = "fwm.applicationRestorePending";
export const UI_PAGE_KEY = "fwm.ui.page";
export const PANEL_EXPLORER_STATE_KEY = "fwm.panelExplorerState";

export const WORKSPACE_SNAPSHOT_LOCK_TTL_MS = 120_000;
export const HOST_RESULT_LIMIT = 30;

/** @returns {import("../types/domain.js").AutoSettings} */
export function defaultAutoSettings() {
  return {
    minutes: 60,
    deepOnLeave: false,
    protectPinned: true,
    protectAudible: true
  };
}
