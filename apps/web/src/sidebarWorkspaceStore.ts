import {
  parseScopedProjectKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  ScopedProjectRef as ScopedProjectRefSchema,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create, type StoreApi, type UseBoundStore } from "zustand";

import { composerDraftHasUserContent, useComposerDraftStore } from "./composerDraftStore";
import { sidebarWorkspacesEnabled } from "./env";
import { randomUUID } from "./lib/utils";
import {
  DEFAULT_SETTLED_VISIBLE_LIMIT,
  planDraftOrderMembership,
  shouldIncludeWorkspaceDraft,
} from "./sidebarWorkspaceModel";
import {
  invalidateWorkspaceThreadReveal,
  invalidateWorkspaceThreadRevealForProject,
} from "./components/sidebar/workspaceNavigation";

export { DEFAULT_SETTLED_VISIBLE_LIMIT, SETTLED_LOAD_MORE_STEP } from "./sidebarWorkspaceModel";

export const SIDEBAR_WORKSPACES_STORAGE_KEY = "t3code:sidebar-workspaces:v1";
export const DEFAULT_WORKSPACE_VIEW_KEY = "default";
export const WORKSPACE_PREFERENCES_LOAD_ERROR = "Workspace preferences could not load.";
export const WORKSPACE_PREFERENCES_SAVE_ERROR = "Workspace changes may not survive restart.";

export interface SidebarWorkspace {
  id: string;
  name: string;
  projects: ScopedProjectRef[];
}

export interface SidebarWorkspaceProjectLastKnown {
  title: string;
  workspaceRoot: string;
  environmentLabel: string | null;
}

export interface SidebarWorkspaceProjectState {
  threadOrder: string[];
  lastKnown: SidebarWorkspaceProjectLastKnown;
}

export type SidebarWorkspaceAttachResult =
  | { status: "attached" }
  | { status: "already-attached" }
  | { status: "conflict"; ownerId: string }
  | { status: "missing-workspace" };

export interface SidebarWorkspaceStoreState {
  selectedWorkspaceId: string | null;
  workspaces: SidebarWorkspace[];
  projectStateByKey: Record<string, SidebarWorkspaceProjectState>;
  expandedByWorkspaceId: Record<string, Record<string, boolean>>;
  storageError: string | null;
  createWorkspace: (name: string) => string | null;
  renameWorkspace: (id: string, name: string) => boolean;
  deleteWorkspace: (id: string) => void;
  selectWorkspace: (id: string | null) => void;
  attachProject: (
    id: string,
    ref: ScopedProjectRef,
    lastKnown?: SidebarWorkspaceProjectLastKnown,
  ) => SidebarWorkspaceAttachResult;
  detachProject: (id: string, ref: ScopedProjectRef) => void;
  moveProject: (ref: ScopedProjectRef, expectedOwnerId: string, targetId: string) => boolean;
  reorderWorkspaces: (ids: string[]) => void;
  reorderProjects: (id: string, keys: string[]) => void;
  setThreadOrder: (ref: ScopedProjectRef, keys: string[]) => void;
  reconcileDraftThreadOrders: (
    drafts: ReadonlyArray<{
      key: string;
      projectRef: ScopedProjectRef;
      createdAt?: string;
      promotedToKey?: string | null;
      aliasKeys?: readonly string[];
    }>,
  ) => void;
  setExpanded: (workspaceId: string, key: string, expanded: boolean) => void;
  updateLastKnown: (ref: ScopedProjectRef, lastKnown: SidebarWorkspaceProjectLastKnown) => void;
}

export interface SidebarWorkspaceStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface CreateSidebarWorkspaceStoreOptions {
  persist?: boolean;
  storage?: SidebarWorkspaceStorage;
  generateId?: () => string;
}

interface PersistedSidebarWorkspacesV1 {
  version: 1;
  selectedWorkspaceId: string | null;
  workspaces: SidebarWorkspace[];
  projectStateByKey: Record<string, SidebarWorkspaceProjectState>;
  expandedByWorkspaceId: Record<string, Record<string, boolean>>;
}

