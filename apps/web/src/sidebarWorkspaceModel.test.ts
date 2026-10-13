import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyCanonicalGroupSlotMove,
  applyDraftPromotionToOrder,
  planDraftOrderMembership,
  applyWorkspaceStatusGroupReorder,
  buildWorkspaceProjectThreadView,
  classifyWorkspaceThread,
  classifyWorkspaceThreadGroup,
  DEFAULT_SETTLED_VISIBLE_LIMIT,
  partitionWorkspaceThreadKeys,
  reconcileWorkspaceThreadOrder,
  shouldPersistReconciledOrder,
  isWorkspaceSearchActive,
  nextSettledVisibleLimit,
  planWorkspaceThreadDrag,
  reconcileCanonicalThreadOrder,
  resetSettledVisibleLimit,
  resolveWorkspaceProjectPresentation,
  revealSettledLimitThroughKey,
  searchWorkspaceThreadsByTitle,
  seedCanonicalThreadOrder,
  shouldIncludeWorkspaceDraft,
  transferThreadKeyBetweenOrders,
  visibleSettledKeys,
  type WorkspaceClassifiableThread,
} from "./sidebarWorkspaceModel";

const NOW = "2026-04-10T12:00:00.000Z";
const FRESH = "2026-04-10T11:00:00.000Z";
const STALE = "2026-04-01T00:00:00.000Z";

function makeThread(
  overrides: Partial<WorkspaceClassifiableThread> & Pick<WorkspaceClassifiableThread, "id">,
): WorkspaceClassifiableThread {
  const base: OrchestrationThreadShell = {
    id: overrides.id,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
  return {
    ...base,
    capabilities: { supportsSettlement: true, supportsSnooze: true },
    ...overrides,
  };
}

const settleOptions = {
  now: NOW,
  snoozeNow: NOW,
  autoSettleAfterDays: 3 as const,
};

describe("classifyWorkspaceThread", () => {
  it("excludes archived chats from ordinary rows", () => {
    const thread = makeThread({
      id: ThreadId.make("archived"),
      archivedAt: NOW,
      settledOverride: "settled",
    });
    expect(classifyWorkspaceThread(thread, settleOptions)).toBe("archived");
    expect(classifyWorkspaceThreadGroup(thread, settleOptions)).toBe("hidden");
  });

  it("lets snooze outrank settlement while the wake time is in the future", () => {
    const thread = makeThread({
      id: ThreadId.make("snoozed"),
      settledOverride: "settled",
      snoozedUntil: "2026-04-11T00:00:00.000Z",
      snoozedAt: FRESH,
    });
    expect(classifyWorkspaceThread(thread, settleOptions)).toBe("snoozed");
  });

  it("does not auto-settle a completed agent turn", () => {
    const thread = makeThread({
      id: ThreadId.make("completed"),
      latestUserMessageAt: FRESH,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: FRESH,
        startedAt: FRESH,
        completedAt: FRESH,
        assistantMessageId: null,
      },
    });
    expect(classifyWorkspaceThread(thread, settleOptions)).toBe("active");
  });

  it("keeps pinned chats in the active group for custom manual order", () => {
    const thread = makeThread({
      id: ThreadId.make("pinned"),
      pinnedAt: FRESH,
      latestUserMessageAt: FRESH,
    });
    expect(classifyWorkspaceThread(thread, settleOptions)).toBe("active");
  });

  it("requires settlement capability before classifying as settled", () => {
    const stale = makeThread({
      id: ThreadId.make("stale"),
      latestUserMessageAt: STALE,
      capabilities: { supportsSettlement: false, supportsSnooze: false },
    });
    expect(classifyWorkspaceThread(stale, settleOptions)).toBe("active");

    const capable = makeThread({
      id: ThreadId.make("stale"),
      latestUserMessageAt: STALE,
    });
    expect(classifyWorkspaceThread(capable, settleOptions)).toBe("settled");
    expect(classifyWorkspaceThreadGroup(capable, settleOptions)).toBe("settled");
  });

  it("settles a merged change request only while auto-settle-on-merge remains enabled", () => {
    const thread = makeThread({
      id: ThreadId.make("merged"),
      latestUserMessageAt: FRESH,
      changeRequest: { state: "merged", updatedAt: NOW },
    });
    expect(classifyWorkspaceThread(thread, settleOptions)).toBe("settled");
    expect(classifyWorkspaceThread(thread, { ...settleOptions, autoSettleOnMerge: true })).toBe(
      "settled",
    );
    expect(classifyWorkspaceThread(thread, { ...settleOptions, autoSettleOnMerge: false })).toBe(
      "active",
    );
  });
});

