import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";

export interface WorkspaceCreationLastKnown {
  readonly title: string;
  readonly workspaceRoot: string;
  readonly environmentLabel: string | null;
}

export interface WorkspaceCreationWorkspace {
  readonly id: string;
  readonly name: string;
  readonly projects: readonly ScopedProjectRef[];
}

export type WorkspaceAttachStatus =
  | "attached"
  | "already-attached"
  | "conflict"
  | "missing-workspace";

export interface WorkspaceAttachResult {
  readonly status: WorkspaceAttachStatus;
  readonly ownerId?: string;
}

export interface WorkspaceStoreActions {
  readonly attachProject: (
    id: string,
    ref: ScopedProjectRef,
    lastKnown?: WorkspaceCreationLastKnown,
  ) => WorkspaceAttachResult;
  readonly moveProject: (
    ref: ScopedProjectRef,
    expectedOwnerId: string,
    targetId: string,
  ) => boolean;
}

export type WorkspaceNewThreadDecision =
  | { readonly kind: "create"; readonly projectRef: ScopedProjectRef }
  | {
      readonly kind: "pick";
      readonly preferredProjectRef: ScopedProjectRef | null;
      readonly candidates: readonly ScopedProjectRef[];
    }
  | { readonly kind: "add-project" }
  | { readonly kind: "disconnected" };

export interface CapturedWorkspacePaletteScope {
  readonly workspaceId: string | null;
  readonly projectRefs: readonly ScopedProjectRef[];
}

export function scopedProjectRefsEqual(left: ScopedProjectRef, right: ScopedProjectRef): boolean {
  return left.environmentId === right.environmentId && left.projectId === right.projectId;
}

export function isCustomWorkspaceSelection(input: {
  readonly workspacesEnabled: boolean;
  readonly selectedWorkspaceId: string | null;
  readonly workspaces: readonly Pick<WorkspaceCreationWorkspace, "id">[];
}): boolean {
  return (
    input.workspacesEnabled &&
    input.selectedWorkspaceId !== null &&
    input.workspaces.some((workspace) => workspace.id === input.selectedWorkspaceId)
  );
}

export function findWorkspaceById(
  workspaces: readonly WorkspaceCreationWorkspace[],
  workspaceId: string | null,
): WorkspaceCreationWorkspace | null {
  if (workspaceId === null) {
    return null;
  }
  return workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
}

export function captureWorkspacePaletteScope(input: {
  readonly workspacesEnabled?: boolean;
  readonly intentWorkspaceId?: string | null;
  readonly selectedWorkspaceId: string | null;
  readonly workspaces: readonly WorkspaceCreationWorkspace[];
}): CapturedWorkspacePaletteScope {
  if (input.workspacesEnabled === false) {
    return { workspaceId: null, projectRefs: [] };
  }
  const workspaceId =
    input.intentWorkspaceId !== undefined ? input.intentWorkspaceId : input.selectedWorkspaceId;
  if (workspaceId === null) {
    return { workspaceId: null, projectRefs: [] };
  }
  const workspace = findWorkspaceById(input.workspaces, workspaceId);
  return {
    workspaceId,
    projectRefs: workspace?.projects.slice() ?? [],
  };
}

export function presentProjectKeySet(
  projects: readonly { readonly environmentId: EnvironmentId; readonly id: ProjectId }[],
): Set<string> {
  return new Set(
    projects.map((project) => scopedProjectKey(scopeProjectRef(project.environmentId, project.id))),
  );
}

export function eligibleAttachedProjectRefs(input: {
  readonly attachedProjects: readonly ScopedProjectRef[];
  readonly connectedEnvironmentIds: ReadonlySet<string>;
  readonly presentProjectKeys: ReadonlySet<string>;
}): ScopedProjectRef[] {
  return input.attachedProjects.filter(
    (projectRef) =>
      input.connectedEnvironmentIds.has(projectRef.environmentId) &&
      input.presentProjectKeys.has(scopedProjectKey(projectRef)),
  );
}

