import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyWorkspaceVisibleKeysReport,
  evaluateWorkspaceBulkProject,
  isUnchangedWorkspaceBulkSelection,
  isWorkspaceBulkTitleRegenerationEligible,
  rebuildWorkspaceVisibleOrders,
  resolveWorkspaceBulkSelection,
  staleWorkspaceSelectionKeys,
  workspaceBulkBlockedMessage,
  workspaceBulkHasRunningThread,
  workspaceBulkTitleRegenerationMenu,
  workspaceThreadPointerAction,
  type WorkspaceVisibleKeysMaps,
} from "./workspaceSelection";
import { retainEqualStringArray, sameStringArrays } from "./workspaceUi";

function emptyMaps(): WorkspaceVisibleKeysMaps {
  return {
    keysByProject: new Map(),
    draftIdByKey: new Map(),
    projectDraftKeys: new Map(),
    liveByProject: new Map(),
  };
}

function shell(input: {
  environmentId: string;
  projectId: string;
  threadId: string;
  titleRegeneration?: EnvironmentThreadShell["titleRegeneration"];
  session?: EnvironmentThreadShell["session"];
}): EnvironmentThreadShell {
  return {
    id: ThreadId.make(input.threadId),
    projectId: ProjectId.make(input.projectId),
    environmentId: EnvironmentId.make(input.environmentId),
    title: input.threadId,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    session: input.session ?? null,
    ...(input.titleRegeneration !== undefined
      ? { titleRegeneration: input.titleRegeneration }
      : {}),
  };
}

describe("workspace visible-key reporting", () => {
  it("keeps equal visible-order contents while still updating drafts", () => {
    const maps = emptyMaps();
    applyWorkspaceVisibleKeysReport(maps, ["p1", "p2"], "p1", {
      keys: ["p1:a", "p1:draft"],
      drafts: new Map([["p1:draft", "draft-1"]]),
      live: true,
    });
    const afterBoth = applyWorkspaceVisibleKeysReport(maps, ["p1", "p2"], "p2", {
      keys: ["p2:b"],
      drafts: new Map(),
      live: true,
    });
    const previousVisible = afterBoth.visibleOrder;
    const second = applyWorkspaceVisibleKeysReport(maps, ["p1", "p2"], "p1", {
      keys: ["p1:a", "p1:draft"],
      drafts: new Map([["p1:draft", "draft-2"]]),
      live: true,
    });
    expect(second.visibleOrder).toEqual(["p1:a", "p1:draft", "p2:b"]);
    expect(sameStringArrays(previousVisible, second.visibleOrder)).toBe(true);
    expect(retainEqualStringArray(previousVisible, second.visibleOrder)).toBe(previousVisible);
    expect(maps.draftIdByKey.get("p1:draft")).toBe("draft-2");
    expect(second.selectionOrder).toEqual(["p1:a", "p2:b"]);
  });

  it("rebuilds membership order and drops detached project keys, drafts, and selection", () => {
    const maps = emptyMaps();
    applyWorkspaceVisibleKeysReport(maps, ["p1", "p2"], "p1", {
      keys: ["p1:a", "p1:draft"],
      drafts: new Map([["p1:draft", "draft-1"]]),
      live: true,
    });
    applyWorkspaceVisibleKeysReport(maps, ["p1", "p2"], "p2", {
      keys: ["p2:b"],
      drafts: new Map(),
      live: true,
    });
    const reordered = rebuildWorkspaceVisibleOrders(maps, ["p2", "p1"]);
    expect(reordered.visibleOrder).toEqual(["p2:b", "p1:a", "p1:draft"]);
    expect(reordered.selectionOrder).toEqual(["p2:b", "p1:a"]);

    const detached = rebuildWorkspaceVisibleOrders(maps, ["p2"]);
    expect(detached.visibleOrder).toEqual(["p2:b"]);
    expect(detached.selectionOrder).toEqual(["p2:b"]);
    expect(maps.draftIdByKey.has("p1:draft")).toBe(false);
    expect(maps.keysByProject.has("p1")).toBe(false);
    expect(
      staleWorkspaceSelectionKeys({
        selectedKeys: ["p1:a", "p2:b"],
        selectionOrder: detached.selectionOrder,
      }),
    ).toEqual(["p1:a"]);
  });

  it("omits offline and draft keys from selection order while keeping them visible", () => {
    const maps = emptyMaps();
    applyWorkspaceVisibleKeysReport(maps, ["live", "offline"], "live", {
      keys: ["t1", "draft"],
      drafts: new Map([["draft", "d1"]]),
      live: true,
    });
    const orders = applyWorkspaceVisibleKeysReport(maps, ["live", "offline"], "offline", {
      keys: ["t2"],
      drafts: new Map(),
      live: false,
    });
    expect(orders.visibleOrder).toEqual(["t1", "draft", "t2"]);
    expect(orders.selectionOrder).toEqual(["t1"]);
  });
});