const decodeScopedProjectRef = Schema.decodeUnknownOption(ScopedProjectRefSchema);
const decodeLastKnown = Schema.decodeUnknownOption(
  Schema.Struct({
    title: Schema.String,
    workspaceRoot: Schema.String,
    environmentLabel: Schema.NullOr(Schema.String),
  }),
);
const decodeThreadOrder = Schema.decodeUnknownOption(Schema.Array(Schema.String));
const decodeBooleanRecord = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Boolean),
);

const EMPTY_LAST_KNOWN: SidebarWorkspaceProjectLastKnown = {
  title: "",
  workspaceRoot: "",
  environmentLabel: null,
};

export function workspaceViewStoreKey(workspaceId: string | null): string {
  return workspaceId === null || workspaceId.length === 0
    ? DEFAULT_WORKSPACE_VIEW_KEY
    : workspaceId;
}

export function findProjectOwnerId(
  workspaces: readonly SidebarWorkspace[],
  ref: ScopedProjectRef,
): string | undefined {
  const key = scopedProjectKey(ref);
  for (const workspace of workspaces) {
    if (workspace.projects.some((project) => scopedProjectKey(project) === key)) {
      return workspace.id;
    }
  }
  return undefined;
}

export function resolveFolderExpanded(
  expandedByWorkspaceId: Record<string, Record<string, boolean>>,
  workspaceId: string,
  projectKey: string,
  fallback = true,
): boolean {
  const expanded = expandedByWorkspaceId[workspaceId]?.[projectKey];
  return expanded ?? fallback;
}

export function resolveSettledLimitForProject(
  view: SidebarWorkspaceViewState,
  projectKey: string,
): number {
  const limit = view.settledLimitByProjectKey[projectKey];
  if (
    typeof limit !== "number" ||
    !Number.isFinite(limit) ||
    limit < DEFAULT_SETTLED_VISIBLE_LIMIT
  ) {
    return DEFAULT_SETTLED_VISIBLE_LIMIT;
  }
  return Math.floor(limit);
}

export interface SidebarWorkspaceViewState {
  query: string;
  scrollTop: number;
  settledLimitByProjectKey: Record<string, number>;
  snoozedExpandedByProjectKey: Record<string, boolean>;
}

export const EMPTY_SIDEBAR_WORKSPACE_VIEW: SidebarWorkspaceViewState = Object.freeze({
  query: "",
  scrollTop: 0,
  settledLimitByProjectKey: Object.freeze({}) as Record<string, number>,
  snoozedExpandedByProjectKey: Object.freeze({}) as Record<string, boolean>,
});

export const EMPTY_THREAD_ORDER: readonly string[] = Object.freeze([]);

export interface SidebarWorkspaceViewStoreState {
  views: Record<string, SidebarWorkspaceViewState>;
  getView: (id: string | null) => SidebarWorkspaceViewState;
  patchView: (id: string | null, partial: Partial<SidebarWorkspaceViewState>) => void;
  forgetView: (id: string | null) => void;
}

export function createSidebarWorkspaceViewStore(): UseBoundStore<
  StoreApi<SidebarWorkspaceViewStoreState>
> {
  return create<SidebarWorkspaceViewStoreState>()((set, get) => ({
    views: {},
    getView: (id) => get().views[workspaceViewStoreKey(id)] ?? EMPTY_SIDEBAR_WORKSPACE_VIEW,
    patchView: (id, partial) => {
      const key = workspaceViewStoreKey(id);
      const current = get().views[key] ?? EMPTY_SIDEBAR_WORKSPACE_VIEW;
      const next: SidebarWorkspaceViewState = {
        query: partial.query ?? current.query,
        scrollTop: partial.scrollTop ?? current.scrollTop,
        settledLimitByProjectKey: {
          ...current.settledLimitByProjectKey,
          ...partial.settledLimitByProjectKey,
        },
        snoozedExpandedByProjectKey: {
          ...current.snoozedExpandedByProjectKey,
          ...partial.snoozedExpandedByProjectKey,
        },
      };
      if (viewsEqual(current, next)) {
        return;
      }
      set({
        views: {
          ...get().views,
          [key]: next,
        },
      });
    },
    forgetView: (id) => {
      const key = workspaceViewStoreKey(id);
      if (get().views[key] === undefined) {
        return;
      }
      const { [key]: _removed, ...rest } = get().views;
      set({ views: rest });
    },
  }));
}

