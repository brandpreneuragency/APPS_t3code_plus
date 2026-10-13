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
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ChevronRightIcon, FolderIcon, SquarePenIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import {
  composerDraftHasUserContent,
  DraftId,
  useComposerDraftStore,
  type DraftSessionState,
} from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useLegacySidebarEnabled,
} from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { releaseComposerDraftUploads } from "../../lib/composerDraftUploads";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  readProject,
  readThreadShell,
  useProject,
  useThreadShellsForProjectRefs,
} from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { snoozeWakeLabel } from "../Sidebar.snooze";
import { threadChangeRequestSnapshotsAtom } from "../ThreadStatusIndicators";
import { ProjectFavicon } from "../ProjectFavicon";
import { SidebarMenuButton } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceDraftRow,
  WorkspaceThreadRow,
  isWorkspaceRowModClick,
} from "./WorkspaceThreadRow";
import { useWorkspaceThreadMenu } from "./workspaceThreadMenu";
import {
  evaluateWorkspaceBulkProject,
  resolveWorkspaceBulkSelection,
  workspaceThreadPointerAction,
  type WorkspaceVisibleKeysReport,
} from "./workspaceSelection";
import {
  consumePendingWorkspaceThreadReveal,
  onWorkspaceThreadReveal,
} from "./workspaceNavigation";
import {
  EMPTY_THREAD_ORDER,
  matchingChangeRequestFromSnapshot,
  parseWorkspaceThreadDragId,
  sameStringArrays,
  searchNavigationReveal,
  seedDefaultDisplayOrderKeys,
  WORKSPACE_DND_DISTANCE_THRESHOLD,
  workspaceThreadOrderSeedDecision,
  workspaceThreadDragId,
} from "./workspaceUi";
import {
  clearWorkspacePointerGuard,
  consumeWorkspaceClickGuard,
  createWorkspaceDragState,
  markWorkspaceDragCancel,
  markWorkspaceDragEnd,
  markWorkspaceDragStart,
  prepareWorkspaceKeyboardGesture,
  type WorkspaceDragState,
} from "./workspaceDrag";
import {
  applyDraftPromotionToOrder,
  buildWorkspaceProjectThreadView,
  classifyWorkspaceThread,
  isWorkspaceSearchActive,
  nextSettledVisibleLimit,
  planWorkspaceThreadDrag,
  reconcileCanonicalThreadOrder,
  resetSettledVisibleLimit,
  resolveWorkspaceProjectPresentation,
  seedCanonicalThreadOrder,
  shouldIncludeWorkspaceDraft,
} from "../../sidebarWorkspaceModel";
import {
  EMPTY_SIDEBAR_WORKSPACE_VIEW,
  resolveFolderExpanded,
  resolveSettledLimitForProject,
  useSidebarWorkspaceStore,
  useSidebarWorkspaceViewStore,
  workspaceViewStoreKey,
} from "../../sidebarWorkspaceStore";