export function preferInScopeProjectRef(
  currentProjectRef: ScopedProjectRef | null,
  candidates: readonly ScopedProjectRef[],
): ScopedProjectRef | null {
  if (
    currentProjectRef &&
    candidates.some((candidate) => scopedProjectRefsEqual(candidate, currentProjectRef))
  ) {
    return currentProjectRef;
  }
  return candidates[0] ?? null;
}

export function resolveWorkspaceNewThreadDecision(input: {
  readonly attachedProjects: readonly ScopedProjectRef[];
  readonly connectedEnvironmentIds: ReadonlySet<string>;
  readonly presentProjectKeys: ReadonlySet<string>;
  readonly currentProjectRef: ScopedProjectRef | null;
  readonly local: boolean;
}): WorkspaceNewThreadDecision {
  const eligible = eligibleAttachedProjectRefs({
    attachedProjects: input.attachedProjects,
    connectedEnvironmentIds: input.connectedEnvironmentIds,
    presentProjectKeys: input.presentProjectKeys,
  });

  if (input.local) {
    const localTarget = preferInScopeProjectRef(input.currentProjectRef, eligible);
    if (localTarget) {
      return { kind: "create", projectRef: localTarget };
    }
    return input.attachedProjects.length === 0 ? { kind: "add-project" } : { kind: "disconnected" };
  }

  if (eligible.length === 1) {
    return { kind: "create", projectRef: eligible[0]! };
  }
  if (eligible.length > 1) {
    return {
      kind: "pick",
      preferredProjectRef: preferInScopeProjectRef(input.currentProjectRef, eligible),
      candidates: eligible,
    };
  }
  return input.attachedProjects.length === 0 ? { kind: "add-project" } : { kind: "disconnected" };
}

export function resolvePhysicalProjectsForWorkspace<
  T extends { readonly environmentId: EnvironmentId; readonly id: ProjectId },
>(attachedProjects: readonly ScopedProjectRef[], projects: readonly T[]): T[] {
  const byKey = new Map(
    projects.map((project) => [
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      project,
    ]),
  );
  const resolved: T[] = [];
  for (const projectRef of attachedProjects) {
    const project = byKey.get(scopedProjectKey(projectRef));
    if (project) {
      resolved.push(project);
    }
  }
  return resolved;
}

export function attachedProjectKeySet(attachedProjects: readonly ScopedProjectRef[]): Set<string> {
  return new Set(attachedProjects.map((projectRef) => scopedProjectKey(projectRef)));
}

export function isScopedProjectInWorkspace(
  projectRef: ScopedProjectRef,
  attachedProjects: readonly ScopedProjectRef[],
): boolean {
  return attachedProjects.some((candidate) => scopedProjectRefsEqual(candidate, projectRef));
}

export function filterItemsByAttachedProjects<
  T extends { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
>(items: readonly T[], attachedProjects: readonly ScopedProjectRef[]): T[] {
  const keys = attachedProjectKeySet(attachedProjects);
  return items.filter((item) =>
    keys.has(scopedProjectKey(scopeProjectRef(item.environmentId, item.projectId))),
  );
}

export function matchThreadsByTitle<T extends { readonly title: string }>(
  threads: readonly T[],
  query: string,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return [];
  }
  return threads.filter((thread) => thread.title.toLowerCase().includes(normalizedQuery));
}

export type WorkspaceAttachmentResolution =
  | { readonly status: "attached" }
  | { readonly status: "already-attached" }
  | { readonly status: "missing-workspace" }
  | { readonly status: "conflict"; readonly ownerId: string; readonly ownerName: string | null };

