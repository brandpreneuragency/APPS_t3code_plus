import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  applyWorkspaceAttachmentMove,
  attachedProjectKeySet,
  captureWorkspacePaletteScope,
  checkCapturedWorkspaceCreateTarget,
  filterItemsByAttachedProjects,
  isCustomWorkspaceSelection,
  matchThreadsByTitle,
  preferInScopeProjectRef,
  resolvePhysicalProjectsForWorkspace,
  resolveWorkspaceAttachment,
  resolveWorkspaceNewThreadDecision,
  shouldQueryThreadContentSearch,
  workspaceAttachmentNotice,
  type WorkspaceAttachResult,
  type WorkspaceCreationLastKnown,
  type WorkspaceCreationWorkspace,
} from "./useWorkspaceCreation.logic";

const LOCAL = EnvironmentId.make("environment-local");
const REMOTE = EnvironmentId.make("environment-remote");
const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");
const PROJECT_C = ProjectId.make("project-c");
const SHARED_ID = ProjectId.make("shared-project-id");

const REF_LOCAL_A = scopeProjectRef(LOCAL, PROJECT_A);
const REF_LOCAL_B = scopeProjectRef(LOCAL, PROJECT_B);
const REF_REMOTE_A = scopeProjectRef(REMOTE, PROJECT_A);
const REF_REMOTE_C = scopeProjectRef(REMOTE, PROJECT_C);
const REF_LOCAL_SHARED = scopeProjectRef(LOCAL, SHARED_ID);
const REF_REMOTE_SHARED = scopeProjectRef(REMOTE, SHARED_ID);

function workspace(
  id: string,
  name: string,
  projects: WorkspaceCreationWorkspace["projects"],
): WorkspaceCreationWorkspace {
  return { id, name, projects };
}

describe("isCustomWorkspaceSelection", () => {
  it("is false when workspaces are disabled even when a custom id is selected", () => {
    expect(
      isCustomWorkspaceSelection({
        workspacesEnabled: false,
        selectedWorkspaceId: "ws-1",
        workspaces: [workspace("ws-1", "Client work", [])],
      }),
    ).toBe(false);
  });

  it("is false for Default and for a deleted custom id", () => {
    expect(
      isCustomWorkspaceSelection({
        workspacesEnabled: true,
        selectedWorkspaceId: null,
        workspaces: [workspace("ws-1", "Client work", [])],
      }),
    ).toBe(false);
    expect(
      isCustomWorkspaceSelection({
        workspacesEnabled: true,
        selectedWorkspaceId: "missing",
        workspaces: [workspace("ws-1", "Client work", [])],
      }),
    ).toBe(false);
  });

  it("is true for a live custom workspace when enabled", () => {
    expect(
      isCustomWorkspaceSelection({
        workspacesEnabled: true,
        selectedWorkspaceId: "ws-1",
        workspaces: [workspace("ws-1", "Client work", [])],
      }),
    ).toBe(true);
  });
});

