/**
 * Small, per-DndContext guards for the clickable surface of workspace rows.
 *
 * dnd-kit finishes a drag before the browser dispatches the pointer click that
 * followed the pointerup. Keeping the guard outside React state lets the
 * release event be rejected even when the row has already re-rendered. A
 * pointerdown starts a new gesture and clears the previous release guard;
 * keyboard release is consumed once by the next keyboard event.
 */

export interface WorkspaceDragState {
  active: boolean;
  suppressClick: boolean;
  suppressKeyboard: boolean;
}

export function createWorkspaceDragState(): WorkspaceDragState {
  return {
    active: false,
    suppressClick: false,
    suppressKeyboard: false,
  };
}

export function markWorkspaceDragStart(state: WorkspaceDragState): void {
  state.active = true;
  state.suppressClick = false;
  state.suppressKeyboard = false;
}

export function markWorkspaceDragEnd(state: WorkspaceDragState): void {
  state.active = false;
  state.suppressClick = true;
  state.suppressKeyboard = true;
}

export function markWorkspaceDragCancel(state: WorkspaceDragState): void {
  markWorkspaceDragEnd(state);
}

/** Clear guards only when a new pointer gesture begins. */
export function clearWorkspacePointerGuard(state: WorkspaceDragState): void {
  if (state.active) return;
  state.suppressClick = false;
  state.suppressKeyboard = false;
}

/**
 * A keyboard gesture has no pointerdown to clear a previous release guard.
 * Capture the next fresh keydown before dnd-kit's listener runs. During an
 * active keyboard drag this is a no-op, so the release key still gets guarded.
 */
export function prepareWorkspaceKeyboardGesture(state: WorkspaceDragState): void {
  if (state.active) return;
  state.suppressClick = false;
  state.suppressKeyboard = false;
}

/** Return true when the current click belongs to a drag release. */
export function consumeWorkspaceClickGuard(state: WorkspaceDragState): boolean {
  if (state.active) return true;
  if (!state.suppressClick) return false;
  state.suppressClick = false;
  return true;
}

/** Return true for the one keyboard activation caused by drag release. */
export function consumeWorkspaceKeyboardGuard(state: WorkspaceDragState): boolean {
  if (state.active) return true;
  if (!state.suppressKeyboard) return false;
  state.suppressKeyboard = false;
  return true;
}
