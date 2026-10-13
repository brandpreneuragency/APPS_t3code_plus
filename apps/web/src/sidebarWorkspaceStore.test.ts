import { scopeProjectRef, scopedProjectKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createEmptyThreadDraft, type DraftThreadState } from "./composerDraftStore";
import {
  peekPendingWorkspaceThreadReveal,
  requestWorkspaceThreadReveal,
} from "./components/sidebar/workspaceNavigation";
import {
  createSidebarWorkspaceStore,
  createSidebarWorkspaceViewStore,
  draftOrderReconciliationSignature,
  reconcileDraftOrderChangesIfNeeded,
  DEFAULT_WORKSPACE_VIEW_KEY,
  EMPTY_SIDEBAR_WORKSPACE_VIEW,
  findProjectOwnerId,
  resolveFolderExpanded,
  resolveSettledLimitForProject,
  SIDEBAR_WORKSPACES_STORAGE_KEY,
  WORKSPACE_PREFERENCES_LOAD_ERROR,
  WORKSPACE_PREFERENCES_SAVE_ERROR,
  workspaceViewStoreKey,
  type SidebarWorkspaceStorage,
} from "./sidebarWorkspaceStore";
import { DEFAULT_SETTLED_VISIBLE_LIMIT } from "./sidebarWorkspaceModel";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");
const projectOne = scopeProjectRef(envA, ProjectId.make("project-1"));
const projectTwo = scopeProjectRef(envA, ProjectId.make("project-2"));
const projectRemote = scopeProjectRef(envB, ProjectId.make("project-1"));

const lastKnownOne = {
  title: "Alpha repo",
  workspaceRoot: "/repos/alpha",
  environmentLabel: "Local",
};

function memoryStorage(initialRaw?: string): {
  storage: SidebarWorkspaceStorage;
  writes: string[];
  getRaw: () => string | null;
} {
  let raw = initialRaw ?? null;
  const writes: string[] = [];
  return {
    storage: {
      getItem: (key) => (key === SIDEBAR_WORKSPACES_STORAGE_KEY ? raw : null),
      setItem: (key, value) => {
        if (key !== SIDEBAR_WORKSPACES_STORAGE_KEY) {
          return;
        }
        raw = value;
        writes.push(value);
      },
    },
    writes,
    getRaw: () => raw,
  };
}

function createPersistingStore(initialRaw?: string, generateId?: () => string) {
  const memory = memoryStorage(initialRaw);
  let sequence = 0;
  const store = createSidebarWorkspaceStore({
    persist: true,
    storage: memory.storage,
    generateId:
      generateId ??
      (() => {
        sequence += 1;
        return `workspace-${sequence}`;
      }),
  });
  return { store, memory };
}

function parsedSnapshot(raw: string | null): unknown {
  if (raw === null) {
    return null;
  }
  return JSON.parse(raw) as unknown;
}

