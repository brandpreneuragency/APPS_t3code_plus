import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  consumePendingWorkspaceThreadReveal,
  invalidateWorkspaceThreadReveal,
  invalidateWorkspaceThreadRevealForProject,
  invalidateWorkspaceThreadRevealUnless,
  onWorkspaceThreadReveal,
  peekPendingWorkspaceThreadReveal,
  requestWorkspaceThreadReveal,
} from "./workspaceNavigation";
import { searchNavigationReveal } from "./workspaceUi";

afterEach(() => {
  invalidateWorkspaceThreadReveal();
});

describe("workspace thread reveal intent", () => {
  it("holds a request until a matching ready target consumes it once", () => {
    requestWorkspaceThreadReveal({ workspaceId: "ws-a", threadKey: "env:hidden" });
    expect(peekPendingWorkspaceThreadReveal()).toEqual({
      workspaceId: "ws-a",
      threadKey: "env:hidden",
    });
    expect(
      consumePendingWorkspaceThreadReveal({
        workspaceId: "ws-a",
        threadKeys: ["env:other"],
      }),
    ).toBeNull();
    expect(peekPendingWorkspaceThreadReveal()?.threadKey).toBe("env:hidden");
    expect(
      consumePendingWorkspaceThreadReveal({
        workspaceId: "ws-a",
        threadKeys: ["env:visible", "env:hidden"],
      }),
    ).toEqual({ workspaceId: "ws-a", threadKey: "env:hidden" });
    expect(peekPendingWorkspaceThreadReveal()).toBeNull();
    expect(
      consumePendingWorkspaceThreadReveal({
        workspaceId: "ws-a",
        threadKeys: ["env:hidden"],
      }),
    ).toBeNull();
  });

  it("survives request-before-listener and consumes when the target becomes ready later", () => {
    const received: string[] = [];
    requestWorkspaceThreadReveal({ workspaceId: "ws-a", threadKey: "env:s5" });
    const stop = onWorkspaceThreadReveal((detail) => received.push(detail.threadKey));
    expect(received).toEqual([]);
    expect(consumePendingWorkspaceThreadReveal({ workspaceId: "ws-a", threadKeys: [] })).toBeNull();
    expect(
      consumePendingWorkspaceThreadReveal({
        workspaceId: "ws-a",
        threadKeys: ["env:s1", "env:s5"],
      }),
    ).toEqual({ workspaceId: "ws-a", threadKey: "env:s5" });
    stop();
    expect(
      consumePendingWorkspaceThreadReveal({
        workspaceId: "ws-a",
        threadKeys: ["env:s5"],
      }),
    ).toBeNull();
  });

  it("keeps same-route and empty-route explicit picks pending until consumed", () => {
    requestWorkspaceThreadReveal({ workspaceId: "ws-a", threadKey: "env:open" });
    expect(
      consumePendingWorkspaceThreadReveal({
        workspaceId: "ws-a",
        threadKeys: ["env:open"],
      }),
    ).toEqual({ workspaceId: "ws-a", threadKey: "env:open" });
    requestWorkspaceThreadReveal({ workspaceId: "ws-a", threadKey: "env:first" });
    expect(
      consumePendingWorkspaceThreadReveal({
        workspaceId: "ws-a",
        threadKeys: ["env:first"],
      }),
    ).toEqual({ workspaceId: "ws-a", threadKey: "env:first" });
  });

  it("does not replay after Show Less or an ordinary remount consume", () => {
    requestWorkspaceThreadReveal({ workspaceId: "ws-a", threadKey: "env:s5" });
    expect(
      consumePendingWorkspaceThreadReveal({
        workspaceId: "ws-a",
        threadKeys: ["env:s1", "env:s2", "env:s3", "env:s4", "env:s5"],
      }),
    ).toEqual({ workspaceId: "ws-a", threadKey: "env:s5" });
    expect(
      searchNavigationReveal({
        selectedKey: "env:s5",
        belongsToProject: true,
        folderExpanded: true,
        settledKeys: ["env:s1", "env:s2", "env:s3", "env:s4", "env:s5"],
        settledLimit: 3,
      }),
    ).toEqual({ expand: true, settledLimit: 6, snoozedExpanded: false });
    expect(
      consumePendingWorkspaceThreadReveal({
        workspaceId: "ws-a",
        threadKeys: ["env:s1", "env:s2", "env:s3", "env:s4", "env:s5"],
      }),
    ).toBeNull();
  });

  it("invalidates pending intent when the workspace changes and ignores other workspaces", () => {
    requestWorkspaceThreadReveal({ workspaceId: "ws-a", threadKey: "env:hidden" });
    expect(
      consumePendingWorkspaceThreadReveal({
        workspaceId: "ws-b",
        threadKeys: ["env:hidden"],
      }),
    ).toBeNull();
    invalidateWorkspaceThreadReveal("ws-a");
    expect(peekPendingWorkspaceThreadReveal()).toBeNull();
    requestWorkspaceThreadReveal({ workspaceId: "ws-a", threadKey: "env:hidden" });
    invalidateWorkspaceThreadReveal();
    expect(
      consumePendingWorkspaceThreadReveal({
        workspaceId: "ws-a",
        threadKeys: ["env:hidden"],
      }),
    ).toBeNull();
  });

  it("does not consume an out-of-membership key so no ghost row is revealed", () => {
    requestWorkspaceThreadReveal({ workspaceId: "ws-a", threadKey: "env:foreign" });
    expect(
      consumePendingWorkspaceThreadReveal({
        workspaceId: "ws-a",
        threadKeys: ["env:member"],
      }),
    ).toBeNull();
    expect(
      searchNavigationReveal({
        selectedKey: "env:foreign",
        belongsToProject: false,
        folderExpanded: false,
        settledKeys: ["env:s1"],
        settledLimit: 3,
      }),
    ).toEqual({ expand: false, settledLimit: 3, snoozedExpanded: false });
  });

  it("invalidates a detached or moved project target without treating hydration as removal", () => {
    requestWorkspaceThreadReveal({
      workspaceId: "ws-a",
      projectKey: "env-a:project-a",
      threadKey: "env-a:hidden",
    });
    invalidateWorkspaceThreadRevealForProject("ws-a", "env-a:project-b");
    expect(peekPendingWorkspaceThreadReveal()).toEqual({
      workspaceId: "ws-a",
      projectKey: "env-a:project-a",
      threadKey: "env-a:hidden",
    });

    invalidateWorkspaceThreadRevealForProject("ws-a", "env-a:project-a");
    expect(peekPendingWorkspaceThreadReveal()).toBeNull();
  });

  it("cancels an unrelated route navigation but keeps the matching hydration wait", () => {
    requestWorkspaceThreadReveal({ workspaceId: "ws-a", threadKey: "env-a:hidden" });
    invalidateWorkspaceThreadRevealUnless({
      workspaceId: "ws-a",
      threadKey: "env-a:hidden",
    });
    expect(peekPendingWorkspaceThreadReveal()).not.toBeNull();

    invalidateWorkspaceThreadRevealUnless({
      workspaceId: "ws-a",
      threadKey: "env-a:other",
    });
    expect(peekPendingWorkspaceThreadReveal()).toBeNull();

    requestWorkspaceThreadReveal({ workspaceId: "ws-a", threadKey: "env-a:hidden" });
    // Utility routes such as Settings do not call this function, so their
    // unmount/remount cycle leaves the pending intent untouched.
    expect(peekPendingWorkspaceThreadReveal()).not.toBeNull();
  });
});
