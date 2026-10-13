/**
 * UI-only helpers for the workspace switcher, attach dialog, drag ids, and
 * Default-matching first-attachment display order. Canonical reconcile,
 * classification, pagination, and slot moves live in sidebarWorkspaceModel.
 */

import type { ChangeRequestSettleSource } from "@t3tools/client-runtime/state/thread-settled";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";

import { sortThreads } from "../../lib/threadSort";
import { revealSettledLimitThroughKey } from "../../sidebarWorkspaceModel";
import type { SidebarThreadSummary } from "../../types";
import {
  firstValidTimestampMs,
  resolveSettledTimestamp,
  sortPinnedThreadsForSidebar,
  sortSettledThreadsForSidebar,
  sortThreadsForSidebar,
} from "../Sidebar.logic";

type SidebarActiveSortThread = Parameters<typeof sortThreadsForSidebar>[0][number];
type SidebarPinnedSortThread = Parameters<typeof sortPinnedThreadsForSidebar>[0][number];
type SidebarSettledSortThread = Parameters<typeof resolveSettledTimestamp>[0] & {
  readonly id: string;
};
type SidebarLegacySortThread = Parameters<typeof sortThreads>[0][number];
type SidebarSeedThread = SidebarActiveSortThread &
  SidebarPinnedSortThread &
  SidebarSettledSortThread &
  SidebarLegacySortThread &
  Pick<SidebarThreadSummary, "pinnedAt" | "snoozedUntil">;

export type SidebarSeedLayout = "modern" | "legacy";

export interface MatchingChangeRequestSnapshot {
  readonly branch: string;
  readonly pr: ChangeRequestSettleSource;
  readonly linkedPullRequest?:
    | {
        readonly projectId: string;
        readonly repository: string;
        readonly number: number;
      }
    | undefined;
}

export interface MatchingChangeRequestThread {
  readonly linkedPullRequest?:
    | {
        readonly projectId: string;
        readonly repository: string;
        readonly number: number;
      }
    | null
    | undefined;
  readonly worktreePath?: string | null | undefined;
  readonly branch?: string | null | undefined;
}

export const WORKSPACE_SWITCHER_DEFAULT_ID = "default";
export const WORKSPACE_DND_DISTANCE_THRESHOLD = 8;
export const EMPTY_THREAD_ORDER: readonly string[] = Object.freeze([]);

/**
 * First attachment order is a durable preference. Wait until the settings
 * and shell snapshot are usable, and require a live server thread so a
 * transient draft-only or disconnected snapshot cannot become permanent.
 */
export function shouldSeedWorkspaceThreadOrder(input: {
  readonly storedOrder: readonly string[];
  readonly presentKeys: readonly string[];
  readonly settingsHydrated: boolean;
  readonly shellBootstrapped: boolean;
  readonly projectAvailable: boolean;
  readonly environmentConnected: boolean;
  readonly liveThreadShellCount: number;
}): boolean {
  return (
    input.storedOrder.length === 0 &&
    input.presentKeys.length > 0 &&
    input.settingsHydrated &&
    input.shellBootstrapped &&
    input.projectAvailable &&
    input.environmentConnected &&
    input.liveThreadShellCount > 0
  );
}

export type WorkspaceThreadOrderSeedDecision = "seed" | "wait" | "reconcile";

export function workspaceThreadOrderSeedDecision(input: {
  readonly storedOrder: readonly string[];
  readonly presentKeys: readonly string[];
  readonly settingsHydrated: boolean;
  readonly shellBootstrapped: boolean;
  readonly projectAvailable: boolean;
  readonly environmentConnected: boolean;
  readonly liveThreadShellCount: number;
}): WorkspaceThreadOrderSeedDecision {
  if (input.storedOrder.length !== 0 || input.presentKeys.length === 0) return "reconcile";
  return shouldSeedWorkspaceThreadOrder(input) ? "seed" : "wait";
}

export type ProjectAttachChoice =
  | { readonly kind: "unselected" }
  | { readonly kind: "attach" }
  | { readonly kind: "conflict"; readonly ownerId: string; readonly ownerName: string }
  | { readonly kind: "move"; readonly ownerId: string; readonly ownerName: string };

