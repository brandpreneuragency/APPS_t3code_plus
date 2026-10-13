/**
 * In-memory Default sidebar view. The model view store covers custom
 * workspaces; Default keeps extra filter/shelf fields here so the store
 * worker does not have to own Default-only UI state.
 */

export interface DefaultSidebarViewSnapshot {
  readonly query: string;
  readonly projectScopeKey: string | null;
  readonly scrollTop: number;
  readonly settledVisibleCount: number | null;
  readonly expandedThreadListKeys: readonly string[];
}

const EMPTY_VIEW: DefaultSidebarViewSnapshot = {
  query: "",
  projectScopeKey: null,
  scrollTop: 0,
  settledVisibleCount: null,
  expandedThreadListKeys: [],
};

let snapshot: DefaultSidebarViewSnapshot = EMPTY_VIEW;

export function getDefaultSidebarView(): DefaultSidebarViewSnapshot {
  return snapshot;
}

export function patchDefaultSidebarView(partial: Partial<DefaultSidebarViewSnapshot>): void {
  snapshot = {
    ...snapshot,
    ...partial,
    expandedThreadListKeys: partial.expandedThreadListKeys
      ? [...partial.expandedThreadListKeys]
      : snapshot.expandedThreadListKeys,
  };
}

export function resetDefaultSidebarViewForTests(): void {
  snapshot = EMPTY_VIEW;
}

export function getSidebarScrollViewport(root: ParentNode | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]") ?? null;
}

export function captureSidebarScrollTop(root: ParentNode | null): number {
  return getSidebarScrollViewport(root)?.scrollTop ?? 0;
}

export function restoreSidebarScrollTop(root: ParentNode | null, scrollTop: number): void {
  const viewport = getSidebarScrollViewport(root);
  if (!viewport) return;
  viewport.scrollTop = scrollTop;
}
