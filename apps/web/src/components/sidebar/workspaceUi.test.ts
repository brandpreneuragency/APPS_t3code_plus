import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SETTLED_VISIBLE_LIMIT,
  planWorkspaceThreadDrag,
  reconcileCanonicalThreadOrder,
  resetSettledVisibleLimit,
  revealSettledLimitThroughKey,
  visibleSettledKeys,
} from "../../sidebarWorkspaceModel";
import { EnvironmentId } from "@t3tools/contracts";

import {
  collectProjectAttachActions,
  confirmProjectAttachMove,
  matchingChangeRequestFromSnapshot,
  nextProjectAttachChoice,
  parseWorkspaceThreadDragId,
  reorderCustomWorkspaceIds,
  retainEqualStringArray,
  sameStringArrays,
  searchNavigationReveal,
  seedDefaultDisplayOrderKeys,
  shouldSeedWorkspaceThreadOrder,
  shouldPersistDefaultSidebarView,
  workspaceThreadOrderSeedDecision,
  WORKSPACE_SWITCHER_DEFAULT_ID,
  workspaceThreadDragId,
} from "./workspaceUi";

describe("model order helpers used by the panel", () => {
  it("keeps known relative order when later activity arrives", () => {
    const result = reconcileCanonicalThreadOrder({
      storedOrder: ["a", "b", "c"],
      presentKeys: ["c", "a", "b"],
      createdAtByKey: {
        a: "2026-09-18T10:00:00.000Z",
        b: "2026-09-18T11:00:00.000Z",
        c: "2026-09-18T12:00:00.000Z",
      },
    });
    expect(result).toEqual({ order: ["a", "b", "c"], changed: false });
  });

  it("inserts a new batch at the front without moving known keys", () => {
    const result = reconcileCanonicalThreadOrder({
      storedOrder: ["old-a", "old-b"],
      presentKeys: ["old-a", "old-b", "new-older", "new-newer"],
      createdAtByKey: {
        "old-a": "2026-01-01T00:00:00.000Z",
        "old-b": "2026-01-02T00:00:00.000Z",
        "new-older": "2026-09-01T00:00:00.000Z",
        "new-newer": "2026-09-18T00:00:00.000Z",
      },
    });
    expect(result.order).toEqual(["new-newer", "new-older", "old-a", "old-b"]);
    expect(result.changed).toBe(true);
  });

  it("replaces only active slots when dragging B before A", () => {
    expect(
      planWorkspaceThreadDrag({
        canonicalOrder: ["A", "S1", "B", "S2"],
        sourceProjectKey: "p",
        targetProjectKey: "p",
        sourceGroup: "active",
        targetGroup: "active",
        sourceKey: "B",
        targetKey: "A",
        movableKeys: ["A", "B"],
      }),
    ).toEqual({ nextOrder: ["B", "S1", "A", "S2"] });
  });

  it("rejects a drop into another status group", () => {
    expect(
      planWorkspaceThreadDrag({
        canonicalOrder: ["A", "S1", "B"],
        sourceProjectKey: "p",
        targetProjectKey: "p",
        sourceGroup: "active",
        targetGroup: "settled",
        sourceKey: "A",
        targetKey: "S1",
        movableKeys: ["A", "B"],
      }),
    ).toBeNull();
  });
});