export function createSidebarWorkspaceStore(
  options: CreateSidebarWorkspaceStoreOptions = {},
): UseBoundStore<StoreApi<SidebarWorkspaceStoreState>> {
  const persistEnabled = options.persist === true;
  const storage = options.storage ?? createDefaultStorage();
  const generateId = options.generateId ?? randomUUID;
  const hydrated = hydrateSidebarWorkspaces(storage, persistEnabled);
  const persistBlocked = hydrated.persistBlocked;
  let lastSerialized = hydrated.lastSerialized;

  return create<SidebarWorkspaceStoreState>()((set, get) => {
    const persist = () => {
      if (!persistEnabled || persistBlocked) {
        return;
      }
      const snapshot = toPersistedSnapshot(get());
      const serialized = JSON.stringify(snapshot);
      if (serialized === lastSerialized) {
        return;
      }
      try {
        storage.setItem(SIDEBAR_WORKSPACES_STORAGE_KEY, serialized);
        lastSerialized = serialized;
        if (get().storageError === WORKSPACE_PREFERENCES_SAVE_ERROR) {
          set({ storageError: null });
        }
      } catch {
        if (get().storageError !== WORKSPACE_PREFERENCES_SAVE_ERROR) {
          set({ storageError: WORKSPACE_PREFERENCES_SAVE_ERROR });
        }
      }
    };

    return {
      selectedWorkspaceId: hydrated.state.selectedWorkspaceId,
      workspaces: hydrated.state.workspaces,
      projectStateByKey: hydrated.state.projectStateByKey,
      expandedByWorkspaceId: hydrated.state.expandedByWorkspaceId,
      storageError: hydrated.state.storageError,

      createWorkspace: (name) => {
        const trimmed = name.trim();
        if (trimmed.length === 0) {
          return null;
        }
        const id = allocateWorkspaceId(
          get().workspaces.map((workspace) => workspace.id),
          generateId,
        );
        if (id === null) {
          return null;
        }
        set({
          workspaces: [...get().workspaces, { id, name: trimmed, projects: [] }],
        });
        persist();
        return id;
      },

      renameWorkspace: (id, name) => {
        const trimmed = name.trim();
        if (trimmed.length === 0) {
          return false;
        }
        const workspace = get().workspaces.find((candidate) => candidate.id === id);
        if (!workspace) {
          return false;
        }
        if (workspace.name === trimmed) {
          return true;
        }
        set({
          workspaces: get().workspaces.map((candidate) =>
            candidate.id === id ? { ...candidate, name: trimmed } : candidate,
          ),
        });
        persist();
        return true;
      },

      deleteWorkspace: (id) => {
        const current = get();
        if (!current.workspaces.some((workspace) => workspace.id === id)) {
          return;
        }
        invalidateWorkspaceThreadReveal(id);
        const { [id]: _removed, ...expandedByWorkspaceId } = current.expandedByWorkspaceId;
        set({
          workspaces: current.workspaces.filter((workspace) => workspace.id !== id),
          selectedWorkspaceId:
            current.selectedWorkspaceId === id ? null : current.selectedWorkspaceId,
          expandedByWorkspaceId,
        });
        persist();
      },

      selectWorkspace: (id) => {
        if (id === get().selectedWorkspaceId) {
          return;
        }
        if (id !== null && !get().workspaces.some((workspace) => workspace.id === id)) {
          return;
        }
        invalidateWorkspaceThreadReveal();
        set({ selectedWorkspaceId: id });
        persist();
      },

      attachProject: (id, ref, lastKnown) => {
        const current = get();
        const workspace = current.workspaces.find((candidate) => candidate.id === id);
        if (!workspace) {
          return { status: "missing-workspace" };
        }
        const projectKey = scopedProjectKey(ref);
        if (workspace.projects.some((project) => scopedProjectKey(project) === projectKey)) {
          if (lastKnown && rememberLastKnownIfChanged(current, set, ref, lastKnown)) {
            persist();
          }
          return { status: "already-attached" };
        }
        const ownerId = findProjectOwnerId(current.workspaces, ref);
        if (ownerId !== undefined) {
          return { status: "conflict", ownerId };
        }
        set({
          workspaces: current.workspaces.map((candidate) =>
            candidate.id === id
              ? { ...candidate, projects: [...candidate.projects, ref] }
              : candidate,
          ),
          projectStateByKey: lastKnown
            ? upsertProjectState(current.projectStateByKey, projectKey, {
                lastKnown,
              })
            : current.projectStateByKey,
        });
        persist();
        return { status: "attached" };
      },

      detachProject: (id, ref) => {
        const current = get();
        const workspace = current.workspaces.find((candidate) => candidate.id === id);
        if (!workspace) {
          return;
        }
        const projectKey = scopedProjectKey(ref);
        if (!workspace.projects.some((project) => scopedProjectKey(project) === projectKey)) {
          return;
        }
        invalidateWorkspaceThreadRevealForProject(id, projectKey);
        set({
          workspaces: current.workspaces.map((candidate) =>
            candidate.id === id
              ? {
                  ...candidate,
                  projects: candidate.projects.filter(
                    (project) => scopedProjectKey(project) !== projectKey,
                  ),
                }
              : candidate,
          ),
        });
        persist();
      },

      moveProject: (ref, expectedOwnerId, targetId) => {
        const current = get();
        const ownerId = findProjectOwnerId(current.workspaces, ref);
        if (ownerId !== expectedOwnerId) {
          return false;
        }
        const target = current.workspaces.find((workspace) => workspace.id === targetId);
        if (!target) {
          return false;
        }
        if (ownerId === targetId) {
          return true;
        }
        const projectKey = scopedProjectKey(ref);
        invalidateWorkspaceThreadRevealForProject(ownerId, projectKey);
        set({
          workspaces: current.workspaces.map((workspace) => {
            if (workspace.id === ownerId) {
              return {
                ...workspace,
                projects: workspace.projects.filter(
                  (project) => scopedProjectKey(project) !== projectKey,
                ),
              };
            }
            if (workspace.id === targetId) {
              return { ...workspace, projects: [...workspace.projects, ref] };
            }
            return workspace;
          }),
        });
        persist();
        return true;
      },

      reorderWorkspaces: (ids) => {
        const current = get().workspaces;
        const next = reorderByPreferredIds(current, ids, (workspace) => workspace.id);
        if (next === null) {
          return;
        }
        set({ workspaces: next });
        persist();
      },

      reorderProjects: (id, keys) => {
        const workspace = get().workspaces.find((candidate) => candidate.id === id);
        if (!workspace) {
          return;
        }
        const nextProjects = reorderProjectRefs(workspace.projects, keys);
        if (nextProjects === null) {
          return;
        }
        set({
          workspaces: get().workspaces.map((candidate) =>
            candidate.id === id ? { ...candidate, projects: nextProjects } : candidate,
          ),
        });
        persist();
      },

      setThreadOrder: (ref, keys) => {
        const projectKey = scopedProjectKey(ref);
        const currentState = get().projectStateByKey[projectKey];
        const threadOrder = uniqueNonEmptyStrings(keys);
        if (currentState && sameStringArray(currentState.threadOrder, threadOrder)) {
          return;
        }
        set({
          projectStateByKey: upsertProjectState(get().projectStateByKey, projectKey, {
            threadOrder,
          }),
        });
        persist();
      },

      reconcileDraftThreadOrders: (drafts) => {
        const current = get().projectStateByKey;
        const ordersByProjectKey: Record<string, readonly string[]> = {};
        for (const [projectKey, state] of Object.entries(current)) {
          ordersByProjectKey[projectKey] = state.threadOrder;
        }
        const planned = planDraftOrderMembership({
          ordersByProjectKey,
          drafts: drafts.map((draft) => ({
            key: draft.key,
            projectKey: scopedProjectKey(draft.projectRef),
            ...(draft.createdAt !== undefined ? { createdAt: draft.createdAt } : {}),
            ...(draft.promotedToKey !== undefined ? { promotedToKey: draft.promotedToKey } : {}),
            ...(draft.aliasKeys !== undefined ? { aliasKeys: draft.aliasKeys } : {}),
          })),
        });
        let next = current;
        let changed = false;
        for (const [projectKey, threadOrder] of Object.entries(planned)) {
          const existing = current[projectKey];
          if (!existing || sameStringArray(existing.threadOrder, threadOrder)) continue;
          changed = true;
          next = upsertProjectState(next, projectKey, { threadOrder });
        }
        if (!changed) return;
        set({ projectStateByKey: next });
        persist();
      },

      setExpanded: (workspaceId, key, expanded) => {
        if (workspaceId.length === 0 || key.length === 0) {
          return;
        }
        const current = get().expandedByWorkspaceId[workspaceId]?.[key];
        if (current === expanded) {
          return;
        }
        set({
          expandedByWorkspaceId: {
            ...get().expandedByWorkspaceId,
            [workspaceId]: {
              ...get().expandedByWorkspaceId[workspaceId],
              [key]: expanded,
            },
          },
        });
        persist();
      },

      updateLastKnown: (ref, lastKnown) => {
        if (rememberLastKnownIfChanged(get(), set, ref, lastKnown)) {
          persist();
        }
      },
    };
  });
}