export function reorderCustomWorkspaceIds(input: {
  readonly customIds: readonly string[];
  readonly activeId: string;
  readonly overId: string;
}): string[] | null {
  if (input.activeId === WORKSPACE_SWITCHER_DEFAULT_ID) return null;
  if (input.overId === WORKSPACE_SWITCHER_DEFAULT_ID) return null;
  if (input.activeId === input.overId) return null;
  const from = input.customIds.indexOf(input.activeId);
  const to = input.customIds.indexOf(input.overId);
  if (from === -1 || to === -1) return null;
  const next = [...input.customIds];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return null;
  next.splice(to, 0, moved);
  return next;
}

export function nextProjectAttachChoice(input: {
  readonly current: ProjectAttachChoice;
  readonly ownerId: string | null;
  readonly ownerName: string | null;
  readonly selected: boolean;
}): ProjectAttachChoice {
  if (!input.selected) return { kind: "unselected" };
  if (input.current.kind === "move") return input.current;
  if (input.current.kind === "conflict") return input.current;
  if (input.ownerId) {
    return {
      kind: "conflict",
      ownerId: input.ownerId,
      ownerName: input.ownerName ?? "another workspace",
    };
  }
  return { kind: "attach" };
}

export function confirmProjectAttachMove(choice: ProjectAttachChoice): ProjectAttachChoice {
  if (choice.kind !== "conflict") return choice;
  return { kind: "move", ownerId: choice.ownerId, ownerName: choice.ownerName };
}

export function collectProjectAttachActions(
  choices: Readonly<Record<string, ProjectAttachChoice>>,
): {
  readonly attachKeys: string[];
  readonly moveKeys: Array<{ key: string; ownerId: string }>;
  readonly blockedKeys: string[];
} {
  const attachKeys: string[] = [];
  const moveKeys: Array<{ key: string; ownerId: string }> = [];
  const blockedKeys: string[] = [];
  for (const [key, choice] of Object.entries(choices)) {
    if (choice.kind === "attach") attachKeys.push(key);
    else if (choice.kind === "move") moveKeys.push({ key, ownerId: choice.ownerId });
    else if (choice.kind === "conflict") blockedKeys.push(key);
  }
  return { attachKeys, moveKeys, blockedKeys };
}

export function workspaceThreadDragId(input: {
  readonly projectKey: string;
  readonly group: "active" | "snoozed" | "settled";
  readonly threadKey: string;
}): string {
  return `${input.projectKey}::${input.group}::${input.threadKey}`;
}

export function parseWorkspaceThreadDragId(id: string): {
  readonly projectKey: string;
  readonly group: "active" | "snoozed" | "settled";
  readonly threadKey: string;
} | null {
  const first = id.indexOf("::");
  const second = id.indexOf("::", first + 2);
  if (first <= 0 || second <= first) return null;
  const projectKey = id.slice(0, first);
  const group = id.slice(first + 2, second);
  const threadKey = id.slice(second + 2);
  if (
    projectKey.length === 0 ||
    threadKey.length === 0 ||
    (group !== "active" && group !== "snoozed" && group !== "settled")
  ) {
    return null;
  }
  return { projectKey, group, threadKey };
}