describe("settled reveal through canonical position", () => {
  it("raises the limit through the selected key instead of appending it", () => {
    const settled = ["1", "2", "3", "4", "5", "6", "7"];
    const revealed = revealSettledLimitThroughKey({
      settledKeys: settled,
      targetKey: "5",
      currentLimit: DEFAULT_SETTLED_VISIBLE_LIMIT,
    });
    expect(revealed).toEqual({ limit: 6, alreadyVisible: false });
    expect(visibleSettledKeys(settled, revealed!.limit)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(visibleSettledKeys(settled, resetSettledVisibleLimit())).toEqual(["1", "2", "3"]);
  });

  it("expands the folder and pages through a hidden search result", () => {
    expect(
      searchNavigationReveal({
        selectedKey: "s5",
        belongsToProject: true,
        folderExpanded: false,
        settledKeys: ["s1", "s2", "s3", "s4", "s5"],
        settledLimit: 3,
      }),
    ).toEqual({ expand: true, settledLimit: 6, snoozedExpanded: false });
  });

  it("does not change another project's collapse or paging", () => {
    expect(
      searchNavigationReveal({
        selectedKey: "s5",
        belongsToProject: false,
        folderExpanded: false,
        settledKeys: ["s1", "s2", "s3", "s4", "s5"],
        settledLimit: 3,
      }),
    ).toEqual({ expand: false, settledLimit: 3, snoozedExpanded: false });
  });

  it("Show Less after a reveal restores exactly the first three canonical rows", () => {
    const settled = ["1", "2", "3", "4", "5"];
    const revealed = revealSettledLimitThroughKey({
      settledKeys: settled,
      targetKey: "5",
      currentLimit: DEFAULT_SETTLED_VISIBLE_LIMIT,
    });
    expect(visibleSettledKeys(settled, revealed!.limit).includes("5")).toBe(true);
    expect(visibleSettledKeys(settled, resetSettledVisibleLimit())).toEqual(["1", "2", "3"]);
  });

  it("palette-like navigation with no sidebar query still pages through the hidden settled row", () => {
    expect(
      searchNavigationReveal({
        selectedKey: "s4",
        belongsToProject: true,
        folderExpanded: true,
        settledKeys: ["s1", "s2", "s3", "s4"],
        settledLimit: 3,
      }),
    ).toEqual({ expand: true, settledLimit: 6, snoozedExpanded: false });
  });

  it("opens snoozed disclosure for a hidden snoozed navigation without paging settled", () => {
    expect(
      searchNavigationReveal({
        selectedKey: "z2",
        belongsToProject: true,
        folderExpanded: false,
        settledKeys: ["s1", "s2", "s3", "s4"],
        settledLimit: 3,
        snoozedKeys: ["z1", "z2"],
        snoozedExpanded: false,
      }),
    ).toEqual({ expand: true, settledLimit: 3, snoozedExpanded: true });
  });
});

describe("matchingChangeRequestFromSnapshot", () => {
  const merged = {
    branch: "feature-old",
    pr: { state: "merged" as const, updatedAt: "2026-09-01T00:00:00.000Z" },
    linkedPullRequest: { projectId: "proj", repository: "org/repo", number: 11 },
  };

  it("accepts a snapshot only for the current linked PR identity", () => {
    expect(
      matchingChangeRequestFromSnapshot({
        snapshot: merged,
        thread: {
          linkedPullRequest: { projectId: "proj", repository: "org/repo", number: 11 },
          worktreePath: "/worktrees/other",
          branch: "feature-new",
        },
      }),
    ).toEqual(merged.pr);
  });

  it("rejects a stale merged snapshot from a different PR or branch", () => {
    expect(
      matchingChangeRequestFromSnapshot({
        snapshot: merged,
        thread: {
          linkedPullRequest: { projectId: "proj", repository: "org/repo", number: 22 },
          worktreePath: "/worktrees/other",
          branch: "feature-old",
        },
      }),
    ).toBeNull();
    expect(
      matchingChangeRequestFromSnapshot({
        snapshot: merged,
        thread: {
          linkedPullRequest: null,
          worktreePath: "/repo",
          branch: "feature-new",
        },
      }),
    ).toBeNull();
  });

  it("keeps a terminal snapshot on an unlinked local checkout even when the branch moved", () => {
    expect(
      matchingChangeRequestFromSnapshot({
        snapshot: { branch: "main", pr: { state: "merged" } },
        thread: { linkedPullRequest: null, worktreePath: null, branch: "other" },
      }),
    ).toEqual({ state: "merged" });
  });
});

describe("seedDefaultDisplayOrderKeys", () => {
  const environmentId = EnvironmentId.make("env");

  function seedThread(
    id: string,
    extras: {
      createdAt: string;
      updatedAt?: string;
      settledAt?: string | null;
      pinnedAt?: string;
      pinOrderKey?: string;
      snoozedUntil?: string;
      latestUserMessageAt?: string | null;
    },
  ) {
    return {
      id,
      environmentId,
      createdAt: extras.createdAt,
      updatedAt: extras.updatedAt ?? extras.createdAt,
      settledAt: extras.settledAt ?? null,
      latestTurn: null,
      latestUserMessageAt: extras.latestUserMessageAt ?? null,
      ...(extras.pinnedAt === undefined ? {} : { pinnedAt: extras.pinnedAt }),
      ...(extras.pinOrderKey === undefined ? {} : { pinOrderKey: extras.pinOrderKey }),
      ...(extras.snoozedUntil === undefined ? {} : { snoozedUntil: extras.snoozedUntil }),
    };
  }

  it("seeds modern pinned, active, snoozed-by-next-wake, then settled", () => {
    const threads = [
      seedThread("settled-old", {
        createdAt: "2026-01-01T00:00:00.000Z",
        settledAt: "2026-01-02T00:00:00.000Z",
      }),
      seedThread("settled-new", {
        createdAt: "2026-01-03T00:00:00.000Z",
        settledAt: "2026-06-01T00:00:00.000Z",
      }),
      seedThread("active-new", { createdAt: "2026-09-18T00:00:00.000Z" }),
      seedThread("active-old", { createdAt: "2026-09-01T00:00:00.000Z" }),
      seedThread("draft-1", { createdAt: "2026-08-01T00:00:00.000Z" }),
      seedThread("pinned", {
        createdAt: "2026-01-01T00:00:00.000Z",
        pinnedAt: "2026-09-01T00:00:00.000Z",
        pinOrderKey: "a0",
      }),
      seedThread("snooze-later", {
        createdAt: "2026-02-01T00:00:00.000Z",
        snoozedUntil: "2026-09-20T12:00:00.000Z",
      }),
      seedThread("snooze-soon", {
        createdAt: "2026-03-01T00:00:00.000Z",
        snoozedUntil: "2026-09-19T08:00:00.000Z",
      }),
    ];
    expect(
      seedDefaultDisplayOrderKeys({
        threads,
        classify: (thread) => {
          const branded: EnvironmentId = thread.environmentId;
          if (branded !== environmentId) return "active";
          if (thread.id.startsWith("settled")) return "settled";
          if (thread.id.startsWith("snooze")) return "snoozed";
          return "active";
        },
        threadKey: (thread) => `${thread.environmentId}:${thread.id}`,
        layout: "modern",
      }),
    ).toEqual([
      "env:pinned",
      "env:active-new",
      "env:active-old",
      "env:draft-1",
      "env:snooze-soon",
      "env:snooze-later",
      "env:settled-new",
      "env:settled-old",
    ]);
  });

  it("seeds legacy created_at independently of recency timestamps", () => {
    const threads = [
      seedThread("older", {
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
        latestUserMessageAt: "2026-09-18T12:00:00.000Z",
      }),
      seedThread("newer", {
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      }),
    ];
    expect(
      seedDefaultDisplayOrderKeys({
        threads,
        classify: () => "active",
        threadKey: (thread) => `${thread.environmentId}:${thread.id}`,
        layout: "legacy",
        threadSortOrder: "created_at",
      }),
    ).toEqual(["env:newer", "env:older"]);
  });

  it("seeds legacy updated_at from latestUserMessageAt then updatedAt, ignoring visit time", () => {
    const threads = [
      seedThread("messaged", {
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        latestUserMessageAt: "2026-09-10T00:00:00.000Z",
      }),
      seedThread("updated-only", {
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-09-12T00:00:00.000Z",
      }),
      seedThread("stale", {
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    ];
    expect(
      seedDefaultDisplayOrderKeys({
        threads,
        classify: () => "active",
        threadKey: (thread) => `${thread.environmentId}:${thread.id}`,
        layout: "legacy",
        threadSortOrder: "updated_at",
      }),
    ).toEqual(["env:updated-only", "env:messaged", "env:stale"]);
  });
});

describe("sameStringArrays and Default persist gating", () => {
  it("detects promotion-only order changes that reconcile.changed would miss", () => {
    expect(sameStringArrays(["draft", "a"], ["thread", "a"])).toBe(false);
    expect(sameStringArrays(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("retains the previous visible-order array when contents match", () => {
    const previous = ["a", "b"];
    expect(retainEqualStringArray(previous, ["a", "b"])).toBe(previous);
    expect(retainEqualStringArray(previous, ["b", "a"])).toEqual(["b", "a"]);
  });

  it("gates Default view snapshots to clients with workspaces enabled", () => {
    expect(shouldPersistDefaultSidebarView(true)).toBe(true);
    expect(shouldPersistDefaultSidebarView(false)).toBe(false);
  });
});

describe("first custom-workspace order seeding", () => {
  const ready = {
    storedOrder: [] as readonly string[],
    presentKeys: ["env:thread"],
    settingsHydrated: true,
    shellBootstrapped: true,
    projectAvailable: true,
    environmentConnected: true,
    liveThreadShellCount: 1,
  };

  it("waits for a usable live shell before persisting the initial order", () => {
    expect(shouldSeedWorkspaceThreadOrder(ready)).toBe(true);
    expect(shouldSeedWorkspaceThreadOrder({ ...ready, settingsHydrated: false })).toBe(false);
    expect(shouldSeedWorkspaceThreadOrder({ ...ready, shellBootstrapped: false })).toBe(false);
    expect(shouldSeedWorkspaceThreadOrder({ ...ready, environmentConnected: false })).toBe(false);
    expect(shouldSeedWorkspaceThreadOrder({ ...ready, projectAvailable: false })).toBe(false);
  });

  it("does not turn a draft-only initial snapshot into durable order", () => {
    expect(
      shouldSeedWorkspaceThreadOrder({
        ...ready,
        presentKeys: ["env:draft"],
        liveThreadShellCount: 0,
      }),
    ).toBe(false);
  });

  it("does not replace an existing manual order", () => {
    expect(
      shouldSeedWorkspaceThreadOrder({
        ...ready,
        storedOrder: ["env:thread"],
      }),
    ).toBe(false);
  });

  it("waits instead of reconciling a first draft-only or offline snapshot", () => {
    expect(
      workspaceThreadOrderSeedDecision({
        ...ready,
        presentKeys: ["env:draft"],
        liveThreadShellCount: 0,
      }),
    ).toBe("wait");
    expect(
      workspaceThreadOrderSeedDecision({
        ...ready,
        environmentConnected: false,
      }),
    ).toBe("wait");
    expect(workspaceThreadOrderSeedDecision(ready)).toBe("seed");
    expect(workspaceThreadOrderSeedDecision({ ...ready, storedOrder: ["env:thread"] })).toBe(
      "reconcile",
    );
  });
});

describe("reorderCustomWorkspaceIds", () => {
  it("reorders custom dots and refuses to move Default", () => {
    expect(
      reorderCustomWorkspaceIds({
        customIds: ["w1", "w2", "w3"],
        activeId: "w3",
        overId: "w1",
      }),
    ).toEqual(["w3", "w1", "w2"]);
    expect(
      reorderCustomWorkspaceIds({
        customIds: ["w1", "w2"],
        activeId: WORKSPACE_SWITCHER_DEFAULT_ID,
        overId: "w1",
      }),
    ).toBeNull();
  });
});

describe("project attach choices", () => {
  it("requires an explicit Move before a conflicted project is included", () => {
    const conflicted = nextProjectAttachChoice({
      current: { kind: "unselected" },
      ownerId: "ws-other",
      ownerName: "Client work",
      selected: true,
    });
    expect(conflicted.kind).toBe("conflict");
    expect(collectProjectAttachActions({ p1: conflicted }).blockedKeys).toEqual(["p1"]);
    const moved = confirmProjectAttachMove(conflicted);
    expect(collectProjectAttachActions({ p1: moved }).moveKeys).toEqual([
      { key: "p1", ownerId: "ws-other" },
    ]);
  });
});

describe("workspace thread drag ids", () => {
  it("round-trips project, group, and thread identity", () => {
    const id = workspaceThreadDragId({
      projectKey: "env:proj",
      group: "settled",
      threadKey: "env:thread",
    });
    expect(parseWorkspaceThreadDragId(id)).toEqual({
      projectKey: "env:proj",
      group: "settled",
      threadKey: "env:thread",
    });
  });
});