describe("workspace pointer and bulk selection", () => {
  it("uses coherent workspace order for range and skips drafts and offline rows", () => {
    expect(
      workspaceThreadPointerAction({
        modClick: true,
        shiftClick: false,
        liveAttachedThread: true,
      }),
    ).toBe("toggle");
    expect(
      workspaceThreadPointerAction({
        modClick: false,
        shiftClick: true,
        liveAttachedThread: true,
      }),
    ).toBe("range");
    expect(
      workspaceThreadPointerAction({
        modClick: true,
        shiftClick: true,
        liveAttachedThread: false,
      }),
    ).toBe("navigate");
  });

  it("resolves every selected live attached thread across projects and environments", () => {
    const local = shell({ environmentId: "env-local", projectId: "proj-a", threadId: "t1" });
    const remote = shell({ environmentId: "env-remote", projectId: "proj-b", threadId: "t2" });
    const byKey = new Map([
      ["env-local:t1", local],
      ["env-remote:t2", remote],
    ]);
    const resolved = resolveWorkspaceBulkSelection({
      selectedKeys: ["env-local:t1", "env-remote:t2"],
      isDraftKey: () => false,
      getThread: (key) => byKey.get(key),
      evaluateProject: () => "live",
    });
    expect(resolved).toEqual({
      status: "ready",
      threadKeys: ["env-local:t1", "env-remote:t2"],
      threads: [local, remote],
    });
  });

  it("does not drop unresolved keys to act on a smaller live subset", () => {
    const live = shell({ environmentId: "env-local", projectId: "proj-a", threadId: "t1" });
    const resolved = resolveWorkspaceBulkSelection({
      selectedKeys: ["env-local:t1", "env-remote:missing"],
      isDraftKey: (key) => key.endsWith("draft"),
      getThread: (key) => (key === "env-local:t1" ? live : undefined),
      evaluateProject: () => "live",
    });
    expect(resolved).toEqual({
      status: "blocked",
      reason: "unresolved",
      selectedCount: 2,
      resolvedCount: 1,
    });
    expect(workspaceBulkBlockedMessage("unresolved").length).toBeGreaterThan(0);
  });

  it("blocks drafts and offline members instead of mutating the live remainder", () => {
    const live = shell({ environmentId: "env-local", projectId: "proj-a", threadId: "t1" });
    const offline = shell({ environmentId: "env-remote", projectId: "proj-b", threadId: "t2" });
    expect(
      resolveWorkspaceBulkSelection({
        selectedKeys: ["env-local:t1", "env-local:draft"],
        isDraftKey: (key) => key.endsWith("draft"),
        getThread: (key) => (key === "env-local:t1" ? live : undefined),
        evaluateProject: () => "live",
      }).status,
    ).toBe("blocked");
    expect(
      resolveWorkspaceBulkSelection({
        selectedKeys: ["env-local:t1", "env-remote:t2"],
        isDraftKey: () => false,
        getThread: (key) => (key === "env-local:t1" ? live : offline),
        evaluateProject: (projectKey) =>
          projectKey === scopedProjectKey(scopeProjectRef(live.environmentId, live.projectId))
            ? "live"
            : "offline",
      }),
    ).toMatchObject({ status: "blocked", reason: "offline", selectedCount: 2, resolvedCount: 1 });
  });
});