export const useSidebarWorkspaceStore = createSidebarWorkspaceStore({
  persist: sidebarWorkspacesEnabled,
  storage: createDefaultStorage(),
});

export function composerDraftsToOrderRecords(): Array<{
  key: string;
  projectRef: ScopedProjectRef;
  createdAt: string;
  promotedToKey: string | null;
  aliasKeys: string[];
}> {
  const { draftThreadsByThreadKey, draftsByThreadKey } = useComposerDraftStore.getState();
  const records: Array<{
    key: string;
    projectRef: ScopedProjectRef;
    createdAt: string;
    promotedToKey: string | null;
    aliasKeys: string[];
  }> = [];
  for (const [draftKey, session] of Object.entries(draftThreadsByThreadKey)) {
    const promotedToKey = session.promotedTo ? scopedThreadKey(session.promotedTo) : null;
    if (
      promotedToKey == null &&
      !shouldIncludeWorkspaceDraft({
        hasUserContent: composerDraftHasUserContent(draftsByThreadKey[draftKey]),
      })
    ) {
      continue;
    }
    const futureKey = scopedThreadKey(scopeThreadRef(session.environmentId, session.threadId));
    records.push({
      key: futureKey,
      projectRef: scopeProjectRef(session.environmentId, session.projectId),
      createdAt: session.createdAt,
      promotedToKey,
      aliasKeys: draftKey !== futureKey ? [draftKey] : [],
    });
  }
  return records;
}