describe("canonical thread order", () => {
  it("seeds first-attach order from the current sidebar display order", () => {
    expect(seedCanonicalThreadOrder(["B", "A", "B", "", "C"])).toEqual(["B", "A", "C"]);
  });

  it("prepends a new batch by creation time without reshuffling known keys", () => {
    const storedOrder = ["A", "S1", "B"];
    const first = reconcileCanonicalThreadOrder({
      storedOrder,
      presentKeys: ["A", "S1", "B"],
      createdAtByKey: {
        A: "2026-01-01T00:00:00.000Z",
        B: "2026-04-10T00:00:00.000Z",
        S1: "2026-02-01T00:00:00.000Z",
      },
    });
    expect(first).toEqual({ order: ["A", "S1", "B"], changed: false });

    const incoming = reconcileCanonicalThreadOrder({
      storedOrder,
      presentKeys: ["A", "S1", "B", "N1", "N2"],
      createdAtByKey: {
        A: "2026-04-10T12:00:00.000Z",
        B: "2026-04-10T12:00:00.000Z",
        S1: "2026-04-10T12:00:00.000Z",
        N1: "2026-04-10T11:00:00.000Z",
        N2: "2026-04-10T12:00:00.000Z",
      },
    });
    expect(incoming.order).toEqual(["N2", "N1", "A", "S1", "B"]);
    expect(incoming.changed).toBe(true);
    expect(
      reconcileWorkspaceThreadOrder({
        existingKeys: storedOrder,
        incoming: [
          { key: "A", createdAt: "2026-04-10T12:00:00.000Z" },
          { key: "S1", createdAt: "2026-04-10T12:00:00.000Z" },
          { key: "B", createdAt: "2026-04-10T12:00:00.000Z" },
          { key: "N1", createdAt: "2026-04-10T11:00:00.000Z" },
          { key: "N2", createdAt: "2026-04-10T12:00:00.000Z" },
        ],
      }),
    ).toEqual(["N2", "N1", "A", "S1", "B"]);
    expect(shouldPersistReconciledOrder(storedOrder, incoming.order)).toBe(true);
  });

  it("retains currently absent keys and uses scoped key as a new-batch tiebreaker", () => {
    const result = reconcileCanonicalThreadOrder({
      storedOrder: ["A", "offline", "B"],
      presentKeys: ["A", "B", "N-b", "N-a"],
      createdAtByKey: {
        "N-a": "2026-04-10T12:00:00.000Z",
        "N-b": "2026-04-10T12:00:00.000Z",
      },
    });
    expect(result.order).toEqual(["N-a", "N-b", "A", "offline", "B"]);
  });
});