describe("sidebarWorkspaceStore", () => {
  it("creates, renames, selects, and rejects blank workspace names", () => {
    const { store } = createPersistingStore();

    expect(store.getState().createWorkspace("   ")).toBeNull();
    expect(store.getState().createWorkspace("")).toBeNull();
    const id = store.getState().createWorkspace("  Focus  ");
    expect(id).toBe("workspace-1");
    expect(store.getState().workspaces).toEqual([
      { id: "workspace-1", name: "Focus", projects: [] },
    ]);
    expect(store.getState().selectedWorkspaceId).toBeNull();

    expect(store.getState().renameWorkspace("workspace-1", "   ")).toBe(false);
    expect(store.getState().renameWorkspace("missing", "Other")).toBe(false);
    expect(store.getState().renameWorkspace("workspace-1", "  Deep work  ")).toBe(true);
    expect(store.getState().workspaces[0]?.name).toBe("Deep work");

    store.getState().selectWorkspace("workspace-1");
    expect(store.getState().selectedWorkspaceId).toBe("workspace-1");
    store.getState().selectWorkspace("missing");
    expect(store.getState().selectedWorkspaceId).toBe("workspace-1");
    store.getState().selectWorkspace(null);
    expect(store.getState().selectedWorkspaceId).toBeNull();
  });

  it("allows duplicate workspace names because ids are authoritative", () => {
    const { store } = createPersistingStore();
    store.getState().createWorkspace("Same");
    store.getState().createWorkspace("Same");
    expect(store.getState().workspaces.map((workspace) => workspace.name)).toEqual([
      "Same",
      "Same",
    ]);
    expect(store.getState().workspaces.map((workspace) => workspace.id)).toEqual([
      "workspace-1",
      "workspace-2",
    ]);
  });

  it("attaches exclusively and reports a named conflict instead of moving", () => {
    const { store } = createPersistingStore();
    const alpha = store.getState().createWorkspace("Alpha")!;
    const beta = store.getState().createWorkspace("Beta")!;

    expect(store.getState().attachProject(alpha, projectOne, lastKnownOne)).toEqual({
      status: "attached",
    });
    expect(store.getState().attachProject(alpha, projectOne)).toEqual({
      status: "already-attached",
    });
    expect(store.getState().attachProject(beta, projectOne)).toEqual({
      status: "conflict",
      ownerId: alpha,
    });
    expect(store.getState().attachProject("missing", projectTwo)).toEqual({
      status: "missing-workspace",
    });
    expect(
      store.getState().workspaces.find((workspace) => workspace.id === beta)?.projects,
    ).toEqual([]);
    expect(findProjectOwnerId(store.getState().workspaces, projectOne)).toBe(alpha);
    expect(store.getState().projectStateByKey[scopedProjectKey(projectOne)]?.lastKnown).toEqual(
      lastKnownOne,
    );
  });

  it("moves a project atomically only while expected ownership still holds", () => {
    const { store } = createPersistingStore();
    const alpha = store.getState().createWorkspace("Alpha")!;
    const beta = store.getState().createWorkspace("Beta")!;
    store.getState().attachProject(alpha, projectOne, lastKnownOne);
    store.getState().setThreadOrder(projectOne, ["env-a:thread-a", "env-a:thread-b"]);

    expect(store.getState().moveProject(projectOne, "stale-owner", beta)).toBe(false);
    expect(findProjectOwnerId(store.getState().workspaces, projectOne)).toBe(alpha);

    expect(store.getState().moveProject(projectOne, alpha, "missing")).toBe(false);
    expect(store.getState().moveProject(projectOne, alpha, beta)).toBe(true);
    expect(findProjectOwnerId(store.getState().workspaces, projectOne)).toBe(beta);
    expect(
      store.getState().workspaces.find((workspace) => workspace.id === alpha)?.projects,
    ).toEqual([]);
    expect(
      store.getState().workspaces.find((workspace) => workspace.id === beta)?.projects,
    ).toEqual([projectOne]);
    expect(store.getState().projectStateByKey[scopedProjectKey(projectOne)]?.threadOrder).toEqual([
      "env-a:thread-a",
      "env-a:thread-b",
    ]);

    expect(store.getState().moveProject(projectOne, alpha, alpha)).toBe(false);
    expect(findProjectOwnerId(store.getState().workspaces, projectOne)).toBe(beta);
  });

  it("treats the same project id on another environment as a different project", () => {
    const { store } = createPersistingStore();
    const alpha = store.getState().createWorkspace("Alpha")!;
    expect(store.getState().attachProject(alpha, projectOne)).toEqual({ status: "attached" });
    expect(store.getState().attachProject(alpha, projectRemote)).toEqual({ status: "attached" });
    expect(store.getState().workspaces[0]?.projects).toEqual([projectOne, projectRemote]);
  });

  it("keeps thread order and last-known labels after detach and workspace delete", () => {
    const { store } = createPersistingStore();
    const alpha = store.getState().createWorkspace("Alpha")!;
    store.getState().selectWorkspace(alpha);
    store.getState().attachProject(alpha, projectOne, lastKnownOne);
    store.getState().setThreadOrder(projectOne, ["env-a:draft", "env-a:thread-1"]);
    store.getState().setExpanded(alpha, scopedProjectKey(projectOne), false);

    store.getState().detachProject(alpha, projectOne);
    expect(store.getState().workspaces[0]?.projects).toEqual([]);
    expect(store.getState().projectStateByKey[scopedProjectKey(projectOne)]).toEqual({
      threadOrder: ["env-a:draft", "env-a:thread-1"],
      lastKnown: lastKnownOne,
    });

    store.getState().attachProject(alpha, projectOne);
    expect(store.getState().workspaces[0]?.projects).toEqual([projectOne]);

    store.getState().deleteWorkspace(alpha);
    expect(store.getState().workspaces).toEqual([]);
    expect(store.getState().selectedWorkspaceId).toBeNull();
    expect(store.getState().expandedByWorkspaceId[alpha]).toBeUndefined();
    expect(store.getState().projectStateByKey[scopedProjectKey(projectOne)]?.threadOrder).toEqual([
      "env-a:draft",
      "env-a:thread-1",
    ]);
  });

  it("reorders custom workspaces and attached projects without inventing extra order arrays", () => {
    const { store, memory } = createPersistingStore();
    const alpha = store.getState().createWorkspace("Alpha")!;
    const beta = store.getState().createWorkspace("Beta")!;
    store.getState().attachProject(alpha, projectOne);
    store.getState().attachProject(alpha, projectTwo);

    store.getState().reorderWorkspaces([beta, alpha]);
    expect(store.getState().workspaces.map((workspace) => workspace.id)).toEqual([beta, alpha]);

    store
      .getState()
      .reorderProjects(alpha, [scopedProjectKey(projectTwo), scopedProjectKey(projectOne)]);
    expect(
      store.getState().workspaces.find((workspace) => workspace.id === alpha)?.projects,
    ).toEqual([projectTwo, projectOne]);

    const snapshot = parsedSnapshot(memory.getRaw());
    expect(snapshot).toMatchObject({
      version: 1,
      workspaces: [
        { id: beta, name: "Beta", projects: [] },
        { id: alpha, name: "Alpha", projects: [projectTwo, projectOne] },
      ],
    });
    expect(snapshot && typeof snapshot === "object" && "workspaceOrder" in snapshot).toBe(false);
  });

  it("skips no-op writes", () => {
    const { store, memory } = createPersistingStore();
    const alpha = store.getState().createWorkspace("Alpha")!;
    store.getState().attachProject(alpha, projectOne, lastKnownOne);
    store.getState().setThreadOrder(projectOne, ["env-a:thread-a"]);
    store.getState().selectWorkspace(alpha);
    const writeCount = memory.writes.length;

    store.getState().renameWorkspace(alpha, "Alpha");
    store.getState().selectWorkspace(alpha);
    store.getState().setThreadOrder(projectOne, ["env-a:thread-a"]);
    store.getState().updateLastKnown(projectOne, lastKnownOne);
    store.getState().setExpanded(alpha, scopedProjectKey(projectOne), false);
    store.getState().setExpanded(alpha, scopedProjectKey(projectOne), false);
    store.getState().reorderWorkspaces([alpha]);
    expect(memory.writes.length).toBe(writeCount + 1);
  });

  it("hydrates exclusive membership, invalid selection fallback, and retained offline project state", () => {
    const raw = JSON.stringify({
      version: 1,
      selectedWorkspaceId: "gone",
      workspaces: [
        {
          id: "dup",
          name: "First",
          projects: [projectOne, projectOne, projectTwo],
        },
        {
          id: "dup",
          name: "Dropped duplicate id",
          projects: [projectRemote],
        },
        {
          id: "second",
          name: "Second",
          projects: [projectOne, projectRemote],
        },
      ],
      projectStateByKey: {
        [scopedProjectKey(projectOne)]: {
          threadOrder: ["env-a:offline-thread"],
          lastKnown: lastKnownOne,
        },
      },
      expandedByWorkspaceId: {
        dup: { [scopedProjectKey(projectOne)]: false },
      },
    });
    const { store, memory } = createPersistingStore(raw);

    expect(store.getState().selectedWorkspaceId).toBeNull();
    expect(store.getState().workspaces).toEqual([
      { id: "dup", name: "First", projects: [projectOne, projectTwo] },
      { id: "second", name: "Second", projects: [projectRemote] },
    ]);
    expect(store.getState().projectStateByKey[scopedProjectKey(projectOne)]).toEqual({
      threadOrder: ["env-a:offline-thread"],
      lastKnown: lastKnownOne,
    });
    expect(parsedSnapshot(memory.getRaw())).toMatchObject({
      selectedWorkspaceId: null,
      workspaces: [
        { id: "dup", name: "First", projects: [projectOne, projectTwo] },
        { id: "second", name: "Second", projects: [projectRemote] },
      ],
    });
  });

  it("retains a future schema version and does not overwrite it after in-session edits", () => {
    const futureRaw = JSON.stringify({
      version: 2,
      selectedWorkspaceId: "future",
      workspaces: [{ id: "future", name: "From the future", projects: [] }],
    });
    const { store, memory } = createPersistingStore(futureRaw);

    expect(store.getState().storageError).toBe(WORKSPACE_PREFERENCES_LOAD_ERROR);
    expect(store.getState().workspaces).toEqual([]);
    const created = store.getState().createWorkspace("Local only");
    expect(created).toBe("workspace-1");
    expect(store.getState().workspaces).toHaveLength(1);
    expect(memory.getRaw()).toBe(futureRaw);
  });

  it("retains corrupt raw JSON and reports that preferences could not load", () => {
    const corruptRaw = '{"version":1, workspaces: [';
    const { store, memory } = createPersistingStore(corruptRaw);
    expect(store.getState().storageError).toBe(WORKSPACE_PREFERENCES_LOAD_ERROR);
    store.getState().createWorkspace("Temp");
    expect(memory.getRaw()).toBe(corruptRaw);
  });

  it("retains an unrecoverable v1 payload that fails schema validation", () => {
    const invalidRaw = JSON.stringify({
      version: 1,
      selectedWorkspaceId: 12,
      workspaces: [],
    });
    const { store, memory } = createPersistingStore(invalidRaw);
    expect(store.getState().storageError).toBe(WORKSPACE_PREFERENCES_LOAD_ERROR);
    store.getState().createWorkspace("Temp");
    expect(memory.getRaw()).toBe(invalidRaw);
  });

  it("keeps the session usable when persistence throws", () => {
    const storage: SidebarWorkspaceStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const store = createSidebarWorkspaceStore({
      persist: true,
      storage,
      generateId: () => "workspace-1",
    });
    expect(store.getState().createWorkspace("Alpha")).toBe("workspace-1");
    expect(store.getState().workspaces[0]?.name).toBe("Alpha");
    expect(store.getState().storageError).toBe(WORKSPACE_PREFERENCES_SAVE_ERROR);
  });

  it("does not read or write storage when persistence is disabled", () => {
    const memory = memoryStorage(
      JSON.stringify({
        version: 1,
        selectedWorkspaceId: null,
        workspaces: [{ id: "stored", name: "Stored", projects: [] }],
        projectStateByKey: {},
        expandedByWorkspaceId: {},
      }),
    );
    const store = createSidebarWorkspaceStore({
      persist: false,
      storage: memory.storage,
      generateId: () => "workspace-1",
    });
    expect(store.getState().workspaces).toEqual([]);
    store.getState().createWorkspace("Local");
    expect(memory.writes).toEqual([]);
    expect(store.getState().workspaces).toEqual([
      { id: "workspace-1", name: "Local", projects: [] },
    ]);
  });

  it("reports inaccessible localStorage instead of claiming that saves succeeded", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      const store = createSidebarWorkspaceStore({
        persist: true,
        generateId: () => "workspace-1",
      });
      expect(store.getState().storageError).toBe(WORKSPACE_PREFERENCES_LOAD_ERROR);
      expect(store.getState().workspaces).toEqual([]);
      expect(store.getState().createWorkspace("Alpha")).toBe("workspace-1");
      expect(store.getState().workspaces).toEqual([
        { id: "workspace-1", name: "Alpha", projects: [] },
      ]);
      expect(store.getState().storageError).toBe(WORKSPACE_PREFERENCES_LOAD_ERROR);
    } finally {
      restoreLocalStorage(previous);
    }
  });

  it("does not overwrite saved preferences when hydration reads fail but writes would succeed", () => {
    const existingRaw = JSON.stringify({
      version: 1,
      selectedWorkspaceId: "existing",
      workspaces: [{ id: "existing", name: "Existing", projects: [] }],
      projectStateByKey: {},
      expandedByWorkspaceId: {},
    });
    let raw: string | null = existingRaw;
    const storage: SidebarWorkspaceStorage = {
      getItem: () => {
        throw new Error("read failed");
      },
      setItem: (_key, value) => {
        raw = value;
      },
    };
    const store = createSidebarWorkspaceStore({
      persist: true,
      storage,
      generateId: () => "workspace-1",
    });
    expect(store.getState().storageError).toBe(WORKSPACE_PREFERENCES_LOAD_ERROR);
    expect(store.getState().workspaces).toEqual([]);
    expect(store.getState().createWorkspace("Session only")).toBe("workspace-1");
    expect(store.getState().workspaces).toEqual([
      { id: "workspace-1", name: "Session only", projects: [] },
    ]);
    expect(store.getState().storageError).toBe(WORKSPACE_PREFERENCES_LOAD_ERROR);
    expect(raw).toBe(existingRaw);
  });

  it("moves a retargeted draft between stored project orders without dropping offline keys", () => {
    const { store, memory } = createPersistingStore();
    const alpha = store.getState().createWorkspace("Alpha")!;
    store.getState().attachProject(alpha, projectOne, lastKnownOne);
    store.getState().attachProject(alpha, projectTwo, {
      title: "Beta repo",
      workspaceRoot: "/repos/beta",
      environmentLabel: "Local",
    });
    store
      .getState()
      .setThreadOrder(projectOne, ["env-a:offline-thread", "env-a:draft", "env-a:live"]);
    store.getState().setThreadOrder(projectTwo, ["env-a:other"]);

    store
      .getState()
      .reconcileDraftThreadOrders([
        { key: "env-a:draft", projectRef: projectTwo, createdAt: "2026-09-01T00:00:00.000Z" },
      ]);

    expect(store.getState().projectStateByKey[scopedProjectKey(projectOne)]?.threadOrder).toEqual([
      "env-a:offline-thread",
      "env-a:live",
    ]);
    expect(store.getState().projectStateByKey[scopedProjectKey(projectTwo)]?.threadOrder).toEqual([
      "env-a:draft",
      "env-a:other",
    ]);

    const snapshot = parsedSnapshot(memory.getRaw()) as {
      projectStateByKey: Record<string, { threadOrder: string[] }>;
    };
    expect(snapshot.projectStateByKey[scopedProjectKey(projectOne)]?.threadOrder).toEqual([
      "env-a:offline-thread",
      "env-a:live",
    ]);
  });

  it("persists a promotion-only order replacement", () => {
    const { store, memory } = createPersistingStore();
    const alpha = store.getState().createWorkspace("Alpha")!;
    store.getState().attachProject(alpha, projectOne, lastKnownOne);
    store.getState().setThreadOrder(projectOne, ["env-a:draft", "env-a:live"]);
    const writes = memory.writes.length;
    store.getState().setThreadOrder(projectOne, ["env-a:server", "env-a:live"]);
    expect(memory.writes.length).toBeGreaterThan(writes);
    expect(store.getState().projectStateByKey[scopedProjectKey(projectOne)]?.threadOrder).toEqual([
      "env-a:server",
      "env-a:live",
    ]);
  });

  it("persists retarget-then-promotion while the custom sidebar is absent", () => {
    const { store, memory } = createPersistingStore();
    const alpha = store.getState().createWorkspace("Alpha")!;
    store.getState().attachProject(alpha, projectOne, lastKnownOne);
    store.getState().attachProject(alpha, projectTwo, {
      title: "Beta repo",
      workspaceRoot: "/repos/beta",
      environmentLabel: "Local",
    });
    store
      .getState()
      .setThreadOrder(projectOne, ["env-a:offline-thread", "env-a:future", "env-a:live"]);
    store.getState().setThreadOrder(projectTwo, ["env-a:other"]);
    store.getState().selectWorkspace(null);

    store.getState().reconcileDraftThreadOrders([
      {
        key: "env-a:future",
        projectRef: projectTwo,
        createdAt: "2026-09-01T00:00:00.000Z",
        promotedToKey: "env-a:server",
      },
    ]);

    expect(store.getState().projectStateByKey[scopedProjectKey(projectOne)]?.threadOrder).toEqual([
      "env-a:offline-thread",
      "env-a:live",
    ]);
    expect(store.getState().projectStateByKey[scopedProjectKey(projectTwo)]?.threadOrder).toEqual([
      "env-a:server",
      "env-a:other",
    ]);
    const snapshot = parsedSnapshot(memory.getRaw()) as {
      projectStateByKey: Record<string, { threadOrder: string[] }>;
    };
    expect(snapshot.projectStateByKey[scopedProjectKey(projectTwo)]?.threadOrder).toEqual([
      "env-a:server",
      "env-a:other",
    ]);
  });

  it("drops pending reveal when the selected workspace changes or is deleted", () => {
    const { store } = createPersistingStore();
    const alpha = store.getState().createWorkspace("Alpha")!;
    const beta = store.getState().createWorkspace("Beta")!;
    store.getState().selectWorkspace(alpha);
    requestWorkspaceThreadReveal({ workspaceId: alpha, threadKey: "env-a:hidden" });
    store.getState().selectWorkspace(beta);
    expect(peekPendingWorkspaceThreadReveal()).toBeNull();
    store.getState().selectWorkspace(alpha);
    requestWorkspaceThreadReveal({ workspaceId: alpha, threadKey: "env-a:hidden" });
    store.getState().deleteWorkspace(alpha);
    expect(peekPendingWorkspaceThreadReveal()).toBeNull();
  });

  it("drops a pending reveal when its project is detached or moved", () => {
    const { store } = createPersistingStore();
    const alpha = store.getState().createWorkspace("Alpha")!;
    const beta = store.getState().createWorkspace("Beta")!;
    store.getState().attachProject(alpha, projectOne);
    store.getState().attachProject(beta, projectTwo);

    store.getState().selectWorkspace(alpha);
    requestWorkspaceThreadReveal({
      workspaceId: alpha,
      projectKey: scopedProjectKey(projectOne),
      threadKey: "env-a:hidden",
    });
    store.getState().detachProject(alpha, projectOne);
    expect(peekPendingWorkspaceThreadReveal()).toBeNull();

    store.getState().attachProject(alpha, projectOne);
    requestWorkspaceThreadReveal({
      workspaceId: alpha,
      projectKey: scopedProjectKey(projectOne),
      threadKey: "env-a:hidden-again",
    });
    expect(store.getState().moveProject(projectOne, alpha, beta)).toBe(true);
    expect(peekPendingWorkspaceThreadReveal()).toBeNull();
  });

  it("ignores per-keystroke and unrelated composer changes in the order signature", () => {
    const session = {
      threadId: ThreadId.make("draft-thread"),
      environmentId: envA,
      projectId: projectOne.projectId,
      logicalProjectKey: "logical-alpha",
      createdAt: "2026-09-19T10:00:00.000Z",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      envMode: "local",
      startFromOrigin: false,
      promotedTo: null,
    } satisfies DraftThreadState;
    const emptyDraft = createEmptyThreadDraft();
    const investedDraft = { ...emptyDraft, prompt: "first" };
    const first = {
      draftsByThreadKey: { draft: investedDraft },
      draftThreadsByThreadKey: { draft: session },
    };
    let reconciliations = 0;

    expect(
      draftOrderReconciliationSignature({
        ...first,
        draftsByThreadKey: { draft: { ...investedDraft, prompt: "second" } },
      }),
    ).toBe(draftOrderReconciliationSignature(first));
    expect(
      draftOrderReconciliationSignature({
        ...first,
        draftsByThreadKey: { draft: emptyDraft },
      }),
    ).not.toBe(draftOrderReconciliationSignature(first));
    expect(
      draftOrderReconciliationSignature({
        ...first,
        draftThreadsByThreadKey: {
          draft: { ...session, projectId: projectTwo.projectId },
        },
      }),
    ).not.toBe(draftOrderReconciliationSignature(first));
    const promoted = {
      ...session,
      promotedTo: { environmentId: envA, threadId: ThreadId.make("server-thread") },
    } satisfies DraftThreadState;
    expect(
      draftOrderReconciliationSignature({
        draftsByThreadKey: { draft: { ...investedDraft, prompt: "promoted-a" } },
        draftThreadsByThreadKey: { draft: promoted },
      }),
    ).toBe(
      draftOrderReconciliationSignature({
        draftsByThreadKey: { draft: { ...investedDraft, prompt: "promoted-b" } },
        draftThreadsByThreadKey: { draft: promoted },
      }),
    );

    let signature = draftOrderReconciliationSignature(first);
    signature = reconcileDraftOrderChangesIfNeeded(
      signature,
      { ...first, draftsByThreadKey: { draft: { ...investedDraft, prompt: "third" } } },
      () => {
        reconciliations += 1;
      },
    );
    expect(reconciliations).toBe(0);
    signature = reconcileDraftOrderChangesIfNeeded(
      signature,
      {
        ...first,
        draftThreadsByThreadKey: { draft: { ...session, projectId: projectTwo.projectId } },
      },
      () => {
        reconciliations += 1;
      },
    );
    expect(reconciliations).toBe(1);
  });
});