type ComposerDraftOrderSnapshot = Pick<
  ReturnType<typeof useComposerDraftStore.getState>,
  "draftsByThreadKey" | "draftThreadsByThreadKey"
>;

/**
 * Return only the draft inputs that can change its sidebar order membership.
 * Composer text and attachment payloads are intentionally represented by one
 * eligibility bit: once a draft is already eligible, typing more text cannot
 * change its canonical order. This keeps the Electron-only background
 * reconciler from rebuilding every project order on each keystroke.
 */
export function draftOrderReconciliationSignature(state: ComposerDraftOrderSnapshot): string {
  return JSON.stringify(
    Object.entries(state.draftThreadsByThreadKey)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([draftKey, session]) => [
        draftKey,
        session.environmentId,
        session.projectId,
        session.threadId,
        session.createdAt,
        session.promotedTo ? scopedThreadKey(session.promotedTo) : null,
        session.promotedTo ? null : composerDraftHasUserContent(state.draftsByThreadKey[draftKey]),
      ]),
  );
}

/** Run the expensive order walk only when an order-relevant draft input changed. */
export function reconcileDraftOrderChangesIfNeeded(
  previousSignature: string,
  state: ComposerDraftOrderSnapshot,
  reconcile: () => void,
): string {
  const nextSignature = draftOrderReconciliationSignature(state);
  if (nextSignature === previousSignature) return previousSignature;
  reconcile();
  return nextSignature;
}

function subscribeToComposerDraftOrderChanges(): void {
  // Track draft order only in clients with persistent sidebar workspaces.
  if (!sidebarWorkspacesEnabled) return;

  const initialState = useComposerDraftStore.getState();
  let previousSignature = draftOrderReconciliationSignature(initialState);
  // Reconcile once for drafts restored before this module installed its
  // listener; later retarget/promotion changes are handled while the custom
  // sidebar is unmounted (Default and Settings).
  useSidebarWorkspaceStore.getState().reconcileDraftThreadOrders(composerDraftsToOrderRecords());
  useComposerDraftStore.subscribe((state, previousState) => {
    if (
      state.draftThreadsByThreadKey === previousState.draftThreadsByThreadKey &&
      state.draftsByThreadKey === previousState.draftsByThreadKey
    ) {
      return;
    }
    previousSignature = reconcileDraftOrderChangesIfNeeded(previousSignature, state, () =>
      useSidebarWorkspaceStore
        .getState()
        .reconcileDraftThreadOrders(composerDraftsToOrderRecords()),
    );
  });
}

