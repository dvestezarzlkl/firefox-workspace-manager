// @ts-check

/**
 * Shared JSDoc-only domain model.
 *
 * Import these types with:
 *   @typedef {import("../types/domain.js").Workspace} Workspace
 *
 * This file intentionally has no runtime behavior.
 */

/** @typedef {"AUTO"|"KEEP"|"DEEP"} LifecyclePolicy */

/**
 * Minimal Firefox tab shape used by this project.
 * Runtime IDs are intentionally nullable because WebExtension events can
 * expose partially initialized objects.
 *
 * @typedef {Object} BrowserTab
 * @property {number|null|undefined} id
 * @property {number} windowId
 * @property {number} index
 * @property {string|undefined} url
 * @property {string|undefined} title
 * @property {boolean} active
 * @property {boolean} discarded
 * @property {boolean} pinned
 * @property {boolean|undefined} audible
 * @property {boolean|undefined} autoDiscardable
 * @property {string|undefined} cookieStoreId
 * @property {number|undefined} groupId
 */

/**
 * @typedef {Object} BrowserWindow
 * @property {number} id
 * @property {string|undefined} type
 * @property {boolean|undefined} focused
 * @property {boolean} incognito
 * @property {string|undefined} state
 * @property {number|undefined} left
 * @property {number|undefined} top
 * @property {number|undefined} width
 * @property {number|undefined} height
 * @property {BrowserTab[]|undefined} tabs
 */

/**
 * @typedef {Object} BrowserTabGroup
 * @property {number} id
 * @property {number} windowId
 * @property {string|undefined} title
 * @property {string} color
 * @property {boolean} collapsed
 */

/**
 * @typedef {Object} WorkspaceGroup
 * @property {number|null} runtimeGroupId Firefox runtime ID. Ephemeral.
 * @property {string} groupKey Stable key inside one logical window snapshot.
 * @property {string} title
 * @property {string} color
 * @property {boolean} collapsed
 */

/**
 * @typedef {Object} WorkspaceTab
 * @property {number|null} runtimeTabId Firefox runtime ID. Ephemeral.
 * @property {number} index
 * @property {string} url Canonical URL stored by Workspace Manager.
 * @property {string} title
 * @property {boolean} pinned
 * @property {boolean} active
 * @property {boolean} discarded
 * @property {boolean} audible
 * @property {boolean} autoDiscardable
 * @property {string|null} cookieStoreId
 * @property {number|null} runtimeGroupId
 * @property {string|null} groupKey
 */

/**
 * @typedef {Object} WorkspaceWindowGeometry
 * @property {string} state
 * @property {number|null} left
 * @property {number|null} top
 * @property {number|null} width
 * @property {number|null} height
 * @property {boolean} incognito
 */

/**
 * Persistent logical browser window.
 *
 * runtimeWindowId is only a temporary attachment to a currently running
 * Firefox window. fingerprint identifies the saved content.
 *
 * @typedef {Object} WorkspaceWindow
 * @property {string} id
 * @property {boolean} open
 * @property {number|null} runtimeWindowId
 * @property {number|null} closedAt
 * @property {number} updatedAt
 * @property {WorkspaceWindowGeometry} window
 * @property {WorkspaceGroup[]} groups
 * @property {WorkspaceTab[]} tabs
 * @property {1|undefined} [fingerprintVersion]
 * @property {string|undefined} [fingerprint]
 */

/**
 * @typedef {Object} Workspace
 * @property {string} id
 * @property {string} name
 * @property {boolean} persistent
 * @property {boolean} active
 * @property {boolean} open
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number|null} [closedAt]
 * @property {number|undefined} [restoredAt]
 * @property {Record<string, WorkspaceWindow>} windows
 */

/**
 * @typedef {Object} WorkspaceWindowMapping
 * @property {string} workspaceId
 * @property {string} logicalWindowId
 */

/**
 * @typedef {Object} WorkspaceStoreState
 * @property {Record<string, Workspace>} workspaces
 * @property {Record<string, WorkspaceWindowMapping>} windowMap
 * @property {string|null} activeWorkspaceId
 */

/**
 * @typedef {Object} AutoSettings
 * @property {number} minutes
 * @property {boolean} deepOnLeave
 * @property {boolean} protectPinned
 * @property {boolean} protectAudible
 */

/**
 * @typedef {Object} LifecycleEntry
 * @property {number|null|undefined} [deadline]
 * @property {number|null|undefined} [inactiveSince]
 * @property {string|undefined} [reason]
 * @property {number|null|undefined} [lastDiscardAttemptAt]
 * @property {string|null|undefined} [lastDiscardResult]
 * @property {number|null|undefined} [discardedAt]
 */

export {};
