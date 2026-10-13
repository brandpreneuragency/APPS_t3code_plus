import { useRef, type PointerEvent } from "react";
import { useSidebarWorkspaceStore } from "../../sidebarWorkspaceStore";
import { workspaceSwipeDirection } from "./workspaceSwipe";

export function useWorkspaceSwipe(enabled: boolean) {
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    workspaceId: string | null;
  } | null>(null);

  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (!enabled || !event.isPrimary || event.button !== 0) return;
      if (
        !(event.target instanceof Element) ||
        event.target.closest(
          'button, a, input, textarea, select, [role="button"], [role="menuitem"], [contenteditable], [draggable="true"], [data-testid="workspace-switcher"]',
        )
      )
        return;
      gesture.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        workspaceId: useSidebarWorkspaceStore.getState().selectedWorkspaceId,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      const start = gesture.current;
      if (!start || start.pointerId !== event.pointerId) return;
      gesture.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      if (!enabled) return;
      const direction = workspaceSwipeDirection(event.clientX - start.x, event.clientY - start.y);
      const state = useSidebarWorkspaceStore.getState();
      if (direction === 0 || state.selectedWorkspaceId !== start.workspaceId) return;
      const ids = [null, ...state.workspaces.map((workspace) => workspace.id)];
      const index = ids.indexOf(start.workspaceId);
      const target = ids[index + direction];
      if (index >= 0 && target !== undefined) state.selectWorkspace(target);
    },
    onPointerCancel() {
      gesture.current = null;
    },
    onLostPointerCapture() {
      gesture.current = null;
    },
  };
}