describe("action-time workspace membership and capabilities", () => {
  const projectA = scopeProjectRef(EnvironmentId.make("env-local"), ProjectId.make("proj-a"));
  const projectB = scopeProjectRef(EnvironmentId.make("env-remote"), ProjectId.make("proj-b"));
  const workspace = { id: "ws-1", projects: [projectA, projectB] };

  it("cancels when the selected workspace changed and blocks detach, missing project, and offline", () => {
    expect(
      evaluateWorkspaceBulkProject({
        initiatingWorkspaceId: "ws-1",
        selectedWorkspaceId: "ws-2",
        workspace,
        projectKey: scopedProjectKey(projectA),
        projectExists: true,
        connected: true,
      }),
    ).toBe("cancelled");
    expect(
      evaluateWorkspaceBulkProject({
        initiatingWorkspaceId: "ws-1",
        selectedWorkspaceId: "ws-1",
        workspace: { id: "ws-1", projects: [projectB] },
        projectKey: scopedProjectKey(projectA),
        projectExists: true,
        connected: true,
      }),
    ).toBe("not-attached");
    expect(
      evaluateWorkspaceBulkProject({
        initiatingWorkspaceId: "ws-1",
        selectedWorkspaceId: "ws-1",
        workspace,
        projectKey: scopedProjectKey(projectA),
        projectExists: false,
        connected: true,
      }),
    ).toBe("missing-project");
    expect(
      evaluateWorkspaceBulkProject({
        initiatingWorkspaceId: "ws-1",
        selectedWorkspaceId: "ws-1",
        workspace,
        projectKey: scopedProjectKey(projectA),
        projectExists: true,
        connected: false,
      }),
    ).toBe("offline");
    expect(
      evaluateWorkspaceBulkProject({
        initiatingWorkspaceId: "ws-1",
        selectedWorkspaceId: "ws-1",
        workspace,
        projectKey: scopedProjectKey(projectA),
        projectExists: true,
        connected: true,
      }),
    ).toBe("live");
  });

  it("rejects a mutation when membership or connection changed after the menu opened", () => {
    const live = shell({ environmentId: "env-local", projectId: "proj-a", threadId: "t1" });
    const opened = resolveWorkspaceBulkSelection({
      selectedKeys: ["env-local:t1"],
      isDraftKey: () => false,
      getThread: () => live,
      evaluateProject: () => "live",
    });
    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") return;
    expect(
      isUnchangedWorkspaceBulkSelection(
        opened,
        resolveWorkspaceBulkSelection({
          selectedKeys: opened.threadKeys,
          isDraftKey: () => false,
          getThread: () => live,
          evaluateProject: () => "not-attached",
        }),
      ),
    ).toBe(false);
    expect(
      resolveWorkspaceBulkSelection({
        selectedKeys: opened.threadKeys,
        isDraftKey: () => false,
        getThread: () => live,
        evaluateProject: () => "cancelled",
      }).status,
    ).toBe("cancelled");
    expect(
      resolveWorkspaceBulkSelection({
        selectedKeys: opened.threadKeys,
        isDraftKey: () => false,
        getThread: () => live,
        evaluateProject: () => "offline",
      }),
    ).toMatchObject({ status: "blocked", reason: "offline" });
  });

  it("offers enabled title regeneration only when the whole selection is eligible", () => {
    const local = shell({ environmentId: "env-local", projectId: "proj-a", threadId: "t1" });
    const remote = shell({ environmentId: "env-remote", projectId: "proj-b", threadId: "t2" });
    const supports = new Set([local.environmentId, remote.environmentId]);
    expect(
      isWorkspaceBulkTitleRegenerationEligible({
        threads: [local, remote],
        supportsTitleRegeneration: (environmentId) => supports.has(environmentId),
      }),
    ).toBe(true);
    expect(
      workspaceBulkTitleRegenerationMenu({
        count: 2,
        allSupport: true,
        anyRegenerating: false,
      }),
    ).toEqual({ id: "regenerate-title", label: "Regenerate titles (2)" });

    supports.delete(remote.environmentId);
    expect(
      isWorkspaceBulkTitleRegenerationEligible({
        threads: [local, remote],
        supportsTitleRegeneration: (environmentId) => supports.has(environmentId),
      }),
    ).toBe(false);
    expect(
      workspaceBulkTitleRegenerationMenu({
        count: 2,
        allSupport: false,
        anyRegenerating: false,
      }),
    ).toBeNull();

    const regenerating = shell({
      environmentId: "env-local",
      projectId: "proj-a",
      threadId: "t1",
      titleRegeneration: {
        requestId: CommandId.make("cmd-1"),
        startedAt: "2026-09-18T00:00:00.000Z",
      },
    });
    expect(
      isWorkspaceBulkTitleRegenerationEligible({
        threads: [regenerating, remote],
        supportsTitleRegeneration: () => true,
      }),
    ).toBe(false);
    expect(
      workspaceBulkTitleRegenerationMenu({
        count: 2,
        allSupport: true,
        anyRegenerating: true,
      }),
    ).toEqual({
      id: "regenerate-title",
      label: "Regenerating… (2)",
      disabled: true,
    });
  });

  it("treats a later running thread as an archive block", () => {
    const idle = shell({ environmentId: "env-local", projectId: "proj-a", threadId: "t1" });
    const running = shell({
      environmentId: "env-remote",
      projectId: "proj-b",
      threadId: "t2",
      session: {
        threadId: ThreadId.make("t2"),
        status: "running",
        providerName: null,
        runtimeMode: "full-access",
        activeTurnId: TurnId.make("turn-1"),
        lastError: null,
        updatedAt: "2026-09-18T00:00:00.000Z",
      },
    });
    expect(workspaceBulkHasRunningThread([idle])).toBe(false);
    expect(workspaceBulkHasRunningThread([idle, running])).toBe(true);
  });
});