export function formatWorkspaceStorageError(error: string | null): string | null {
  if (error == null) return null;
  const trimmed = error.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function sameStringArrays(left: readonly string[], right: readonly string[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Keep the previous array reference when contents match so React can bail out. */
export function retainEqualStringArray(previous: string[], next: readonly string[]): string[] {
  return sameStringArrays(previous, next) ? previous : [...next];
}

export function shouldPersistDefaultSidebarView(workspacesEnabled: boolean): boolean {
  return workspacesEnabled;
}

/**
 * Default Sidebar matching (see Sidebar.tsx around the snapshot lookup).
 * Linked threads match the current PR identity. Unlinked worktree checkouts
 * match snapshot.branch. Unlinked local checkouts (worktreePath === null)
 * keep the terminal snapshot even when the thread branch has moved — that
 * exception is intentional, not a generic “any branch mismatch rejects”.
 */
export function matchingChangeRequestFromSnapshot(input: {
  readonly snapshot: MatchingChangeRequestSnapshot | null | undefined;
  readonly thread: MatchingChangeRequestThread;
}): ChangeRequestSettleSource | null {
  const snapshot = input.snapshot;
  if (snapshot == null) return null;
  const linked = input.thread.linkedPullRequest;
  const matches =
    linked == null
      ? input.thread.worktreePath === null || snapshot.branch === input.thread.branch
      : snapshot.linkedPullRequest?.projectId === linked.projectId &&
        snapshot.linkedPullRequest.repository === linked.repository &&
        snapshot.linkedPullRequest.number === linked.number;
  return matches ? snapshot.pr : null;
}

function uniqueSeedKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const key of keys) {
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  return unique;
}

function sortSnoozedByNextWake<T extends SidebarSeedThread>(threads: readonly T[]): T[] {
  return [...threads].toSorted(
    (left, right) =>
      firstValidTimestampMs(left.snoozedUntil ?? null) -
      firstValidTimestampMs(right.snoozedUntil ?? null),
  );
}

function legacySortThreads<T extends SidebarSeedThread>(
  threads: readonly T[],
  threadSortOrder: SidebarThreadSortOrder,
): T[] {
  return sortThreads(threads, threadSortOrder);
}

export function seedDefaultDisplayOrderKeys<T extends SidebarSeedThread>(input: {
  readonly threads: readonly T[];
  readonly classify: (thread: T) => "active" | "snoozed" | "settled" | "archived";
  readonly threadKey: (thread: T) => string;
  readonly layout?: SidebarSeedLayout;
  readonly threadSortOrder?: SidebarThreadSortOrder;
}): string[] {
  const eligible: T[] = [];
  for (const thread of input.threads) {
    if (input.classify(thread) === "archived") continue;
    eligible.push(thread);
  }
  if (input.layout === "legacy") {
    return uniqueSeedKeys(
      legacySortThreads(eligible, input.threadSortOrder ?? "updated_at").map((thread) =>
        input.threadKey(thread),
      ),
    );
  }

  const pinned: T[] = [];
  const active: T[] = [];
  const snoozed: T[] = [];
  const settled: T[] = [];
  for (const thread of eligible) {
    const group = input.classify(thread);
    if (group === "snoozed") snoozed.push(thread);
    else if (group === "settled") settled.push(thread);
    else if (thread.pinnedAt != null) pinned.push(thread);
    else active.push(thread);
  }
  return uniqueSeedKeys(
    [
      ...sortPinnedThreadsForSidebar(pinned),
      ...sortThreadsForSidebar(active),
      ...sortSnoozedByNextWake(snoozed),
      ...sortSettledThreadsForSidebar(settled),
    ].map((thread) => input.threadKey(thread)),
  );
}

export function searchNavigationReveal(input: {
  readonly selectedKey: string | null;
  readonly belongsToProject: boolean;
  readonly folderExpanded: boolean;
  readonly settledKeys: readonly string[];
  readonly settledLimit: number;
  readonly snoozedKeys?: readonly string[];
  readonly snoozedExpanded?: boolean;
}): {
  readonly expand: boolean;
  readonly settledLimit: number;
  readonly snoozedExpanded: boolean;
} {
  const snoozedExpanded = input.snoozedExpanded === true;
  if (input.selectedKey === null || !input.belongsToProject) {
    return {
      expand: input.folderExpanded,
      settledLimit: input.settledLimit,
      snoozedExpanded,
    };
  }
  const revealed = revealSettledLimitThroughKey({
    settledKeys: input.settledKeys,
    targetKey: input.selectedKey,
    currentLimit: input.settledLimit,
  });
  return {
    expand: true,
    settledLimit: revealed?.limit ?? input.settledLimit,
    snoozedExpanded: snoozedExpanded || (input.snoozedKeys?.includes(input.selectedKey) ?? false),
  };
}
