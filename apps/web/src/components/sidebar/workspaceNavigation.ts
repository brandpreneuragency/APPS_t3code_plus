/**
 * Explicit custom-workspace row reveal. Route-key effects cannot see
 * same-route hidden search picks or the first navigation from an empty route.
 * Pending intent survives Settings/utility unmounts; a matching mounted
 * section consumes it once when the target row is ready.
 */

export interface WorkspaceThreadRevealDetail {
  readonly workspaceId: string;
  readonly threadKey: string;
  /**
   * Physical project ownership at the time the navigation was requested.
   * Keeping this optional preserves callers that only know the thread ref,
   * while newer callers let detach/move invalidate the exact pending target.
   */
  readonly projectKey?: string;
}

const revealListeners = new Set<(detail: WorkspaceThreadRevealDetail) => void>();
let pendingReveal: WorkspaceThreadRevealDetail | null = null;

export function peekPendingWorkspaceThreadReveal(): WorkspaceThreadRevealDetail | null {
  return pendingReveal;
}

export function requestWorkspaceThreadReveal(detail: WorkspaceThreadRevealDetail): void {
  if (detail.workspaceId.length === 0 || detail.threadKey.length === 0) return;
  pendingReveal =
    detail.projectKey === undefined || detail.projectKey.length === 0
      ? { workspaceId: detail.workspaceId, threadKey: detail.threadKey }
      : detail;
  for (const listener of revealListeners) {
    listener(pendingReveal);
  }
}

export function consumePendingWorkspaceThreadReveal(input: {
  readonly workspaceId: string;
  readonly threadKeys: readonly string[];
}): WorkspaceThreadRevealDetail | null {
  if (pendingReveal == null) return null;
  if (pendingReveal.workspaceId !== input.workspaceId) return null;
  if (!input.threadKeys.includes(pendingReveal.threadKey)) return null;
  const taken = pendingReveal;
  pendingReveal = null;
  return taken;
}

export function invalidateWorkspaceThreadReveal(workspaceId?: string | null): void {
  if (pendingReveal == null) return;
  if (
    workspaceId === undefined ||
    workspaceId === null ||
    pendingReveal.workspaceId === workspaceId
  ) {
    pendingReveal = null;
  }
}

/**
 * Clear a pending reveal when a known project membership mutation removes its
 * target. An older caller without project metadata is invalidated
 * conservatively; a target that is merely offline or still hydrating never
 * reaches this function and therefore keeps its wait intent.
 */
export function invalidateWorkspaceThreadRevealForProject(
  workspaceId: string,
  projectKey: string,
): void {
  if (workspaceId.length === 0 || projectKey.length === 0 || pendingReveal == null) return;
  if (pendingReveal.workspaceId !== workspaceId) return;
  if (pendingReveal.projectKey === undefined || pendingReveal.projectKey === projectKey) {
    pendingReveal = null;
  }
}

/**
 * Route changes that are not the requested thread must cancel the reveal. A
 * route can still be waiting for its draft/session data, so callers should
 * pass the unresolved target only once its scoped thread key is available.
 */
export function invalidateWorkspaceThreadRevealUnless(input: {
  readonly workspaceId: string | null;
  readonly threadKey: string | null;
}): void {
  if (pendingReveal == null) return;
  if (
    input.workspaceId !== null &&
    input.threadKey !== null &&
    pendingReveal.workspaceId === input.workspaceId &&
    pendingReveal.threadKey === input.threadKey
  ) {
    return;
  }
  pendingReveal = null;
}

export function onWorkspaceThreadReveal(
  listener: (detail: WorkspaceThreadRevealDetail) => void,
): () => void {
  revealListeners.add(listener);
  return () => {
    revealListeners.delete(listener);
  };
}