function restoreLocalStorage(previous: PropertyDescriptor | undefined) {
  if (previous) {
    Object.defineProperty(globalThis, "localStorage", previous);
    return;
  }
  Reflect.deleteProperty(globalThis, "localStorage");
}

describe("sidebarWorkspaceViewStore", () => {
  it("keeps per-workspace view state in memory and defaults pagination to three", () => {
    const store = createSidebarWorkspaceViewStore();
    expect(workspaceViewStoreKey(null)).toBe(DEFAULT_WORKSPACE_VIEW_KEY);
    expect(store.getState().getView(null)).toEqual({
      query: "",
      scrollTop: 0,
      settledLimitByProjectKey: {},
      snoozedExpandedByProjectKey: {},
    });
    expect(resolveSettledLimitForProject(store.getState().getView(null), "env-a:project-1")).toBe(
      DEFAULT_SETTLED_VISIBLE_LIMIT,
    );

    store.getState().patchView("workspace-1", {
      query: "auth",
      settledLimitByProjectKey: { "env-a:project-1": 6 },
    });
    store.getState().patchView(null, { query: "default-search", scrollTop: 40 });
    expect(store.getState().getView("workspace-1").query).toBe("auth");
    expect(store.getState().getView(null).query).toBe("default-search");
    expect(
      resolveSettledLimitForProject(store.getState().getView("workspace-1"), "env-a:project-1"),
    ).toBe(6);

    store.getState().forgetView("workspace-1");
    expect(store.getState().getView("workspace-1").query).toBe("");
  });

  it("returns a stable EMPTY or stored snapshot across unchanged getView reads", () => {
    const store = createSidebarWorkspaceViewStore();
    const missingFirst = store.getState().getView(null);
    const missingSecond = store.getState().getView("missing");
    expect(missingFirst).toBe(EMPTY_SIDEBAR_WORKSPACE_VIEW);
    expect(missingSecond).toBe(EMPTY_SIDEBAR_WORKSPACE_VIEW);
    expect(store.getState().getView(null)).toBe(missingFirst);

    store.getState().patchView("workspace-1", { query: "auth" });
    const storedFirst = store.getState().getView("workspace-1");
    const storedSecond = store.getState().getView("workspace-1");
    expect(storedFirst).toBe(storedSecond);
    expect(storedFirst).not.toBe(EMPTY_SIDEBAR_WORKSPACE_VIEW);
    expect(storedFirst.query).toBe("auth");

    store.getState().patchView("workspace-1", { query: "auth" });
    expect(store.getState().getView("workspace-1")).toBe(storedFirst);

    store.getState().patchView("workspace-1", { query: "next" });
    const afterChange = store.getState().getView("workspace-1");
    expect(afterChange).not.toBe(storedFirst);
    expect(afterChange.query).toBe("next");
    expect(store.getState().getView("workspace-1")).toBe(afterChange);

    store.getState().forgetView("workspace-1");
    expect(store.getState().getView("workspace-1")).toBe(EMPTY_SIDEBAR_WORKSPACE_VIEW);
  });

  it("resolves folder expansion with a visible default", () => {
    expect(resolveFolderExpanded({}, "workspace-1", "env-a:project-1")).toBe(true);
    expect(
      resolveFolderExpanded(
        { "workspace-1": { "env-a:project-1": false } },
        "workspace-1",
        "env-a:project-1",
      ),
    ).toBe(false);
  });
});