describe("resolveWorkspaceNewThreadDecision", () => {
  const connected = new Set([LOCAL, REMOTE]);
  const present = attachedProjectKeySet([
    REF_LOCAL_A,
    REF_LOCAL_B,
    REF_REMOTE_A,
    REF_REMOTE_C,
    REF_LOCAL_SHARED,
    REF_REMOTE_SHARED,
  ]);

  it("creates in the only connected attached project and ignores an out-of-scope open chat", () => {
    expect(
      resolveWorkspaceNewThreadDecision({
        attachedProjects: [REF_LOCAL_A],
        connectedEnvironmentIds: connected,
        presentProjectKeys: present,
        currentProjectRef: REF_REMOTE_C,
        local: false,
      }),
    ).toEqual({ kind: "create", projectRef: REF_LOCAL_A });
  });

  it("opens a physical-ref picker when several attached projects are connected", () => {
    expect(
      resolveWorkspaceNewThreadDecision({
        attachedProjects: [REF_LOCAL_A, REF_REMOTE_C],
        connectedEnvironmentIds: connected,
        presentProjectKeys: present,
        currentProjectRef: REF_REMOTE_C,
        local: false,
      }),
    ).toEqual({
      kind: "pick",
      preferredProjectRef: REF_REMOTE_C,
      candidates: [REF_LOCAL_A, REF_REMOTE_C],
    });
  });

  it("does not prefer an open chat that is outside the workspace when picking", () => {
    expect(
      resolveWorkspaceNewThreadDecision({
        attachedProjects: [REF_LOCAL_A, REF_LOCAL_B],
        connectedEnvironmentIds: connected,
        presentProjectKeys: present,
        currentProjectRef: REF_REMOTE_C,
        local: false,
      }),
    ).toEqual({
      kind: "pick",
      preferredProjectRef: REF_LOCAL_A,
      candidates: [REF_LOCAL_A, REF_LOCAL_B],
    });
  });

  it("counts physical refs, not shared project ids across environments", () => {
    const decision = resolveWorkspaceNewThreadDecision({
      attachedProjects: [REF_LOCAL_SHARED, REF_REMOTE_SHARED],
      connectedEnvironmentIds: connected,
      presentProjectKeys: present,
      currentProjectRef: null,
      local: false,
    });
    expect(decision.kind).toBe("pick");
    if (decision.kind !== "pick") {
      return;
    }
    expect(decision.candidates).toEqual([REF_LOCAL_SHARED, REF_REMOTE_SHARED]);
  });

  it("offers add-project when the workspace has no attached projects", () => {
    expect(
      resolveWorkspaceNewThreadDecision({
        attachedProjects: [],
        connectedEnvironmentIds: connected,
        presentProjectKeys: present,
        currentProjectRef: REF_LOCAL_A,
        local: false,
      }),
    ).toEqual({ kind: "add-project" });
  });

  it("explains disconnection when every attached project is offline", () => {
    expect(
      resolveWorkspaceNewThreadDecision({
        attachedProjects: [REF_REMOTE_C],
        connectedEnvironmentIds: new Set([LOCAL]),
        presentProjectKeys: present,
        currentProjectRef: REF_REMOTE_C,
        local: false,
      }),
    ).toEqual({ kind: "disconnected" });
  });

  it("does not treat a connected but missing or unhydrated project as eligible", () => {
    expect(
      resolveWorkspaceNewThreadDecision({
        attachedProjects: [REF_LOCAL_A],
        connectedEnvironmentIds: connected,
        presentProjectKeys: new Set(),
        currentProjectRef: REF_LOCAL_A,
        local: false,
      }),
    ).toEqual({ kind: "disconnected" });

    expect(
      resolveWorkspaceNewThreadDecision({
        attachedProjects: [REF_LOCAL_A, REF_REMOTE_C],
        connectedEnvironmentIds: connected,
        presentProjectKeys: attachedProjectKeySet([REF_REMOTE_C]),
        currentProjectRef: REF_LOCAL_A,
        local: false,
      }),
    ).toEqual({ kind: "create", projectRef: REF_REMOTE_C });
  });

  it("creates locally in the current in-scope connected project", () => {
    expect(
      resolveWorkspaceNewThreadDecision({
        attachedProjects: [REF_LOCAL_A, REF_REMOTE_C],
        connectedEnvironmentIds: connected,
        presentProjectKeys: present,
        currentProjectRef: REF_REMOTE_C,
        local: true,
      }),
    ).toEqual({ kind: "create", projectRef: REF_REMOTE_C });
  });

  it("falls back to the first connected attached project for local create, never out of scope", () => {
    expect(
      resolveWorkspaceNewThreadDecision({
        attachedProjects: [REF_REMOTE_C, REF_LOCAL_A],
        connectedEnvironmentIds: new Set([LOCAL]),
        presentProjectKeys: present,
        currentProjectRef: REF_REMOTE_C,
        local: true,
      }),
    ).toEqual({ kind: "create", projectRef: REF_LOCAL_A });

    expect(
      resolveWorkspaceNewThreadDecision({
        attachedProjects: [REF_REMOTE_C],
        connectedEnvironmentIds: new Set([LOCAL]),
        presentProjectKeys: present,
        currentProjectRef: REF_LOCAL_A,
        local: true,
      }),
    ).toEqual({ kind: "disconnected" });
  });

  it("does not local-create into a connected environment whose project row is missing", () => {
    expect(
      resolveWorkspaceNewThreadDecision({
        attachedProjects: [REF_LOCAL_A, REF_REMOTE_C],
        connectedEnvironmentIds: connected,
        presentProjectKeys: attachedProjectKeySet([REF_REMOTE_C]),
        currentProjectRef: REF_LOCAL_A,
        local: true,
      }),
    ).toEqual({ kind: "create", projectRef: REF_REMOTE_C });
  });
});

