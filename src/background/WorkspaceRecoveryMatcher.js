// @ts-check

/**
 * @typedef {{workspaceId:string,logicalWindowId:string,fingerprint:string}} SavedWindowRef
 * @typedef {{runtimeWindowId:number,fingerprint:string}} LiveWindowRef
 */

/**
 * Select a complete, unambiguous one-to-one match between a stored workspace
 * and *currently* open Firefox windows.
 *
 * This is intentionally stricter than the runtime reattach scoring fallback:
 * application backup restoration must NEVER claim a modified, unrelated or
 * duplicated window silently. If even one window is missing or if a fingerprint
 * appears twice on either side, the entire workspace stays detached.
 *
 * Empty/extension-only windows must be removed by the caller before matching.
 *
 * @param {SavedWindowRef[]} savedWindows
 * @param {LiveWindowRef[]} liveWindows
 * @param {string|null} preferredWorkspaceId
 * @returns {{workspaceId:string,matches:Array<{logicalWindowId:string,runtimeWindowId:number}>}|null}
 */
export function matchCompleteWorkspace(savedWindows, liveWindows, preferredWorkspaceId = null) {
  /** @type {Map<string,SavedWindowRef[]>} */
  const bySavedFingerprint = new Map();
  /** @type {Map<string,LiveWindowRef[]>} */
  const byLiveFingerprint = new Map();

  for (const saved of savedWindows) {
    if (!saved.fingerprint) continue;
    const entries = bySavedFingerprint.get(saved.fingerprint) ?? [];
    entries.push(saved);
    bySavedFingerprint.set(saved.fingerprint, entries);
  }

  for (const live of liveWindows) {
    if (!live.fingerprint) continue;
    const entries = byLiveFingerprint.get(live.fingerprint) ?? [];
    entries.push(live);
    byLiveFingerprint.set(live.fingerprint, entries);
  }

  /** @type {Map<string,SavedWindowRef[]>} */
  const workspaceWindows = new Map();
  for (const saved of savedWindows) {
    const entries = workspaceWindows.get(saved.workspaceId) ?? [];
    entries.push(saved);
    workspaceWindows.set(saved.workspaceId, entries);
  }

  const complete = [];

  for (const [workspaceId, entries] of workspaceWindows) {
    if (!entries.length) continue;

    const matches = [];
    for (const entry of entries) {
      const savedCandidates = bySavedFingerprint.get(entry.fingerprint) ?? [];
      const liveCandidates = byLiveFingerprint.get(entry.fingerprint) ?? [];
      if (savedCandidates.length !== 1 || liveCandidates.length !== 1) break;

      matches.push({
        logicalWindowId: entry.logicalWindowId,
        runtimeWindowId: liveCandidates[0].runtimeWindowId
      });
    }

    if (matches.length === entries.length) {
      complete.push({ workspaceId, matches });
    }
  }

  if (!complete.length) return null;
  if (complete.length === 1) return complete[0];

  // A full application backup may describe multiple old workspaces, but only
  // the last-used workspace is an eligible default in this ambiguous case.
  // Never infer a different workspace just because of enumeration order.
  if (preferredWorkspaceId) {
    return complete.find(item => item.workspaceId === preferredWorkspaceId) ?? null;
  }

  return null;
}