describe("canonical group-slot drag", () => {
  it("moves B before A while leaving hidden settled keys in their slots", () => {
    expect(
      applyCanonicalGroupSlotMove({
        canonicalOrder: ["A", "S1", "B", "S2"],
        movableKeys: ["A", "B"],
        nextMovableOrder: ["B", "A"],
      }),
    ).toEqual(["B", "S1", "A", "S2"]);
  });

  it("keeps hidden settled keys in place when a visible subset is dragged", () => {
    expect(
      applyCanonicalGroupSlotMove({
        canonicalOrder: ["S1", "S2", "S3", "S4", "S5", "S6", "S7"],
        movableKeys: ["S1", "S2", "S3"],
        nextMovableOrder: ["S3", "S1", "S2"],
      }),
    ).toEqual(["S3", "S1", "S2", "S4", "S5", "S6", "S7"]);
  });

  it("rejects cross-project and cross-group drops", () => {
    expect(
      planWorkspaceThreadDrag({
        canonicalOrder: ["A", "B"],
        sourceProjectKey: "env-a:project-1",
        targetProjectKey: "env-a:project-2",
        sourceGroup: "active",
        targetGroup: "active",
        sourceKey: "A",
        targetKey: "B",
        movableKeys: ["A", "B"],
      }),
    ).toBeNull();
    expect(
      planWorkspaceThreadDrag({
        canonicalOrder: ["A", "S1"],
        sourceProjectKey: "env-a:project-1",
        targetProjectKey: "env-a:project-1",
        sourceGroup: "active",
        targetGroup: "settled",
        sourceKey: "A",
        targetKey: "S1",
        movableKeys: ["A"],
      }),
    ).toBeNull();
  });

  it("plans an in-group move using occupied slots only", () => {
    expect(
      planWorkspaceThreadDrag({
        canonicalOrder: ["A", "S1", "B", "S2"],
        sourceProjectKey: "env-a:project-1",
        targetProjectKey: "env-a:project-1",
        sourceGroup: "active",
        targetGroup: "active",
        sourceKey: "B",
        targetKey: "A",
        movableKeys: ["A", "B"],
      }),
    ).toEqual({ nextOrder: ["B", "S1", "A", "S2"] });
    expect(
      applyWorkspaceStatusGroupReorder({
        canonicalKeys: ["A", "S1", "B", "S2"],
        groupKeys: ["A", "B"],
        activeId: "B",
        overId: "A",
      }),
    ).toEqual(["B", "S1", "A", "S2"]);
    expect(
      partitionWorkspaceThreadKeys({
        orderedKeys: ["A", "S1", "B", "S2"],
        statusByKey: new Map([
          ["A", "active"],
          ["B", "active"],
          ["S1", "settled"],
          ["S2", "settled"],
        ]),
      }),
    ).toEqual({ active: ["A", "B"], snoozed: [], settled: ["S1", "S2"] });
  });
});