describe("preferInScopeProjectRef", () => {
  it("keeps an in-scope current ref and otherwise uses workspace order", () => {
    expect(preferInScopeProjectRef(REF_LOCAL_B, [REF_LOCAL_A, REF_LOCAL_B])).toEqual(REF_LOCAL_B);
    expect(preferInScopeProjectRef(REF_REMOTE_C, [REF_LOCAL_A, REF_LOCAL_B])).toEqual(REF_LOCAL_A);
    expect(preferInScopeProjectRef(null, [])).toBeNull();
  });
});

describe("resolvePhysicalProjectsForWorkspace", () => {
  it("preserves manual workspace order and does not merge same-id projects from two environments", () => {
    const projects = [
      { environmentId: REMOTE, id: SHARED_ID, title: "Remote copy" },
      { environmentId: LOCAL, id: PROJECT_B, title: "Local B" },
      { environmentId: LOCAL, id: SHARED_ID, title: "Local copy" },
    ];

    expect(
      resolvePhysicalProjectsForWorkspace(
        [REF_LOCAL_SHARED, REF_REMOTE_SHARED, REF_LOCAL_B],
        projects,
      ).map((project) => project.title),
    ).toEqual(["Local copy", "Remote copy", "Local B"]);
  });
});

describe("filterItemsByAttachedProjects and title search", () => {
  const threads = [
    {
      environmentId: LOCAL,
      projectId: PROJECT_A,
      title: "Fix navbar in workspace A",
    },
    {
      environmentId: REMOTE,
      projectId: PROJECT_A,
      title: "Fix navbar in other environment",
    },
    {
      environmentId: LOCAL,
      projectId: PROJECT_B,
      title: "Unrelated chat",
    },
  ];

  it("keeps only attached physical projects, including same ids on two environments", () => {
    expect(
      filterItemsByAttachedProjects(threads, [REF_LOCAL_A]).map((thread) => thread.title),
    ).toEqual(["Fix navbar in workspace A"]);
    expect(
      filterItemsByAttachedProjects(threads, [REF_LOCAL_A, REF_REMOTE_A]).map(
        (thread) => thread.title,
      ),
    ).toEqual(["Fix navbar in workspace A", "Fix navbar in other environment"]);
  });

  it("matches titles inside the scoped set and does not resurrect out-of-scope chats", () => {
    const scoped = filterItemsByAttachedProjects(threads, [REF_LOCAL_A]);
    expect(matchThreadsByTitle(scoped, "navbar").map((thread) => thread.title)).toEqual([
      "Fix navbar in workspace A",
    ]);
    expect(matchThreadsByTitle(scoped, "unrelated")).toEqual([]);
  });
});

describe("captureWorkspacePaletteScope", () => {
  const workspaces = [
    workspace("ws-1", "Client work", [REF_LOCAL_A, REF_REMOTE_C]),
    workspace("ws-2", "Other", [REF_LOCAL_B]),
  ];

  it("captures the initiating workspace projects, not a later selected tab", () => {
    expect(
      captureWorkspacePaletteScope({
        intentWorkspaceId: "ws-1",
        selectedWorkspaceId: "ws-2",
        workspaces,
      }),
    ).toEqual({
      workspaceId: "ws-1",
      projectRefs: [REF_LOCAL_A, REF_REMOTE_C],
    });
  });

  it("treats omitted intent as Default when selection is null", () => {
    expect(
      captureWorkspacePaletteScope({
        selectedWorkspaceId: null,
        workspaces,
      }),
    ).toEqual({ workspaceId: null, projectRefs: [] });
  });

  it("keeps a deleted initiating workspace id with no project refs", () => {
    expect(
      captureWorkspacePaletteScope({
        intentWorkspaceId: "deleted",
        selectedWorkspaceId: "ws-2",
        workspaces,
      }),
    ).toEqual({ workspaceId: "deleted", projectRefs: [] });
  });

  it("ignores a workspace intent when workspaces are disabled", () => {
    expect(
      captureWorkspacePaletteScope({
        workspacesEnabled: false,
        intentWorkspaceId: "ws-1",
        selectedWorkspaceId: "ws-2",
        workspaces,
      }),
    ).toEqual({ workspaceId: null, projectRefs: [] });
  });
});