subscribeToComposerDraftOrderChanges();

export const useSidebarWorkspaceViewStore = createSidebarWorkspaceViewStore();

function createDefaultStorage(): SidebarWorkspaceStorage {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage;
    }
  } catch {
    return inaccessibleLocalStorage();
  }
  return unavailableLocalStorage();
}

function inaccessibleLocalStorage(): SidebarWorkspaceStorage {
  return {
    getItem: () => {
      throw new Error("localStorage is inaccessible");
    },
    setItem: () => {
      throw new Error("localStorage is inaccessible");
    },
  };
}

function unavailableLocalStorage(): SidebarWorkspaceStorage {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error("localStorage is unavailable");
    },
  };
}

function hydrateSidebarWorkspaces(
  storage: SidebarWorkspaceStorage,
  persistEnabled: boolean,
): {
  state: Pick<
    SidebarWorkspaceStoreState,
    | "selectedWorkspaceId"
    | "workspaces"
    | "projectStateByKey"
    | "expandedByWorkspaceId"
    | "storageError"
  >;
  persistBlocked: boolean;
  lastSerialized: string | null;
} {
  const emptyState = {
    selectedWorkspaceId: null,
    workspaces: [] as SidebarWorkspace[],
    projectStateByKey: {} as Record<string, SidebarWorkspaceProjectState>,
    expandedByWorkspaceId: {} as Record<string, Record<string, boolean>>,
    storageError: null as string | null,
  };

  if (!persistEnabled) {
    return { state: emptyState, persistBlocked: false, lastSerialized: null };
  }

  let raw: string | null;
  try {
    raw = storage.getItem(SIDEBAR_WORKSPACES_STORAGE_KEY);
  } catch {
    return {
      state: { ...emptyState, storageError: WORKSPACE_PREFERENCES_LOAD_ERROR },
      persistBlocked: true,
      lastSerialized: null,
    };
  }

  if (raw === null || raw.length === 0) {
    return { state: emptyState, persistBlocked: false, lastSerialized: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      state: { ...emptyState, storageError: WORKSPACE_PREFERENCES_LOAD_ERROR },
      persistBlocked: true,
      lastSerialized: null,
    };
  }

  const version = readDocumentVersion(parsed);
  if (version !== 1) {
    return {
      state: { ...emptyState, storageError: WORKSPACE_PREFERENCES_LOAD_ERROR },
      persistBlocked: true,
      lastSerialized: null,
    };
  }

  const decoded = decodePersistedV1(parsed);
  if (decoded === null) {
    return {
      state: { ...emptyState, storageError: WORKSPACE_PREFERENCES_LOAD_ERROR },
      persistBlocked: true,
      lastSerialized: null,
    };
  }

  const { state: normalized, changed } = normalizePersistedState(decoded);
  const serialized = JSON.stringify(toPersistedSnapshot(normalized));
  if (changed) {
    try {
      storage.setItem(SIDEBAR_WORKSPACES_STORAGE_KEY, serialized);
    } catch {
      return {
        state: { ...normalized, storageError: WORKSPACE_PREFERENCES_SAVE_ERROR },
        persistBlocked: false,
        lastSerialized: null,
      };
    }
  }
  return {
    state: { ...normalized, storageError: null },
    persistBlocked: false,
    lastSerialized: serialized,
  };
}

function readDocumentVersion(value: unknown): number | null {
  if (!isPlainObject(value) || !("version" in value)) {
    return null;
  }
  return typeof value.version === "number" && Number.isInteger(value.version)
    ? value.version
    : null;
}

