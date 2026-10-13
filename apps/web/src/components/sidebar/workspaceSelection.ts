/**
 * Workspace-wide visible-order reporting and bulk-selection resolution.
 * Kept beside the custom sidebar so Default/legacy selection stores stay unchanged.
 */

import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";

import { sameStringArrays } from "./workspaceUi";

export interface WorkspaceVisibleKeysMaps<TDraftId extends string = string> {
  keysByProject: Map<string, string[]>;
  draftIdByKey: Map<string, TDraftId>;
  projectDraftKeys: Map<string, string[]>;
  liveByProject: Map<string, boolean>;
}

export interface WorkspaceVisibleKeysReport<TDraftId extends string = string> {
  readonly keys: readonly string[];
  readonly drafts?: ReadonlyMap<string, TDraftId>;
  readonly live: boolean;
}

export interface WorkspaceVisibleOrders {
  readonly visibleOrder: string[];
  readonly selectionOrder: string[];
}

export type WorkspaceBulkProjectStatus =
  | "live"
  | "cancelled"
  | "missing-workspace"
  | "not-attached"
  | "missing-project"
  | "offline";

export function evaluateWorkspaceBulkProject(input: {
  readonly initiatingWorkspaceId: string;
  readonly selectedWorkspaceId: string | null;
  readonly workspace: {
    readonly id: string;
    readonly projects: readonly ScopedProjectRef[];
  } | null;
  readonly projectKey: string;
  readonly projectExists: boolean;
  readonly connected: boolean;
}): WorkspaceBulkProjectStatus {
  if (input.selectedWorkspaceId !== input.initiatingWorkspaceId) return "cancelled";
  if (input.workspace == null) return "missing-workspace";
  const attached = input.workspace.projects.some(
    (ref) => scopedProjectKey(ref) === input.projectKey,
  );
  if (!attached) return "not-attached";
  if (!input.projectExists) return "missing-project";
  if (!input.connected) return "offline";
  return "live";
}

export function applyWorkspaceVisibleKeysReport<TDraftId extends string>(
  maps: WorkspaceVisibleKeysMaps<TDraftId>,
  projectKeys: readonly string[],
  projectKey: string,
  report: WorkspaceVisibleKeysReport<TDraftId>,
): WorkspaceVisibleOrders {
  maps.keysByProject.set(projectKey, [...report.keys]);
  maps.liveByProject.set(projectKey, report.live);
  if (report.drafts) {
    for (const key of maps.projectDraftKeys.get(projectKey) ?? []) {
      maps.draftIdByKey.delete(key);
    }
    const nextDraftKeys: string[] = [];
    for (const [key, draftId] of report.drafts) {
      maps.draftIdByKey.set(key, draftId);
      nextDraftKeys.push(key);
    }
    maps.projectDraftKeys.set(projectKey, nextDraftKeys);
  }
  return rebuildWorkspaceVisibleOrders(maps, projectKeys);
}

export function rebuildWorkspaceVisibleOrders<TDraftId extends string>(
  maps: WorkspaceVisibleKeysMaps<TDraftId>,
  projectKeys: readonly string[],
): WorkspaceVisibleOrders {
  dropUnattachedProjectMaps(maps, projectKeys);
  const visibleOrder = projectKeys.flatMap((key) => maps.keysByProject.get(key) ?? []);
  const selectionOrder = projectKeys.flatMap((key) => {
    if (maps.liveByProject.get(key) !== true) return [];
    const keys = maps.keysByProject.get(key) ?? [];
    return keys.filter((threadKey) => !maps.draftIdByKey.has(threadKey));
  });
  return { visibleOrder, selectionOrder };
}

function dropUnattachedProjectMaps<TDraftId extends string>(
  maps: WorkspaceVisibleKeysMaps<TDraftId>,
  projectKeys: readonly string[],
): void {
  const attached = new Set(projectKeys);
  const detachedKeys: string[] = [];
  for (const key of maps.keysByProject.keys()) {
    if (!attached.has(key)) detachedKeys.push(key);
  }
  for (const key of detachedKeys) {
    for (const draftKey of maps.projectDraftKeys.get(key) ?? []) {
      maps.draftIdByKey.delete(draftKey);
    }
    maps.keysByProject.delete(key);
    maps.projectDraftKeys.delete(key);
    maps.liveByProject.delete(key);
  }
}

export function staleWorkspaceSelectionKeys(input: {
  readonly selectedKeys: readonly string[];
  readonly selectionOrder: readonly string[];
}): string[] {
  const allowed = new Set(input.selectionOrder);
  return input.selectedKeys.filter((key) => !allowed.has(key));
}