describe("workspace attachment", () => {
  const lastKnown: WorkspaceCreationLastKnown = {
    title: "Repo",
    workspaceRoot: "/repo",
    environmentLabel: "Local",
  };

  it("attaches after a successful store result and does not treat already-attached as failure", () => {
    const attachProject = vi.fn((): WorkspaceAttachResult => ({ status: "attached" }));
    expect(
      resolveWorkspaceAttachment({
        workspaceId: "ws-1",
        projectRef: REF_LOCAL_A,
        lastKnown,
        workspaces: [workspace("ws-1", "Client work", [])],
        attachProject,
      }),
    ).toEqual({ status: "attached" });
    expect(attachProject).toHaveBeenCalledWith("ws-1", REF_LOCAL_A, lastKnown);

    expect(
      resolveWorkspaceAttachment({
        workspaceId: "ws-1",
        projectRef: REF_LOCAL_A,
        workspaces: [workspace("ws-1", "Client work", [REF_LOCAL_A])],
        attachProject: () => ({ status: "already-attached" }),
      }),
    ).toEqual({ status: "already-attached" });
  });

  it("does not attach when the initiating workspace was deleted", () => {
    const attachProject = vi.fn((): WorkspaceAttachResult => ({ status: "attached" }));
    expect(
      resolveWorkspaceAttachment({
        workspaceId: "deleted",
        projectRef: REF_LOCAL_A,
        lastKnown,
        workspaces: [workspace("ws-1", "Client work", [])],
        attachProject,
      }),
    ).toEqual({ status: "missing-workspace" });
    expect(attachProject).not.toHaveBeenCalled();
    expect(workspaceAttachmentNotice({ status: "missing-workspace" })).toEqual({
      title: "Workspace is no longer available",
      description: "The project stays in Default.",
    });
  });

  it("returns an explicit conflict instead of moving", () => {
    expect(
      resolveWorkspaceAttachment({
        workspaceId: "ws-2",
        projectRef: REF_LOCAL_A,
        workspaces: [
          workspace("ws-1", "Client work", [REF_LOCAL_A]),
          workspace("ws-2", "Other", []),
        ],
        attachProject: () => ({ status: "conflict", ownerId: "ws-1" }),
      }),
    ).toEqual({
      status: "conflict",
      ownerId: "ws-1",
      ownerName: "Client work",
    });
  });

  it("revalidates ownership when applying Move", () => {
    expect(
      applyWorkspaceAttachmentMove({
        workspaceId: "ws-2",
        projectRef: REF_LOCAL_A,
        expectedOwnerId: "ws-1",
        workspaces: [
          workspace("ws-1", "Client work", [REF_LOCAL_A]),
          workspace("ws-2", "Other", []),
        ],
        moveProject: (ref, expectedOwnerId, targetId) => {
          expect(ref).toEqual(REF_LOCAL_A);
          expect(expectedOwnerId).toBe("ws-1");
          expect(targetId).toBe("ws-2");
          return true;
        },
      }),
    ).toEqual({ status: "attached" });
  });

  it("keeps the project unmoved when Move revalidation fails against a new owner", () => {
    expect(
      applyWorkspaceAttachmentMove({
        workspaceId: "ws-2",
        projectRef: REF_LOCAL_A,
        expectedOwnerId: "ws-1",
        workspaces: [
          workspace("ws-1", "Client work", []),
          workspace("ws-2", "Other", []),
          workspace("ws-3", "Taken", [REF_LOCAL_A]),
        ],
        moveProject: () => false,
      }),
    ).toEqual({
      status: "conflict",
      ownerId: "ws-3",
      ownerName: "Taken",
    });
  });

  it("reports a new owner when Move loses the ownership race", () => {
    const moved = applyWorkspaceAttachmentMove({
      workspaceId: "ws-2",
      projectRef: REF_LOCAL_A,
      expectedOwnerId: "ws-1",
      workspaces: [
        workspace("ws-1", "Client work", []),
        workspace("ws-2", "Other", []),
        workspace("ws-3", "Taken", [REF_LOCAL_A]),
      ],
      moveProject: () => false,
    });
    expect(moved).toEqual({
      status: "conflict",
      ownerId: "ws-3",
      ownerName: "Taken",
    });
    expect(workspaceAttachmentNotice(moved)).toBeNull();
  });

  it("does not move into a workspace that disappeared after the conflict prompt", () => {
    const moveProject = vi.fn(() => true);
    expect(
      applyWorkspaceAttachmentMove({
        workspaceId: "deleted",
        projectRef: REF_LOCAL_A,
        expectedOwnerId: "ws-1",
        workspaces: [workspace("ws-1", "Client work", [REF_LOCAL_A])],
        moveProject,
      }),
    ).toEqual({ status: "missing-workspace" });
    expect(moveProject).not.toHaveBeenCalled();
  });
});