function decodePersistedV1(value: unknown): PersistedSidebarWorkspacesV1 | null {
  if (!isPlainObject(value) || value.version !== 1) {
    return null;
  }

  const selectedWorkspaceId = decodeSelectedWorkspaceId(value.selectedWorkspaceId);
  if (selectedWorkspaceId === undefined) {
    return null;
  }
  if (value.workspaces !== undefined && !Array.isArray(value.workspaces)) {
    return null;
  }
  if (value.projectStateByKey !== undefined && !isPlainObject(value.projectStateByKey)) {
    return null;
  }
  if (value.expandedByWorkspaceId !== undefined && !isPlainObject(value.expandedByWorkspaceId)) {
    return null;
  }

  const workspaces: SidebarWorkspace[] = [];
  for (const entry of value.workspaces ?? []) {
    const workspace = decodeWorkspace(entry);
    if (workspace) {
      workspaces.push(workspace);
    }
  }

  return {
    version: 1,
    selectedWorkspaceId,
    workspaces,
    projectStateByKey: decodeProjectStateByKey(value.projectStateByKey),
    expandedByWorkspaceId: decodeExpandedByWorkspaceId(value.expandedByWorkspaceId),
  };
}

function decodeSelectedWorkspaceId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return value.length === 0 ? null : value;
}

function decodeWorkspace(value: unknown): SidebarWorkspace | null {
  if (!isPlainObject(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    return null;
  }
  const id = value.id.trim();
  if (id.length === 0 || !Array.isArray(value.projects)) {
    return null;
  }
  const projects: ScopedProjectRef[] = [];
  for (const project of value.projects) {
    const decoded = decodeScopedProjectRef(project);
    if (decoded._tag === "Some") {
      projects.push(decoded.value);
    }
  }
  return { id, name: value.name, projects };
}

function decodeProjectStateByKey(value: unknown): Record<string, SidebarWorkspaceProjectState> {
  if (!isPlainObject(value)) {
    return {};
  }
  const next: Record<string, SidebarWorkspaceProjectState> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0 || !isPlainObject(entry)) {
      continue;
    }
    const lastKnown = decodeLastKnown(entry.lastKnown);
    const threadOrder = decodeThreadOrder(entry.threadOrder);
    if (lastKnown._tag === "None" || threadOrder._tag === "None") {
      continue;
    }
    next[key] = {
      threadOrder: uniqueNonEmptyStrings(threadOrder.value),
      lastKnown: lastKnown.value,
    };
  }
  return next;
}

function decodeExpandedByWorkspaceId(value: unknown): Record<string, Record<string, boolean>> {
  if (!isPlainObject(value)) {
    return {};
  }
  const next: Record<string, Record<string, boolean>> = {};
  for (const [workspaceId, record] of Object.entries(value)) {
    if (workspaceId.length === 0) {
      continue;
    }
    const decoded = decodeBooleanRecord(record);
    if (decoded._tag === "None") {
      continue;
    }
    next[workspaceId] = decoded.value;
  }
  return next;
}

function normalizePersistedState(decoded: PersistedSidebarWorkspacesV1): {
  state: Omit<PersistedSidebarWorkspacesV1, "version">;
  changed: boolean;
} {
  const seenWorkspaceIds = new Set<string>();
  const ownedProjectKeys = new Set<string>();
  const workspaces: SidebarWorkspace[] = [];
  let changed = false;

  for (const workspace of decoded.workspaces) {
    if (seenWorkspaceIds.has(workspace.id)) {
      changed = true;
      continue;
    }
    seenWorkspaceIds.add(workspace.id);
    const name = workspace.name.trim();
    if (name.length === 0) {
      changed = true;
      continue;
    }
    if (name !== workspace.name) {
      changed = true;
    }
    const projects: ScopedProjectRef[] = [];
    const seenProjectKeys = new Set<string>();
    for (const project of workspace.projects) {
      const key = scopedProjectKey(project);
      if (seenProjectKeys.has(key) || ownedProjectKeys.has(key)) {
        changed = true;
        continue;
      }
      seenProjectKeys.add(key);
      ownedProjectKeys.add(key);
      projects.push(project);
    }
    workspaces.push({ id: workspace.id, name, projects });
  }

  const selectedWorkspaceId =
    decoded.selectedWorkspaceId !== null &&
    workspaces.some((workspace) => workspace.id === decoded.selectedWorkspaceId)
      ? decoded.selectedWorkspaceId
      : null;
  if (selectedWorkspaceId !== decoded.selectedWorkspaceId) {
    changed = true;
  }

  return {
    state: {
      selectedWorkspaceId,
      workspaces,
      projectStateByKey: decoded.projectStateByKey,
      expandedByWorkspaceId: decoded.expandedByWorkspaceId,
    },
    changed,
  };
}