export type WorkspaceBulkSelection =
  | { readonly status: "empty" }
  | { readonly status: "cancelled" }
  | {
      readonly status: "ready";
      readonly threadKeys: readonly string[];
      readonly threads: readonly EnvironmentThreadShell[];
    }
  | {
      readonly status: "blocked";
      readonly reason:
        | "unresolved"
        | "draft"
        | "offline"
        | "missing-workspace"
        | "not-attached"
        | "missing-project";
      readonly selectedCount: number;
      readonly resolvedCount: number;
    };

export function workspaceBulkBlockedMessage(
  reason: Extract<WorkspaceBulkSelection, { readonly status: "blocked" }>["reason"],
): string {
  switch (reason) {
    case "draft":
      return "Drafts can't be changed with bulk thread actions.";
    case "unresolved":
      return "A selected thread is no longer available.";
    case "offline":
      return "A selected project is offline.";
    case "missing-workspace":
      return "This workspace is no longer available.";
    case "not-attached":
      return "A selected project is no longer in this workspace.";
    case "missing-project":
      return "A selected project is no longer available.";
  }
}

export function resolveWorkspaceBulkSelection(input: {
  readonly selectedKeys: readonly string[];
  readonly isDraftKey: (threadKey: string) => boolean;
  readonly getThread: (threadKey: string) => EnvironmentThreadShell | undefined;
  readonly evaluateProject: (projectKey: string) => WorkspaceBulkProjectStatus;
}): WorkspaceBulkSelection {
  if (input.selectedKeys.length === 0) return { status: "empty" };
  const threads: EnvironmentThreadShell[] = [];
  for (const key of input.selectedKeys) {
    if (input.isDraftKey(key)) {
      return {
        status: "blocked",
        reason: "draft",
        selectedCount: input.selectedKeys.length,
        resolvedCount: threads.length,
      };
    }
    const thread = input.getThread(key);
    if (!thread) {
      return {
        status: "blocked",
        reason: "unresolved",
        selectedCount: input.selectedKeys.length,
        resolvedCount: threads.length,
      };
    }
    const projectKey = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
    const projectStatus = input.evaluateProject(projectKey);
    if (projectStatus === "cancelled") return { status: "cancelled" };
    if (projectStatus !== "live") {
      return {
        status: "blocked",
        reason: projectStatus,
        selectedCount: input.selectedKeys.length,
        resolvedCount: threads.length,
      };
    }
    threads.push(thread);
  }
  return {
    status: "ready",
    threadKeys: input.selectedKeys,
    threads,
  };
}

export function isWorkspaceBulkTitleRegenerationEligible(input: {
  readonly threads: readonly Pick<EnvironmentThreadShell, "environmentId" | "titleRegeneration">[];
  readonly supportsTitleRegeneration: (environmentId: EnvironmentId) => boolean;
}): boolean {
  return (
    input.threads.length > 0 &&
    input.threads.every(
      (thread) =>
        input.supportsTitleRegeneration(thread.environmentId) && thread.titleRegeneration == null,
    )
  );
}

export function workspaceBulkTitleRegenerationMenu(input: {
  readonly count: number;
  readonly allSupport: boolean;
  readonly anyRegenerating: boolean;
}): { readonly id: "regenerate-title"; readonly label: string; readonly disabled?: true } | null {
  if (!input.allSupport || input.count === 0) return null;
  if (input.anyRegenerating) {
    return {
      id: "regenerate-title",
      label: `Regenerating… (${input.count})`,
      disabled: true,
    };
  }
  return { id: "regenerate-title", label: `Regenerate titles (${input.count})` };
}

export function workspaceBulkHasRunningThread(
  threads: readonly Pick<EnvironmentThreadShell, "session">[],
): boolean {
  return threads.some(
    (thread) => thread.session?.status === "running" && thread.session.activeTurnId != null,
  );
}

export function isUnchangedWorkspaceBulkSelection(
  opened: Extract<WorkspaceBulkSelection, { readonly status: "ready" }>,
  current: WorkspaceBulkSelection,
): current is Extract<WorkspaceBulkSelection, { readonly status: "ready" }> {
  return current.status === "ready" && sameStringArrays(opened.threadKeys, current.threadKeys);
}

export function workspaceThreadPointerAction(input: {
  readonly modClick: boolean;
  readonly shiftClick: boolean;
  readonly liveAttachedThread: boolean;
}): "toggle" | "range" | "navigate" {
  if (!input.liveAttachedThread) return "navigate";
  if (input.modClick) return "toggle";
  if (input.shiftClick) return "range";
  return "navigate";
}
