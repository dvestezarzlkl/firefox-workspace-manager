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