function toPersistedSnapshot(
  state: Pick<
    SidebarWorkspaceStoreState,
    "selectedWorkspaceId" | "workspaces" | "projectStateByKey" | "expandedByWorkspaceId"
  >,
): PersistedSidebarWorkspacesV1 {
  return {
    version: 1,
    selectedWorkspaceId: state.selectedWorkspaceId,
    workspaces: state.workspaces,
    projectStateByKey: state.projectStateByKey,
    expandedByWorkspaceId: state.expandedByWorkspaceId,
  };
}

function allocateWorkspaceId(
  existingIds: readonly string[],
  generateId: () => string,
): string | null {
  const existing = new Set(existingIds);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = generateId().trim();
    if (id.length > 0 && !existing.has(id)) {
      return id;
    }
  }
  return null;
}

function rememberLastKnownIfChanged(
  current: SidebarWorkspaceStoreState,
  set: (partial: Partial<SidebarWorkspaceStoreState>) => void,
  ref: ScopedProjectRef,
  lastKnown: SidebarWorkspaceProjectLastKnown,
): boolean {
  const projectKey = scopedProjectKey(ref);
  const existing = current.projectStateByKey[projectKey];
  if (existing && lastKnownEqual(existing.lastKnown, lastKnown)) {
    return false;
  }
  set({
    projectStateByKey: upsertProjectState(current.projectStateByKey, projectKey, { lastKnown }),
  });
  return true;
}

function upsertProjectState(
  projectStateByKey: Record<string, SidebarWorkspaceProjectState>,
  projectKey: string,
  patch: Partial<SidebarWorkspaceProjectState>,
): Record<string, SidebarWorkspaceProjectState> {
  const current = projectStateByKey[projectKey];
  return {
    ...projectStateByKey,
    [projectKey]: {
      threadOrder: patch.threadOrder ?? current?.threadOrder ?? [...EMPTY_THREAD_ORDER],
      lastKnown: patch.lastKnown ?? current?.lastKnown ?? EMPTY_LAST_KNOWN,
    },
  };
}

function reorderByPreferredIds<T>(
  items: readonly T[],
  preferredIds: readonly string[],
  getId: (item: T) => string,
): T[] | null {
  if (items.length === 0) {
    return null;
  }
  const byId = new Map(items.map((item) => [getId(item), item]));
  const used = new Set<string>();
  const next: T[] = [];
  for (const id of preferredIds) {
    const item = byId.get(id);
    if (!item || used.has(id)) {
      continue;
    }
    used.add(id);
    next.push(item);
  }
  for (const item of items) {
    const id = getId(item);
    if (!used.has(id)) {
      next.push(item);
    }
  }
  if (next.length === items.length && next.every((item, index) => item === items[index])) {
    return null;
  }
  return next;
}

function reorderProjectRefs(
  projects: readonly ScopedProjectRef[],
  keys: readonly string[],
): ScopedProjectRef[] | null {
  const preferredIds = keys.filter((key) => parseScopedProjectKey(key) !== null);
  return reorderByPreferredIds(projects, preferredIds, scopedProjectKey);
}

function uniqueNonEmptyStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function lastKnownEqual(
  left: SidebarWorkspaceProjectLastKnown,
  right: SidebarWorkspaceProjectLastKnown,
): boolean {
  return (
    left.title === right.title &&
    left.workspaceRoot === right.workspaceRoot &&
    left.environmentLabel === right.environmentLabel
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function viewsEqual(left: SidebarWorkspaceViewState, right: SidebarWorkspaceViewState): boolean {
  return (
    left.query === right.query &&
    left.scrollTop === right.scrollTop &&
    recordsEqual(left.settledLimitByProjectKey, right.settledLimitByProjectKey) &&
    recordsEqual(left.snoozedExpandedByProjectKey, right.snoozedExpandedByProjectKey)
  );
}

function recordsEqual<T>(left: Record<string, T>, right: Record<string, T>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => left[key] === right[key]);
}
