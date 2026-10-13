import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopedProjectKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { FolderPlusIcon, SearchIcon, SquarePenIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useParams, useRouter } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { useWorkspaceCreation } from "../../hooks/useWorkspaceCreation";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../../keybindings";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { isTerminalFocused } from "../../lib/terminalFocus";
import {
  deriveProviderEntriesByEnvironment,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { useTerminalFocus } from "../../hooks/useTerminalFocus";
import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { useEnvironments } from "../../state/environments";
import { readThreadShell } from "../../state/entities";
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "../../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../../threadRoutes";
import { resolveAdjacentThreadId, useThreadJumpHintVisibility } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarContent, SidebarGroup, SidebarMenuButton, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome";
import { WorkspaceDialog, type WorkspaceDialogMode } from "./WorkspaceDialog";
import { WorkspaceProjectSection } from "./WorkspaceProjectSection";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { getSidebarScrollViewport, restoreSidebarScrollTop } from "./defaultWorkspaceView";
import {
  applyWorkspaceVisibleKeysReport,
  rebuildWorkspaceVisibleOrders,
  staleWorkspaceSelectionKeys,
  type WorkspaceVisibleKeysMaps,
  type WorkspaceVisibleKeysReport,
} from "./workspaceSelection";
import {
  retainEqualStringArray,
  sameStringArrays,
  WORKSPACE_DND_DISTANCE_THRESHOLD,
} from "./workspaceUi";
import {
  EMPTY_SIDEBAR_WORKSPACE_VIEW,
  useSidebarWorkspaceStore,
  useSidebarWorkspaceViewStore,
  workspaceViewStoreKey,
} from "../../sidebarWorkspaceStore";
import { requestWorkspaceThreadReveal } from "./workspaceNavigation";
import {
  createWorkspaceDragState,
  markWorkspaceDragCancel,
  markWorkspaceDragEnd,
  markWorkspaceDragStart,
  type WorkspaceDragState,
} from "./workspaceDrag";

export default function WorkspaceSidebar() {
  const selectedWorkspaceId = useSidebarWorkspaceStore((state) => state.selectedWorkspaceId);
  const workspaces = useSidebarWorkspaceStore((state) => state.workspaces);
  const reorderProjects = useSidebarWorkspaceStore((state) => state.reorderProjects);
  const workspace = workspaces.find((item) => item.id === selectedWorkspaceId) ?? null;
  const viewKey = workspaceViewStoreKey(selectedWorkspaceId);
  const view = useSidebarWorkspaceViewStore(
    (state) => state.views[viewKey] ?? EMPTY_SIDEBAR_WORKSPACE_VIEW,
  );
  const patchView = useSidebarWorkspaceViewStore((state) => state.patchView);
  const { handleWorkspaceNewThread } = useWorkspaceCreation();
  const { environments } = useEnvironments();
  const { isMobile, setOpenMobile } = useSidebar();
  const router = useRouter();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const [dialog, setDialog] = useState<WorkspaceDialogMode | null>(null);
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const projectDragStateRef = useRef<WorkspaceDragState>(createWorkspaceDragState());
  const visibleKeysByProjectRef = useRef(new Map<string, string[]>());
  const draftIdByKeyRef = useRef(new Map<string, DraftId>());
  const projectDraftKeysRef = useRef(new Map<string, string[]>());
  const liveByProjectRef = useRef(new Map<string, boolean>());
  const visibleOrderRef = useRef<string[]>([]);
  const selectionOrderRef = useRef<string[]>([]);
  const [visibleOrder, setVisibleOrder] = useState<string[]>([]);
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();

  const workspaceId = workspace?.id ?? null;
  const query = view.query;
  const isSearching = query.trim().length > 0;

  useEffect(() => {
    clearSelection();
  }, [clearSelection, workspaceId]);

  useLayoutEffect(() => {
    const root = scrollRootRef.current;
    const viewport = getSidebarScrollViewport(root);
    if (root) {
      restoreSidebarScrollTop(root, view.scrollTop);
    }
    return () => {
      if (workspaceId == null) return;
      patchView(workspaceId, { scrollTop: viewport?.scrollTop ?? 0 });
    };
  }, [patchView, view.scrollTop, workspaceId]);

  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = useMemo(
    () => resolveActiveThreadRouteRef(routeTarget, routeDraftThread),
    [routeDraftThread, routeTarget],
  );
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );

  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );
  const providerEntriesByEnvironment = useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...serverConfigs].map(
          ([environmentId, config]) => [environmentId, config.providers] as const,
        ),
      ),
    [serverConfigs],
  );
  const attachedRefs = workspace?.projects ?? [];
  const projectKeys = useMemo(
    () => attachedRefs.map((ref) => scopedProjectKey(ref)),
    [attachedRefs],
  );

  const visibleKeysMapsRef = useRef<WorkspaceVisibleKeysMaps<DraftId>>({
    keysByProject: visibleKeysByProjectRef.current,
    draftIdByKey: draftIdByKeyRef.current,
    projectDraftKeys: projectDraftKeysRef.current,
    liveByProject: liveByProjectRef.current,
  });

  const commitVisibleOrders = useCallback(
    (orders: { visibleOrder: string[]; selectionOrder: string[] }) => {
      selectionOrderRef.current = orders.selectionOrder;
      const nextVisible = retainEqualStringArray(visibleOrderRef.current, orders.visibleOrder);
      visibleOrderRef.current = nextVisible;
      setVisibleOrder((previous) =>
        sameStringArrays(previous, nextVisible) ? previous : nextVisible,
      );
      const stale = staleWorkspaceSelectionKeys({
        selectedKeys: [...useThreadSelectionStore.getState().selectedThreadKeys],
        selectionOrder: orders.selectionOrder,
      });
      if (stale.length > 0) {
        useThreadSelectionStore.getState().removeFromSelection(stale);
      }
    },
    [],
  );

  const handleVisibleKeys = useCallback(
    (projectKey: string, report: WorkspaceVisibleKeysReport<DraftId>) => {
      commitVisibleOrders(
        applyWorkspaceVisibleKeysReport(
          visibleKeysMapsRef.current,
          projectKeys,
          projectKey,
          report,
        ),
      );
    },
    [commitVisibleOrders, projectKeys],
  );

  useEffect(() => {
    commitVisibleOrders(rebuildWorkspaceVisibleOrders(visibleKeysMapsRef.current, projectKeys));
  }, [commitVisibleOrders, projectKeys]);

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (workspaceId) {
        const thread = readThreadShell(threadRef);
        const projectKey = thread
          ? scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId))
          : undefined;
        requestWorkspaceThreadReveal({
          workspaceId,
          threadKey: scopedThreadKey(threadRef),
          ...(projectKey ? { projectKey } : {}),
        });
      }
      clearSelection();
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) setOpenMobile(false);
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor, workspaceId],
  );

  const navigateToDraft = useCallback(
    (draftId: DraftId) => {
      const session = useComposerDraftStore.getState().getDraftSession(draftId);
      if (workspaceId && session) {
        requestWorkspaceThreadReveal({
          workspaceId,
          threadKey: scopedThreadKey(scopeThreadRef(session.environmentId, session.threadId)),
          projectKey: scopedProjectKey(scopeProjectRef(session.environmentId, session.projectId)),
        });
      }
      clearSelection();
      if (isMobile) setOpenMobile(false);
      void router.navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(draftId),
      });
    },
    [clearSelection, isMobile, router, setOpenMobile, workspaceId],
  );

  const navigateToVisibleKey = useCallback(
    (key: string | null) => {
      if (!key) return false;
      const draftId = draftIdByKeyRef.current.get(key);
      if (draftId) {
        navigateToDraft(draftId);
        return true;
      }
      const parsed = parseScopedThreadKey(key);
      if (!parsed) return false;
      navigateToThread(parsed);
      return true;
    },
    [navigateToDraft, navigateToThread],
  );

  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform: navigator.platform,
      context: {
        terminalFocus: terminalFocused,
        terminalOpen: routeTerminalOpen,
        modelPickerOpen: isModelPickerOpen(),
      },
    },
  );
  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow, updateThreadJumpHintsVisibility]);

  const jumpLabelByKey = useMemo(() => {
    if (!showThreadJumpHints) return new Map<string, string>();
    const labels = new Map<string, string>();
    visibleOrder.forEach((key, index) => {
      const command = threadJumpCommandForIndex(index);
      if (command) labels.set(key, String(index + 1));
    });
    return labels;
  }, [showThreadJumpHints, visibleOrder]);

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      const ordered = visibleOrderRef.current;
      const navigateToKey = (targetKey: string | null) => {
        if (!navigateToVisibleKey(targetKey)) return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
      };
      const traversal = threadTraversalDirectionFromCommand(command);
      if (traversal !== null) {
        navigateToKey(
          resolveAdjacentThreadId({
            threadIds: ordered,
            currentThreadId: routeThreadKey,
            direction: traversal,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) return;
      navigateToKey(ordered[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [keybindings, navigateToVisibleKey, routeTerminalOpen, routeThreadKey]);

  const projectSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: WORKSPACE_DND_DISTANCE_THRESHOLD },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      markWorkspaceDragEnd(projectDragStateRef.current);
      if (workspaceId == null) return;
      const overId = event.over?.id;
      if (typeof event.active.id !== "string" || typeof overId !== "string") return;
      if (event.active.id === overId) return;
      const from = projectKeys.indexOf(event.active.id);
      const to = projectKeys.indexOf(overId);
      if (from === -1 || to === -1) return;
      reorderProjects(workspaceId, arrayMove(projectKeys, from, to));
    },
    [projectKeys, reorderProjects, workspaceId],
  );
  const handleProjectDragStart = useCallback(() => {
    markWorkspaceDragStart(projectDragStateRef.current);
  }, []);
  const handleProjectDragCancel = useCallback(() => {
    markWorkspaceDragCancel(projectDragStateRef.current);
  }, []);

  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.new") ??
    shortcutLabelForCommand(keybindings, "chat.newLocal");

  const handleSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (workspaceId) patchView(workspaceId, { query: "" });
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
      const keys = visibleOrderRef.current;
      if (keys.length === 0) return;
      if (event.key === "Enter") {
        event.preventDefault();
        const key = keys[activeSearchIndex] ?? keys[0];
        if (!key) return;
        navigateToVisibleKey(key);
        if (workspaceId) patchView(workspaceId, { query: "" });
        return;
      }
      event.preventDefault();
      setActiveSearchIndex((index) => {
        if (event.key === "ArrowDown") return Math.min(keys.length - 1, index + 1);
        return Math.max(0, index - 1);
      });
    },
    [activeSearchIndex, navigateToVisibleKey, patchView, workspaceId],
  );

  if (workspaceId == null || workspace == null) {
    return null;
  }

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <div ref={scrollRootRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SidebarContent
          className="gap-0"
          fixedHeader={
            <SidebarGroup className="relative z-[1] gap-1 p-[var(--sidebar-content-inset)]">
              <div className="flex h-7 min-w-0 items-center gap-1">
                <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium text-sidebar-foreground">
                  {workspace.name}
                </span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <SidebarMenuButton
                        size="icon"
                        type="button"
                        aria-label="Add project"
                        onClick={() => setDialog({ type: "attach", workspaceId })}
                      />
                    }
                  >
                    <FolderPlusIcon />
                  </TooltipTrigger>
                  <TooltipPopup side="right">Add project</TooltipPopup>
                </Tooltip>
              </div>
              <div className="flex items-center gap-1">
                <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
                  <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
                  <Input
                    ref={searchInputRef}
                    nativeInput
                    unstyled
                    type="search"
                    value={query}
                    onChange={(event) =>
                      patchView(workspaceId, { query: event.currentTarget.value })
                    }
                    onKeyDown={handleSearchKeyDown}
                    placeholder="Search"
                    aria-label="Search workspace threads"
                    className="min-w-0 flex-1 [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:font-medium [&_[data-slot=input]]:text-sidebar-foreground [&_[data-slot=input]]:placeholder:text-sidebar-muted-foreground"
                  />
                  {isSearching ? (
                    <Button
                      type="button"
                      size="icon-micro"
                      variant="ghost"
                      aria-label="Clear thread search"
                      onClick={() => patchView(workspaceId, { query: "" })}
                    >
                      <XIcon className="size-3" />
                    </Button>
                  ) : null}
                </div>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <SidebarMenuButton
                        size="icon"
                        type="button"
                        aria-label="New Chat"
                        onClick={(event) => {
                          void handleWorkspaceNewThread(event.shiftKey);
                        }}
                      />
                    }
                  >
                    <SquarePenIcon />
                  </TooltipTrigger>
                  <TooltipPopup side="right">
                    {newThreadShortcutLabel ? `New Chat (${newThreadShortcutLabel})` : "New Chat"}
                  </TooltipPopup>
                </Tooltip>
              </div>
            </SidebarGroup>
          }
        >
          <SidebarGroup className="ps-[calc(var(--sidebar-content-inset)+1px)] pe-[var(--sidebar-content-inset)] pb-1 pt-0">
            <TooltipProvider delay={150} closeDelay={0} timeout={400}>
              {attachedRefs.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
                  <span>No projects in this workspace</span>
                  <button
                    type="button"
                    onClick={() => setDialog({ type: "attach", workspaceId })}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-[11px] font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    Add project
                  </button>
                </div>
              ) : (
                <DndContext
                  sensors={projectSensors}
                  collisionDetection={closestCenter}
                  modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
                  onDragStart={handleProjectDragStart}
                  onDragEnd={handleProjectDragEnd}
                  onDragCancel={handleProjectDragCancel}
                >
                  <SortableContext items={projectKeys} strategy={verticalListSortingStrategy}>
                    <div className="flex flex-col gap-1">
                      {attachedRefs.map((ref) => {
                        const projectKey = scopedProjectKey(ref);
                        const environment = environmentById.get(ref.environmentId);
                        const connected = environment?.connection.phase === "connected";
                        const providerMap =
                          providerEntriesByEnvironment.get(ref.environmentId) ?? EMPTY_PROVIDER_MAP;
                        return (
                          <WorkspaceProjectSection
                            key={projectKey}
                            workspaceId={workspaceId}
                            projectRef={ref}
                            searchQuery={query}
                            routeThreadKey={routeThreadKey}
                            routeDraftId={routeDraftId}
                            jumpLabelByKey={jumpLabelByKey}
                            visibleOrderRef={visibleOrderRef}
                            selectionOrderRef={selectionOrderRef}
                            draftIdByKeyRef={draftIdByKeyRef}
                            projectDragState={projectDragStateRef.current}
                            environmentConnected={connected}
                            environmentLabel={environment?.label ?? null}
                            newThreadShortcutLabel={newThreadShortcutLabel}
                            providerEntries={providerMap}
                            onNavigateThread={navigateToThread}
                            onNavigateDraft={navigateToDraft}
                            onVisibleKeys={handleVisibleKeys}
                          />
                        );
                      })}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </TooltipProvider>
          </SidebarGroup>
        </SidebarContent>
      </div>
      <SidebarChromeFooter switcher={<WorkspaceSwitcher />} />
      <WorkspaceDialog mode={dialog} onClose={() => setDialog(null)} />
    </>
  );
}

const EMPTY_PROVIDER_MAP: ReadonlyMap<string, ProviderInstanceEntry> = new Map();