export function resolveWorkspaceAttachment(input: {
  readonly workspaceId: string;
  readonly projectRef: ScopedProjectRef;
  readonly lastKnown?: WorkspaceCreationLastKnown;
  readonly workspaces: readonly WorkspaceCreationWorkspace[];
  readonly attachProject: WorkspaceStoreActions["attachProject"];
}): WorkspaceAttachmentResolution {
  const workspace = findWorkspaceById(input.workspaces, input.workspaceId);
  if (!workspace) {
    return { status: "missing-workspace" };
  }

  const result = input.lastKnown
    ? input.attachProject(input.workspaceId, input.projectRef, input.lastKnown)
    : input.attachProject(input.workspaceId, input.projectRef);

  if (result.status === "conflict") {
    const ownerId = result.ownerId;
    if (!ownerId) {
      return { status: "missing-workspace" };
    }
    return {
      status: "conflict",
      ownerId,
      ownerName: findWorkspaceById(input.workspaces, ownerId)?.name ?? null,
    };
  }
  if (result.status === "missing-workspace") {
    return { status: "missing-workspace" };
  }
  if (result.status === "already-attached") {
    return { status: "already-attached" };
  }
  return { status: "attached" };
}

export function applyWorkspaceAttachmentMove(input: {
  readonly workspaceId: string;
  readonly projectRef: ScopedProjectRef;
  readonly expectedOwnerId: string;
  readonly workspaces: readonly WorkspaceCreationWorkspace[];
  readonly moveProject: WorkspaceStoreActions["moveProject"];
}): WorkspaceAttachmentResolution {
  if (!findWorkspaceById(input.workspaces, input.workspaceId)) {
    return { status: "missing-workspace" };
  }
  const moved = input.moveProject(input.projectRef, input.expectedOwnerId, input.workspaceId);
  if (!moved) {
    const owner = input.workspaces.find((workspace) =>
      workspace.projects.some((projectRef) => scopedProjectRefsEqual(projectRef, input.projectRef)),
    );
    if (!owner) {
      return { status: "missing-workspace" };
    }
    if (owner.id === input.workspaceId) {
      return { status: "already-attached" };
    }
    return {
      status: "conflict",
      ownerId: owner.id,
      ownerName: owner.name,
    };
  }
  return { status: "attached" };
}

export type WorkspaceCreateTargetCheck =
  | "ok"
  | "missing-workspace"
  | "not-a-member"
  | "unavailable";

export function checkCapturedWorkspaceCreateTarget(input: {
  readonly workspaceId: string;
  readonly projectRef: ScopedProjectRef;
  readonly workspaces: readonly WorkspaceCreationWorkspace[];
  readonly presentProjectKeys: ReadonlySet<string>;
  readonly connectedEnvironmentIds: ReadonlySet<string>;
}): WorkspaceCreateTargetCheck {
  const workspace = findWorkspaceById(input.workspaces, input.workspaceId);
  if (!workspace) {
    return "missing-workspace";
  }
  if (!isScopedProjectInWorkspace(input.projectRef, workspace.projects)) {
    return "not-a-member";
  }
  if (
    !input.connectedEnvironmentIds.has(input.projectRef.environmentId) ||
    !input.presentProjectKeys.has(scopedProjectKey(input.projectRef))
  ) {
    return "unavailable";
  }
  return "ok";
}

export function shouldQueryThreadContentSearch(input: {
  readonly open: boolean;
  readonly searchWorkspaceId: string | null;
  readonly isInSubmenu: boolean;
  readonly isActionsOnly: boolean;
}): boolean {
  return (
    input.open && input.searchWorkspaceId === null && !input.isInSubmenu && !input.isActionsOnly
  );
}

export function workspaceAttachmentNotice(
  resolution: WorkspaceAttachmentResolution,
): { readonly title: string; readonly description: string } | null {
  switch (resolution.status) {
    case "missing-workspace":
      return {
        title: "Workspace is no longer available",
        description: "The project stays in Default.",
      };
    case "attached":
    case "already-attached":
      return null;
    case "conflict":
      return null;
  }
}