describe("draft identity", () => {
  it("hides empty abandoned drafts and keeps drafts with user content", () => {
    expect(shouldIncludeWorkspaceDraft({ hasUserContent: false })).toBe(false);
    expect(shouldIncludeWorkspaceDraft({ hasUserContent: true })).toBe(true);
  });

  it("replaces a distinct draft key atomically and collapses a duplicate server row", () => {
    expect(applyDraftPromotionToOrder(["draft", "A", "B"], "draft", "draft")).toEqual([
      "draft",
      "A",
      "B",
    ]);
    expect(applyDraftPromotionToOrder(["draft", "A", "B"], "draft", "server")).toEqual([
      "server",
      "A",
      "B",
    ]);
    expect(applyDraftPromotionToOrder(["draft", "A", "server", "B"], "draft", "server")).toEqual([
      "server",
      "A",
      "B",
    ]);
  });

  it("moves a retargeted draft key without altering other order membership", () => {
    expect(
      transferThreadKeyBetweenOrders({
        fromOrder: ["draft", "A"],
        toOrder: ["B"],
        key: "draft",
      }),
    ).toEqual({
      fromOrder: ["A"],
      toOrder: ["draft", "B"],
    });
  });

  it("removes a retargeted draft from the old project without dropping offline threads", () => {
    expect(
      planDraftOrderMembership({
        ordersByProjectKey: {
          "env:old": ["env:offline", "env:draft", "env:live"],
          "env:new": ["env:other"],
          "env:unrelated": ["env:keep"],
        },
        drafts: [
          { key: "env:draft", projectKey: "env:new", createdAt: "2026-09-01T00:00:00.000Z" },
        ],
      }),
    ).toEqual({
      "env:old": ["env:offline", "env:live"],
      "env:new": ["env:draft", "env:other"],
      "env:unrelated": ["env:keep"],
    });
  });

  it("leaves an unseeded destination empty so first attachment can still seed", () => {
    expect(
      planDraftOrderMembership({
        ordersByProjectKey: {
          "env:old": ["env:offline", "env:draft"],
          "env:new": [],
        },
        drafts: [
          { key: "env:draft", projectKey: "env:new", createdAt: "2026-09-01T00:00:00.000Z" },
        ],
      }),
    ).toEqual({
      "env:old": ["env:offline"],
      "env:new": [],
    });
  });

  it("prepends unseen multi-draft batches by creation desc with scoped-key tie", () => {
    expect(
      planDraftOrderMembership({
        ordersByProjectKey: {
          "env:p": ["env:known"],
        },
        drafts: [
          { key: "env:older", projectKey: "env:p", createdAt: "2026-01-01T00:00:00.000Z" },
          { key: "env:newer", projectKey: "env:p", createdAt: "2026-09-01T00:00:00.000Z" },
          { key: "env:tie-b", projectKey: "env:p", createdAt: "2026-08-01T00:00:00.000Z" },
          { key: "env:tie-a", projectKey: "env:p", createdAt: "2026-08-01T00:00:00.000Z" },
        ],
      })["env:p"],
    ).toEqual(["env:newer", "env:tie-a", "env:tie-b", "env:older", "env:known"]);
  });

  it("preserves a known draft position and only prepends unseen siblings", () => {
    expect(
      planDraftOrderMembership({
        ordersByProjectKey: {
          "env:p": ["env:older", "env:known"],
        },
        drafts: [
          { key: "env:older", projectKey: "env:p", createdAt: "2026-01-01T00:00:00.000Z" },
          { key: "env:newer", projectKey: "env:p", createdAt: "2026-09-01T00:00:00.000Z" },
        ],
      })["env:p"],
    ).toEqual(["env:newer", "env:older", "env:known"]);
  });

  it("applies retarget then promotion across saved orders without dropping offline keys", () => {
    expect(
      planDraftOrderMembership({
        ordersByProjectKey: {
          "env:old": ["env:offline", "env:future", "env:live"],
          "env:new": ["env:other"],
        },
        drafts: [
          {
            key: "env:future",
            projectKey: "env:new",
            createdAt: "2026-09-01T00:00:00.000Z",
            promotedToKey: "env:server",
          },
        ],
      }),
    ).toEqual({
      "env:old": ["env:offline", "env:live"],
      "env:new": ["env:server", "env:other"],
    });
  });

  it("replaces a promoted identity in place when it already occupies the target", () => {
    expect(
      planDraftOrderMembership({
        ordersByProjectKey: {
          "env:p": ["env:future", "env:offline"],
        },
        drafts: [
          {
            key: "env:future",
            projectKey: "env:p",
            createdAt: "2026-09-01T00:00:00.000Z",
            promotedToKey: "env:server",
          },
        ],
      })["env:p"],
    ).toEqual(["env:server", "env:offline"]);
  });
});