export const WorkspaceProjectSection = memo(function WorkspaceProjectSection(props: {
  readonly workspaceId: string;
  readonly projectRef: ScopedProjectRef;
  readonly searchQuery: string;
  readonly routeThreadKey: string | null;
  readonly routeDraftId: string | null;
  readonly jumpLabelByKey: ReadonlyMap<string, string>;
  readonly visibleOrderRef: { current: string[] };
  readonly selectionOrderRef: { current: string[] };
  readonly draftIdByKeyRef: { current: ReadonlyMap<string, DraftId> };
  readonly projectDragState: WorkspaceDragState;
  readonly environmentConnected: boolean;
  readonly environmentLabel: string | null;
  readonly newThreadShortcutLabel: string | null | undefined;
  readonly providerEntries: ReadonlyMap<string, ProviderInstanceEntry>;
  readonly onNavigateThread: (threadRef: ScopedThreadRef) => void;
  readonly onNavigateDraft: (draftId: DraftId) => void;
  readonly onVisibleKeys: (projectKey: string, report: WorkspaceVisibleKeysReport<DraftId>) => void;
}) {
  const projectKey = scopedProjectKey(props.projectRef);
  const projectRefs = useMemo(
    () => [props.projectRef],
    [props.projectRef.environmentId, props.projectRef.projectId],
  );
  const project = useProject(props.projectRef);
  const lastKnown = useSidebarWorkspaceStore(
    (state) => state.projectStateByKey[projectKey]?.lastKnown ?? null,
  );
  const threadOrder = useSidebarWorkspaceStore(
    (state) => state.projectStateByKey[projectKey]?.threadOrder ?? EMPTY_THREAD_ORDER,
  );
  const expanded = useSidebarWorkspaceStore((state) =>
    resolveFolderExpanded(state.expandedByWorkspaceId, props.workspaceId, projectKey),
  );
  const setExpanded = useSidebarWorkspaceStore((state) => state.setExpanded);
  const setThreadOrder = useSidebarWorkspaceStore((state) => state.setThreadOrder);
  const updateLastKnown = useSidebarWorkspaceStore((state) => state.updateLastKnown);
  const detachProject = useSidebarWorkspaceStore((state) => state.detachProject);
  const viewKey = workspaceViewStoreKey(props.workspaceId);
  const view = useSidebarWorkspaceViewStore(
    (state) => state.views[viewKey] ?? EMPTY_SIDEBAR_WORKSPACE_VIEW,
  );
  const patchView = useSidebarWorkspaceViewStore((state) => state.patchView);
  const shells = useThreadShellsForProjectRefs(projectRefs);
  const environmentShellState = useAtomValue(
    environmentShell.stateValueAtom(props.projectRef.environmentId),
  );
  const environmentShellBootstrapped = environmentShellState.status === "live";
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const changeRequestSnapshotByKey = useAtomValue(threadChangeRequestSnapshotsAtom);
  const handleNewThread = useNewThreadHandler();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const autoSettleOnMerge = useClientSettings((settings) => settings.sidebarAutoSettleOnMerge);
  const sidebarThreadSortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const settingsHydrated = useClientSettingsHydrated();
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const nowMinute = useNowMinute();
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const threadDragStateRef = useRef<WorkspaceDragState>(createWorkspaceDragState());
  const presentation = resolveWorkspaceProjectPresentation({
    live: project
      ? {
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          environmentLabel: props.environmentLabel,
        }
      : null,
    lastKnown,
    connected: props.environmentConnected,
  });
  const title = presentation.title.length > 0 ? presentation.title : "Project";
  const workspaceRoot = presentation.workspaceRoot;
  const environmentLabel = presentation.environmentLabel;
  const live = presentation.availability === "live";
  const settledLimit = resolveSettledLimitForProject(view, projectKey);
  const snoozedExpanded = view.snoozedExpandedByProjectKey[projectKey] === true;
  const isSearching = isWorkspaceSearchActive(props.searchQuery);

  const isCurrentProjectAttached = useCallback(() => {
    const current = useSidebarWorkspaceStore.getState();
    const workspace = current.workspaces.find((candidate) => candidate.id === props.workspaceId);
    return (
      workspace != null && workspace.projects.some((ref) => scopedProjectKey(ref) === projectKey)
    );
  }, [projectKey, props.workspaceId]);

  const isCurrentProjectActionTarget = useCallback(() => {
    if (!isCurrentProjectAttached() || readProject(props.projectRef) == null) return false;
    return (
      appAtomRegistry.get(environmentPresentations.presentationAtom(props.projectRef.environmentId))
        ?.connection.phase === "connected"
    );
  }, [isCurrentProjectAttached, props.projectRef]);

  const isCurrentThreadActionTarget = useCallback(
    (threadRef: ScopedThreadRef) =>
      isCurrentProjectActionTarget() && readThreadShell(threadRef) != null,
    [isCurrentProjectActionTarget],
  );

  useEffect(() => {
    if (!project) return;
    updateLastKnown(props.projectRef, {
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      environmentLabel: props.environmentLabel,
    });
  }, [project, props.environmentLabel, props.projectRef, updateLastKnown]);

  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftsByThreadKey = useComposerDraftStore((store) => store.draftsByThreadKey);
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);

  const drafts = useMemo(() => {
    const rows: Array<{
      draftId: DraftId;
      session: DraftSessionState;
      title: string;
      futureKey: string;
    }> = [];
    for (const [draftKey, session] of Object.entries(draftThreadsByThreadKey)) {
      if (
        session.environmentId !== props.projectRef.environmentId ||
        session.projectId !== props.projectRef.projectId
      ) {
        continue;
      }
      if (session.promotedTo != null) continue;
      const composer = draftsByThreadKey[draftKey];
      if (!shouldIncludeWorkspaceDraft({ hasUserContent: composerDraftHasUserContent(composer) })) {
        continue;
      }
      const prompt = composer?.prompt.trim().split("\n", 1)[0] ?? "Draft";
      rows.push({
        draftId: DraftId.make(draftKey),
        session,
        title: prompt.length > 0 ? prompt : "Draft",
        futureKey: scopedThreadKey(scopeThreadRef(session.environmentId, session.threadId)),
      });
    }
    return rows;
  }, [draftThreadsByThreadKey, draftsByThreadKey, props.projectRef]);

  const now = `${nowMinute}:00.000Z`;
  const snoozeNow = useMemo(() => new Date().toISOString(), [nowMinute, snoozeWakeTick]);
  const capabilities = serverConfigs.get(props.projectRef.environmentId)?.environment.capabilities;
  const shellByKey = useMemo(
    () =>
      new Map(
        shells.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [shells],
  );

  type ListItem = {
    readonly key: string;
    readonly title: string;
    readonly createdAt: string;
    readonly kind: "thread" | "draft";
    readonly thread?: EnvironmentThreadShell;
    readonly draftId?: DraftId;
    readonly session?: DraftSessionState;
  };

  const listItems = useMemo(() => {
    const items: ListItem[] = [];
    const used = new Set<string>();
    for (const thread of shells) {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      used.add(key);
      items.push({
        key,
        title: thread.title,
        createdAt: thread.createdAt,
        kind: "thread",
        thread,
      });
    }
    for (const draft of drafts) {
      if (used.has(draft.futureKey)) continue;
      used.add(draft.futureKey);
      items.push({
        key: draft.futureKey,
        title: draft.title,
        createdAt: draft.session.createdAt,
        kind: "draft",
        draftId: draft.draftId,
        session: draft.session,
      });
    }
    return items;
  }, [drafts, shells]);

  const classifyItem = useCallback(
    (item: ListItem) => {
      if (item.kind === "draft" || !item.thread) return "active" as const;
      return classifyWorkspaceThread(
        {
          ...item.thread,
          capabilities: {
            supportsSettlement: capabilities?.threadSettlement === true,
            supportsSnooze: capabilities?.threadSnooze === true,
          },
          changeRequest: matchingChangeRequestFromSnapshot({
            snapshot: changeRequestSnapshotByKey.get(item.key),
            thread: item.thread,
          }),
        },
        {
          now,
          snoozeNow,
          autoSettleAfterDays,
          autoSettleOnMerge,
        },
      );
    },
    [
      autoSettleAfterDays,
      autoSettleOnMerge,
      capabilities?.threadSettlement,
      capabilities?.threadSnooze,
      changeRequestSnapshotByKey,
      now,
      snoozeNow,
    ],
  );

  useEffect(() => {
    const original = [...threadOrder];
    let order = original;
    for (const [draftKey, session] of Object.entries(draftThreadsByThreadKey)) {
      if (!session.promotedTo) continue;
      if (
        session.environmentId !== props.projectRef.environmentId ||
        session.projectId !== props.projectRef.projectId
      ) {
        continue;
      }
      const futureKey = scopedThreadKey(scopeThreadRef(session.environmentId, session.threadId));
      const serverKey = scopedThreadKey(session.promotedTo);
      order = applyDraftPromotionToOrder(order, draftKey, serverKey);
      if (futureKey !== draftKey && futureKey !== serverKey) {
        order = applyDraftPromotionToOrder(order, futureKey, serverKey);
      }
    }
    const presentKeys = listItems.map((item) => item.key);
    const createdAtByKey = Object.fromEntries(
      listItems.map((item) => [item.key, item.createdAt] as const),
    );
    const seedDecision = workspaceThreadOrderSeedDecision({
      storedOrder: original,
      presentKeys,
      settingsHydrated,
      shellBootstrapped: environmentShellBootstrapped,
      projectAvailable: project != null,
      environmentConnected: props.environmentConnected,
      liveThreadShellCount: shells.length,
    });
    if (seedDecision === "wait") return;
    if (seedDecision === "seed") {
      const groupByKey = new Map(listItems.map((item) => [item.key, classifyItem(item)] as const));
      const liveSeeds = shells;
      const draftSeeds = drafts.flatMap((draft) => {
        if (shellByKey.has(draft.futureKey)) return [];
        return [
          {
            id: draft.session.threadId,
            environmentId: draft.session.environmentId,
            createdAt: draft.session.createdAt,
            updatedAt: draft.session.createdAt,
            latestUserMessageAt: null,
            latestTurn: null,
            settledAt: null,
          },
        ];
      });
      const displayKeys = seedDefaultDisplayOrderKeys({
        threads: [...liveSeeds, ...draftSeeds],
        classify: (thread) =>
          groupByKey.get(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))) ??
          "active",
        threadKey: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        layout: legacySidebarEnabled ? "legacy" : "modern",
        threadSortOrder: sidebarThreadSortOrder,
      });
      setThreadOrder(props.projectRef, seedCanonicalThreadOrder(displayKeys));
      return;
    }
    const reconciled = reconcileCanonicalThreadOrder({
      storedOrder: order,
      presentKeys,
      createdAtByKey,
    });
    if (!sameStringArrays(original, reconciled.order)) {
      setThreadOrder(props.projectRef, reconciled.order);
    }
  }, [
    autoSettleAfterDays,
    autoSettleOnMerge,
    environmentShellBootstrapped,
    capabilities?.threadSettlement,
    capabilities?.threadSnooze,
    changeRequestSnapshotByKey,
    classifyItem,
    draftThreadsByThreadKey,
    drafts,
    legacySidebarEnabled,
    listItems,
    now,
    project,
    props.environmentConnected,
    props.projectRef,
    setThreadOrder,
    settingsHydrated,
    shellByKey,
    shells,
    sidebarThreadSortOrder,
    snoozeNow,
    threadOrder,
  ]);

  const threadView = useMemo(
    () =>
      buildWorkspaceProjectThreadView({
        threads: listItems,
        getKey: (item) => item.key,
        classify: classifyItem,
        canonicalOrder: threadOrder,
        settledLimit,
        snoozedExpanded,
        folderExpanded: expanded,
        query: props.searchQuery,
      }),
    [
      classifyItem,
      expanded,
      listItems,
      props.searchQuery,
      settledLimit,
      snoozedExpanded,
      threadOrder,
    ],
  );

  const groups = {
    active: threadView.active.map((item) => item.key),
    snoozed: threadView.snoozed.map((item) => item.key),
    settled: threadView.settled.map((item) => item.key),
  };
  const visibleKeys = threadView.visibleThreads.map((item) => item.key);
  const showBody = expanded || isSearching;
  const itemByKey = useMemo(
    () => new Map(listItems.map((item) => [item.key, item] as const)),
    [listItems],
  );

  const onVisibleKeys = props.onVisibleKeys;
  const draftIdByVisibleKey = useMemo(() => {
    const drafts = new Map<string, DraftId>();
    for (const item of listItems) {
      if (item.kind === "draft" && item.draftId) drafts.set(item.key, item.draftId);
    }
    return drafts;
  }, [listItems]);
  const visibleKeysSignature = visibleKeys.join("\0");
  const draftSignature = [...draftIdByVisibleKey.entries()]
    .map(([key, draftId]) => `${key}:${draftId}`)
    .join("\0");
  const visibleReportRef = useRef<WorkspaceVisibleKeysReport<DraftId>>({
    keys: visibleKeys,
    drafts: draftIdByVisibleKey,
    live,
  });
  visibleReportRef.current = {
    keys: visibleKeys,
    drafts: draftIdByVisibleKey,
    live,
  };
  useEffect(() => {
    onVisibleKeys(projectKey, visibleReportRef.current);
  }, [draftSignature, live, onVisibleKeys, projectKey, visibleKeysSignature]);

  const revealStateRef = useRef({
    workspaceId: props.workspaceId,
    projectKey,
    expanded,
    settledLimit,
    snoozedExpanded,
    settledLimitByProjectKey: view.settledLimitByProjectKey,
    snoozedExpandedByProjectKey: view.snoozedExpandedByProjectKey,
    active: groups.active,
    snoozed: groups.snoozed,
    settled: groups.settled,
  });
  revealStateRef.current = {
    workspaceId: props.workspaceId,
    projectKey,
    expanded,
    settledLimit,
    snoozedExpanded,
    settledLimitByProjectKey: view.settledLimitByProjectKey,
    snoozedExpandedByProjectKey: view.snoozedExpandedByProjectKey,
    active: groups.active,
    snoozed: groups.snoozed,
    settled: groups.settled,
  };
  const revealKeysSignature = `${groups.active.join("\0")}\n${groups.snoozed.join("\0")}\n${groups.settled.join("\0")}`;
  useEffect(() => {
    const applyPendingReveal = () => {
      const state = revealStateRef.current;
      const taken = consumePendingWorkspaceThreadReveal({
        workspaceId: state.workspaceId,
        threadKeys: [...state.active, ...state.snoozed, ...state.settled],
      });
      if (!taken) return;
      const plan = searchNavigationReveal({
        selectedKey: taken.threadKey,
        belongsToProject: true,
        folderExpanded: state.expanded,
        settledKeys: state.settled,
        settledLimit: state.settledLimit,
        snoozedKeys: state.snoozed,
        snoozedExpanded: state.snoozedExpanded,
      });
      if (plan.expand && !state.expanded) {
        setExpanded(state.workspaceId, state.projectKey, true);
      }
      const nextSettled = plan.settledLimit !== state.settledLimit;
      const nextSnoozed = plan.snoozedExpanded !== state.snoozedExpanded;
      if (!nextSettled && !nextSnoozed) return;
      patchView(state.workspaceId, {
        ...(nextSettled
          ? {
              settledLimitByProjectKey: {
                ...state.settledLimitByProjectKey,
                [state.projectKey]: plan.settledLimit,
              },
            }
          : {}),
        ...(nextSnoozed
          ? {
              snoozedExpandedByProjectKey: {
                ...state.snoozedExpandedByProjectKey,
                [state.projectKey]: plan.snoozedExpanded,
              },
            }
          : {}),
      });
    };
    applyPendingReveal();
    return onWorkspaceThreadReveal(() => {
      applyPendingReveal();
    });
  }, [patchView, projectKey, props.workspaceId, revealKeysSignature, setExpanded]);

  useEffect(() => {
    const nextWakeAtMs = threadView.snoozed
      .map((item) => item.thread?.snoozedUntil)
      .filter((value): value is string => value != null)
      .map((value) => Date.parse(value))
      .filter((value) => !Number.isNaN(value))
      .sort((left, right) => left - right)[0];
    if (nextWakeAtMs === undefined) return;
    const delayMs = Math.min(Math.max(0, nextWakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = window.setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => window.clearTimeout(id);
  }, [threadView.snoozed]);

  const projectSortable = useSortable({ id: projectKey });

  const threadByKeyRef = useRef(shellByKey);
  threadByKeyRef.current = shellByKey;
  const initiatingWorkspaceId = props.workspaceId;
  const resolveSelectedThreads = useCallback(
    (threadKeys: readonly string[]) =>
      resolveWorkspaceBulkSelection({
        selectedKeys: threadKeys,
        isDraftKey: (threadKey) => props.draftIdByKeyRef.current.has(threadKey),
        getThread: (threadKey) => {
          const parsed = parseScopedThreadKey(threadKey);
          return parsed ? (readThreadShell(parsed) ?? undefined) : undefined;
        },
        evaluateProject: (attachedProjectKey) => {
          const workspaceState = useSidebarWorkspaceStore.getState();
          const workspace =
            workspaceState.workspaces.find((item) => item.id === initiatingWorkspaceId) ?? null;
          const projectRef = parseScopedProjectKey(attachedProjectKey);
          return evaluateWorkspaceBulkProject({
            initiatingWorkspaceId,
            selectedWorkspaceId: workspaceState.selectedWorkspaceId,
            workspace,
            projectKey: attachedProjectKey,
            projectExists: projectRef != null && readProject(projectRef) != null,
            connected:
              projectRef != null &&
              appAtomRegistry.get(
                environmentPresentations.presentationAtom(projectRef.environmentId),
              )?.connection.phase === "connected",
          });
        },
      }),
    [initiatingWorkspaceId, props.draftIdByKeyRef],
  );
  const { showMultiSelectMenu, unsnoozeThread } = useWorkspaceThreadMenu({
    getThread: (threadKey) => threadByKeyRef.current.get(threadKey),
    resolveSelectedThreads,
    projectCwd: workspaceRoot || null,
    supports: (environmentId) => {
      const caps = serverConfigs.get(environmentId)?.environment.capabilities;
      return {
        settlement: caps?.threadSettlement === true,
        snooze: caps?.threadSnooze === true,
        pinning: caps?.threadPinning === true,
        titleRegeneration: caps?.threadTitleRegeneration === true,
      };
    },
    isSettled: (threadKey) => groups.settled.includes(threadKey),
    isSnoozed: (threadKey) => groups.snoozed.includes(threadKey),
    onStartRename: (threadKey, titleValue) => {
      setRenamingThreadKey(threadKey);
      setRenamingTitle(titleValue);
    },
  });

  const dndSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: WORKSPACE_DND_DISTANCE_THRESHOLD },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleThreadDragEnd = useCallback(
    (event: DragEndEvent) => {
      markWorkspaceDragEnd(threadDragStateRef.current);
      const active = parseWorkspaceThreadDragId(String(event.active.id));
      const over = event.over ? parseWorkspaceThreadDragId(String(event.over.id)) : null;
      if (!active || !over) return;
      if (active.projectKey !== projectKey || over.projectKey !== projectKey) return;
      if (active.group !== over.group) return;
      if (!isCurrentProjectActionTarget()) return;
      const groupKeys =
        active.group === "active"
          ? groups.active
          : active.group === "snoozed"
            ? groups.snoozed
            : groups.settled;
      const planned = planWorkspaceThreadDrag({
        canonicalOrder: threadOrder,
        sourceProjectKey: active.projectKey,
        targetProjectKey: over.projectKey,
        sourceGroup: active.group,
        targetGroup: over.group,
        sourceKey: active.threadKey,
        targetKey: over.threadKey,
        movableKeys: groupKeys,
      });
      if (planned) setThreadOrder(props.projectRef, planned.nextOrder);
    },
    [
      groups.active,
      groups.settled,
      groups.snoozed,
      projectKey,
      props.projectRef,
      setThreadOrder,
      threadOrder,
      isCurrentProjectActionTarget,
    ],
  );
  const handleThreadDragStart = useCallback(() => {
    markWorkspaceDragStart(threadDragStateRef.current);
  }, []);
  const handleThreadDragCancel = useCallback(() => {
    markWorkspaceDragCancel(threadDragStateRef.current);
  }, []);

  const handleThreadClick = useCallback(
    (event: ReactMouseEvent, threadKey: string) => {
      const action = workspaceThreadPointerAction({
        modClick: isWorkspaceRowModClick(event, navigator.platform),
        shiftClick: event.shiftKey,
        liveAttachedThread: live,
      });
      if (action === "toggle") {
        event.preventDefault();
        useThreadSelectionStore.getState().toggleThread(threadKey);
        return;
      }
      if (action === "range") {
        event.preventDefault();
        useThreadSelectionStore
          .getState()
          .rangeSelectTo(threadKey, props.selectionOrderRef.current);
        return;
      }
      const thread = threadByKeyRef.current.get(threadKey);
      if (thread) {
        props.onNavigateThread(scopeThreadRef(thread.environmentId, thread.id));
        return;
      }
      const draft = itemByKey.get(threadKey);
      if (draft?.kind === "draft" && draft.draftId) {
        props.onNavigateDraft(draft.draftId);
      }
    },
    [itemByKey, live, props],
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent, threadKey: string) => {
      event.preventDefault();
      const selection = useThreadSelectionStore.getState();
      if (selection.hasSelection() && selection.selectedThreadKeys.has(threadKey)) {
        void showMultiSelectMenu(
          [...selection.selectedThreadKeys],
          {
            x: event.clientX,
            y: event.clientY,
          },
          () => selection.clearSelection(),
        );
      }
    },
    [showMultiSelectMenu],
  );

  const commitRename = useCallback(() => {
    if (renamingThreadKey == null) return;
    const thread = threadByKeyRef.current.get(renamingThreadKey);
    const trimmed = renamingTitle.trim();
    setRenamingThreadKey(null);
    if (!thread) return;
    const threadRef = scopeThreadRef(thread.environmentId, thread.id);
    if (!isCurrentThreadActionTarget(threadRef)) return;
    if (trimmed.length === 0) {
      toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
      return;
    }
    if (trimmed === thread.title) return;
    void (async () => {
      const result = await updateThreadMetadata({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, title: trimmed },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  }, [isCurrentThreadActionTarget, renamingThreadKey, renamingTitle, updateThreadMetadata]);

  const handleHeaderContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      if (consumeWorkspaceClickGuard(props.projectDragState)) return;
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              {
                id: "new-chat",
                label: "New Chat",
                disabled: !live,
              },
              { id: "detach", label: "Remove from workspace" },
            ],
            { x: event.clientX, y: event.clientY },
          ),
        );
        if (clicked._tag === "Failure" || clicked.value == null) return;
        if (clicked.value === "new-chat" && live) {
          if (!isCurrentProjectActionTarget()) return;
          void handleNewThread(props.projectRef);
          return;
        }
        if (clicked.value === "detach") {
          if (!isCurrentProjectAttached()) return;
          detachProject(props.workspaceId, props.projectRef);
        }
      })();
    },
    [
      detachProject,
      handleNewThread,
      isCurrentProjectAttached,
      isCurrentProjectActionTarget,
      live,
      props.projectRef,
      props.projectDragState,
      props.workspaceId,
    ],
  );

  const handleProjectHeaderClick = useCallback(
    (event: ReactMouseEvent) => {
      if (consumeWorkspaceClickGuard(props.projectDragState)) {
        event.preventDefault();
        return;
      }
      setExpanded(props.workspaceId, projectKey, !expanded);
    },
    [expanded, projectKey, props.projectDragState, props.workspaceId, setExpanded],
  );

  const selectedKeys = useThreadSelectionStore((state) => state.selectedThreadKeys);

  const renderThread = (threadKey: string, group: "active" | "snoozed" | "settled") => {
    const thread = shellByKey.get(threadKey);
    if (!thread) return null;
    const dragId = workspaceThreadDragId({ projectKey, group, threadKey });
    return (
      <WorkspaceThreadRow
        key={threadKey}
        thread={thread}
        group={group}
        dragId={dragId}
        isActive={props.routeThreadKey === threadKey}
        isSelected={selectedKeys.has(threadKey)}
        jumpLabel={props.jumpLabelByKey.get(threadKey) ?? null}
        liveStatus={live}
        canDrag={live && !isSearching && props.environmentConnected}
        providerEntry={
          live ? (props.providerEntries.get(thread.modelSelection.instanceId) ?? null) : null
        }
        providerEntries={props.providerEntries.values()}
        isRenaming={renamingThreadKey === threadKey}
        renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ""}
        wakeLabel={
          group === "snoozed" && thread.snoozedUntil != null
            ? snoozeWakeLabel(thread.snoozedUntil, { now })
            : null
        }
        dragState={threadDragStateRef.current}
        isTargetValid={() =>
          isCurrentThreadActionTarget(scopeThreadRef(thread.environmentId, thread.id))
        }
        onRenameTitleChange={setRenamingTitle}
        onCommitRename={commitRename}
        onCancelRename={() => setRenamingThreadKey(null)}
        onClick={handleThreadClick}
        onActivate={() => props.onNavigateThread(scopeThreadRef(thread.environmentId, thread.id))}
        projectCwd={workspaceRoot || null}
        changeRequest={matchingChangeRequestFromSnapshot({
          snapshot: changeRequestSnapshotByKey.get(threadKey),
          thread,
        })}
        onBulkContextMenu={(event) => {
          const selection = useThreadSelectionStore.getState();
          if (selection.hasSelection() && selection.selectedThreadKeys.has(threadKey)) {
            handleContextMenu(event, threadKey);
            return true;
          }
          return false;
        }}
        onStartRename={() => {
          setRenamingThreadKey(threadKey);
          setRenamingTitle(thread.title);
        }}
        {...(group === "snoozed"
          ? {
              onWake: () => {
                const threadRef = scopeThreadRef(thread.environmentId, thread.id);
                if (!isCurrentThreadActionTarget(threadRef)) return;
                void unsnoozeThread(threadRef);
              },
            }
          : {})}
      />
    );
  };

  const sortableIds = useMemo(
    () =>
      threadView.visibleThreads.flatMap((item) => {
        const group = classifyItem(item);
        if (group === "archived") return [];
        return [workspaceThreadDragId({ projectKey, group, threadKey: item.key })];
      }),
    [classifyItem, projectKey, threadView.visibleThreads],
  );

  return (
    <section
      className="min-w-0"
      data-testid={`workspace-project-${projectKey}`}
      ref={projectSortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(projectSortable.transform),
        transition: projectSortable.transition,
      }}
    >
      <div className="group/workspace-project relative">
        <SidebarMenuButton
          className="h-7 cursor-grab pr-8 text-sm active:cursor-grabbing"
          onPointerDownCapture={() => clearWorkspacePointerGuard(props.projectDragState)}
          onKeyDownCapture={() => prepareWorkspaceKeyboardGesture(props.projectDragState)}
          onClick={handleProjectHeaderClick}
          onContextMenu={handleHeaderContextMenu}
          aria-expanded={expanded}
          {...projectSortable.attributes}
          {...projectSortable.listeners}
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
              expanded && "rotate-90",
            )}
          />
          {project ? (
            <ProjectFavicon
              environmentId={project.environmentId}
              cwd={project.workspaceRoot}
              faviconPath={project.faviconPath}
              className="size-4"
            />
          ) : (
            <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate font-medium text-sidebar-foreground/90">
            {title}
          </span>
          {!live ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {environmentLabel ?? "Unavailable"}
            </span>
          ) : null}
        </SidebarMenuButton>
        {live ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`New Chat in ${title}`}
                  className="absolute top-1/2 right-1 hidden size-6 -translate-y-1/2 items-center justify-center rounded-md text-icon-muted hover:text-foreground group-hover/workspace-project:flex group-focus-within/workspace-project:flex"
                  onPointerDownCapture={() => clearWorkspacePointerGuard(props.projectDragState)}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (consumeWorkspaceClickGuard(props.projectDragState)) return;
                    if (!isCurrentProjectActionTarget()) return;
                    void handleNewThread(props.projectRef);
                  }}
                />
              }
            >
              <SquarePenIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {props.newThreadShortcutLabel
                ? `New Chat (${props.newThreadShortcutLabel})`
                : "New Chat"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {showBody ? (
        <div className="ms-3 ps-1">
          <DndContext
            sensors={dndSensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
            onDragStart={handleThreadDragStart}
            onDragEnd={handleThreadDragEnd}
            onDragCancel={handleThreadDragCancel}
          >
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              <ul className="flex flex-col" role="list">
                {(isSearching
                  ? threadView.visibleThreads
                  : threadView.visibleThreads.filter((item) => classifyItem(item) === "active")
                ).map((item) => {
                  if (item.kind === "draft" && item.draftId && item.session) {
                    const group = classifyItem(item);
                    const dragGroup = group === "archived" ? "active" : group;
                    return (
                      <WorkspaceDraftRow
                        key={item.key}
                        draftId={item.draftId}
                        session={item.session}
                        title={item.title}
                        dragId={workspaceThreadDragId({
                          projectKey,
                          group: dragGroup,
                          threadKey: item.key,
                        })}
                        dragState={threadDragStateRef.current}
                        canDrag={live && !isSearching && props.environmentConnected}
                        isActive={props.routeDraftId === item.draftId}
                        onActivate={props.onNavigateDraft}
                        onDiscard={(draftId) => {
                          releaseComposerDraftUploads(draftId);
                          clearDraftThread(draftId);
                        }}
                      />
                    );
                  }
                  const group = classifyItem(item);
                  if (group === "archived") return null;
                  return renderThread(item.key, group);
                })}
                {!isSearching && threadView.showSnoozedDisclosure ? (
                  <li className="list-none" data-thread-selection-safe>
                    <button
                      type="button"
                      className="flex h-6 w-full items-center gap-2 px-2 text-left text-[11px] text-muted-foreground"
                      aria-expanded={snoozedExpanded}
                      onClick={() =>
                        patchView(props.workspaceId, {
                          snoozedExpandedByProjectKey: {
                            ...view.snoozedExpandedByProjectKey,
                            [projectKey]: !snoozedExpanded,
                          },
                        })
                      }
                    >
                      <span>
                        {snoozedExpanded ? "Snoozed" : `Snoozed (${threadView.snoozed.length})`}
                      </span>
                      <span className="h-px flex-1 bg-sidebar-border/60" />
                    </button>
                  </li>
                ) : null}
                {!isSearching
                  ? threadView.visibleThreads
                      .filter((item) => classifyItem(item) === "snoozed")
                      .map((item) => renderThread(item.key, "snoozed"))
                  : null}
                {!isSearching
                  ? threadView.visibleThreads
                      .filter((item) => classifyItem(item) === "settled")
                      .map((item) => renderThread(item.key, "settled"))
                  : null}
                {!isSearching && threadView.canLoadMore ? (
                  <li className="list-none">
                    <button
                      type="button"
                      className="flex h-7 w-full items-center px-2 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                      onClick={() =>
                        patchView(props.workspaceId, {
                          settledLimitByProjectKey: {
                            ...view.settledLimitByProjectKey,
                            [projectKey]: nextSettledVisibleLimit(settledLimit),
                          },
                        })
                      }
                    >
                      Load More
                    </button>
                  </li>
                ) : null}
                {!isSearching && threadView.canShowLess ? (
                  <li className="list-none">
                    <button
                      type="button"
                      className="flex h-7 w-full items-center px-2 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                      onClick={() =>
                        patchView(props.workspaceId, {
                          settledLimitByProjectKey: {
                            ...view.settledLimitByProjectKey,
                            [projectKey]: resetSettledVisibleLimit(),
                          },
                        })
                      }
                    >
                      Show Less
                    </button>
                  </li>
                ) : null}
                {threadView.visibleThreads.length === 0 && !isSearching ? (
                  <li className="list-none px-2 py-1 text-xs text-muted-foreground/70">
                    No chats yet
                  </li>
                ) : null}
              </ul>
            </SortableContext>
          </DndContext>
        </div>
      ) : null}
    </section>
  );
});