describe("checkCapturedWorkspaceCreateTarget", () => {
  const workspaces = [
    workspace("ws-1", "Client work", [REF_LOCAL_A, REF_REMOTE_C]),
    workspace("ws-2", "Other", [REF_LOCAL_B]),
  ];
  const present = attachedProjectKeySet([REF_LOCAL_A, REF_REMOTE_C, REF_LOCAL_B]);
  const connected = new Set([LOCAL, REMOTE]);

  it("rejects create after the initiating workspace is deleted", () => {
    expect(
      checkCapturedWorkspaceCreateTarget({
        workspaceId: "ws-1",
        projectRef: REF_LOCAL_A,
        workspaces: [workspace("ws-2", "Other", [REF_LOCAL_B])],
        presentProjectKeys: present,
        connectedEnvironmentIds: connected,
      }),
    ).toBe("missing-workspace");
  });

  it("rejects create when the project was moved out of the captured workspace", () => {
    expect(
      checkCapturedWorkspaceCreateTarget({
        workspaceId: "ws-1",
        projectRef: REF_LOCAL_A,
        workspaces: [
          workspace("ws-1", "Client work", [REF_REMOTE_C]),
          workspace("ws-2", "Other", [REF_LOCAL_A]),
        ],
        presentProjectKeys: present,
        connectedEnvironmentIds: connected,
      }),
    ).toBe("not-a-member");
  });

  it("rejects a connected-environment project whose row is missing", () => {
    expect(
      checkCapturedWorkspaceCreateTarget({
        workspaceId: "ws-1",
        projectRef: REF_LOCAL_A,
        workspaces,
        presentProjectKeys: attachedProjectKeySet([REF_REMOTE_C]),
        connectedEnvironmentIds: connected,
      }),
    ).toBe("unavailable");
  });
});

describe("live search vs captured picker scope", () => {
  const workspaces = [
    workspace("ws-1", "Client work", [REF_LOCAL_A]),
    workspace("ws-2", "Other", [REF_LOCAL_B]),
  ];

  it("keeps the initiating picker workspace when the selected tab changes", () => {
    const actionScope = captureWorkspacePaletteScope({
      intentWorkspaceId: "ws-1",
      selectedWorkspaceId: "ws-2",
      workspaces,
    });
    const liveSearchScope = captureWorkspacePaletteScope({
      selectedWorkspaceId: "ws-2",
      workspaces,
    });
    expect(actionScope).toEqual({ workspaceId: "ws-1", projectRefs: [REF_LOCAL_A] });
    expect(liveSearchScope).toEqual({ workspaceId: "ws-2", projectRefs: [REF_LOCAL_B] });
  });

  it("disables global content search while closed, in a custom workspace, or after switching tabs", () => {
    expect(
      shouldQueryThreadContentSearch({
        open: false,
        searchWorkspaceId: null,
        isInSubmenu: false,
        isActionsOnly: false,
      }),
    ).toBe(false);
    expect(
      shouldQueryThreadContentSearch({
        open: true,
        searchWorkspaceId: "ws-1",
        isInSubmenu: false,
        isActionsOnly: false,
      }),
    ).toBe(false);
    expect(
      shouldQueryThreadContentSearch({
        open: true,
        searchWorkspaceId: null,
        isInSubmenu: false,
        isActionsOnly: false,
      }),
    ).toBe(true);
  });
});