describe("pagination, search, and reveal", () => {
  const settled = ["S1", "S2", "S3", "S4", "S5", "S6", "S7"];

  it("shows three, then six, then all seven settled chats, and Show Less returns to three", () => {
    expect(visibleSettledKeys(settled, DEFAULT_SETTLED_VISIBLE_LIMIT)).toEqual(["S1", "S2", "S3"]);
    const afterOne = nextSettledVisibleLimit(DEFAULT_SETTLED_VISIBLE_LIMIT);
    expect(visibleSettledKeys(settled, afterOne)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
    const afterTwo = nextSettledVisibleLimit(afterOne);
    expect(visibleSettledKeys(settled, afterTwo)).toEqual(settled);
    expect(resetSettledVisibleLimit()).toBe(DEFAULT_SETTLED_VISIBLE_LIMIT);
  });

  it("reveals a hidden settled row through its manual position in load-more steps", () => {
    expect(
      revealSettledLimitThroughKey({
        settledKeys: settled,
        targetKey: "S5",
        currentLimit: 3,
      }),
    ).toEqual({ limit: 6, alreadyVisible: false });
    expect(
      revealSettledLimitThroughKey({
        settledKeys: settled,
        targetKey: "S2",
        currentLimit: 3,
      }),
    ).toEqual({ limit: 3, alreadyVisible: true });
  });

  it("searches eligible rows before pagination or folder collapse", () => {
    const threads = [
      { key: "A", title: "Auth service", group: "active" as const },
      { key: "B", title: "Unrelated", group: "active" as const },
      { key: "S1", title: "Old auth", group: "settled" as const },
      { key: "S2", title: "Settled two", group: "settled" as const },
      { key: "S3", title: "Settled three", group: "settled" as const },
      { key: "S4", title: "Settled four", group: "settled" as const },
      { key: "S7", title: "Ancient auth", group: "settled" as const },
    ];
    const view = buildWorkspaceProjectThreadView({
      threads,
      getKey: (thread) => thread.key,
      classify: (thread) => thread.group,
      canonicalOrder: ["A", "B", "S1", "S2", "S3", "S4", "S5", "S6", "S7"],
      settledLimit: 3,
      snoozedExpanded: false,
      folderExpanded: false,
      query: "auth",
    });
    expect(isWorkspaceSearchActive("auth")).toBe(true);
    expect(view.searchMatches.map((thread) => thread.key)).toEqual(["A", "S1", "S7"]);
    expect(view.visibleThreads.map((thread) => thread.key)).toEqual(["A", "S1", "S7"]);
    expect(searchWorkspaceThreadsByTitle(threads, "  AUTH  ").map((thread) => thread.key)).toEqual([
      "A",
      "S1",
      "S7",
    ]);

    const restored = buildWorkspaceProjectThreadView({
      threads,
      getKey: (thread) => thread.key,
      classify: (thread) => thread.group,
      canonicalOrder: ["A", "B", "S1", "S2", "S3", "S4", "S5", "S6", "S7"],
      settledLimit: 3,
      snoozedExpanded: false,
      folderExpanded: true,
      query: "",
    });
    expect(restored.visibleThreads.map((thread) => thread.key)).toEqual([
      "A",
      "B",
      "S1",
      "S2",
      "S3",
    ]);
  });

  it("shows unseen present keys at the front without reshuffling known keys", () => {
    const view = buildWorkspaceProjectThreadView({
      threads: [
        { key: "A", title: "Known A" },
        { key: "N", title: "New" },
        { key: "B", title: "Known B" },
      ],
      getKey: (thread) => thread.key,
      classify: () => "active" as const,
      canonicalOrder: ["A", "B"],
      settledLimit: 3,
      snoozedExpanded: false,
      folderExpanded: true,
      query: "",
    });
    expect(view.visibleThreads.map((thread) => thread.key)).toEqual(["N", "A", "B"]);
  });

  it("does not invent a row for a retained key that is not in the project thread list", () => {
    const view = buildWorkspaceProjectThreadView({
      threads: [{ key: "A", title: "In workspace" }],
      getKey: (thread) => thread.key,
      classify: () => "active" as const,
      canonicalOrder: ["A", "OUT"],
      settledLimit: 3,
      snoozedExpanded: false,
      folderExpanded: true,
      query: "",
    });
    expect(view.visibleThreads.map((thread) => thread.key)).toEqual(["A"]);
  });
});

describe("offline project presentation", () => {
  it("uses last-known labels when live projection is unavailable", () => {
    expect(
      resolveWorkspaceProjectPresentation({
        live: null,
        lastKnown: {
          title: "Alpha repo",
          workspaceRoot: "/repos/alpha",
          environmentLabel: "VPS",
        },
        connected: false,
      }),
    ).toEqual({
      title: "Alpha repo",
      workspaceRoot: "/repos/alpha",
      environmentLabel: "VPS",
      availability: "cached",
    });
    expect(
      resolveWorkspaceProjectPresentation({
        live: {
          title: "Live title",
          workspaceRoot: "/repos/alpha",
          environmentLabel: "Local",
        },
        lastKnown: {
          title: "Alpha repo",
          workspaceRoot: "/repos/alpha",
          environmentLabel: "VPS",
        },
        connected: true,
      }),
    ).toMatchObject({ title: "Live title", availability: "live" });
  });

  it("does not label an offline live projection as live when lastKnown is absent", () => {
    expect(
      resolveWorkspaceProjectPresentation({
        live: {
          title: "Cached projection",
          workspaceRoot: "/repos/alpha",
          environmentLabel: "VPS",
        },
        lastKnown: null,
        connected: false,
      }),
    ).toEqual({
      title: "Cached projection",
      workspaceRoot: "/repos/alpha",
      environmentLabel: "VPS",
      availability: "cached",
    });
  });
});
