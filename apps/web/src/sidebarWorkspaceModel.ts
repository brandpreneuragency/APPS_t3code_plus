import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import {
  effectiveSettled,
  effectiveSnoozed,
  type ChangeRequestSettleSource,
} from "@t3tools/client-runtime/state/thread-settled";
import type { OrchestrationThreadShell, ScopedProjectRef } from "@t3tools/contracts";

export const DEFAULT_SETTLED_VISIBLE_LIMIT = 3;
export const SETTLED_LOAD_MORE_STEP = 3;

export type WorkspaceThreadGroup = "active" | "snoozed" | "settled";

export interface WorkspaceThreadCapabilities {
  supportsSettlement: boolean;
  supportsSnooze: boolean;
}

export interface WorkspaceSettleOptions {
  now: string;
  snoozeNow?: string;
  autoSettleAfterDays: number | null;
  autoSettleOnMerge?: boolean;
}

export type WorkspaceClassifiableThread = OrchestrationThreadShell & {
  capabilities: WorkspaceThreadCapabilities;
  changeRequest?: ChangeRequestSettleSource | null;
};

export interface WorkspaceProjectPresentation {
  title: string;
  workspaceRoot: string;
  environmentLabel: string | null;
  availability: "live" | "cached" | "unknown";
}

export function classifyWorkspaceThread(
  thread: WorkspaceClassifiableThread,
  options: WorkspaceSettleOptions,
): WorkspaceThreadGroup | "archived" {
  if (thread.archivedAt != null) {
    return "archived";
  }

  const snoozeNow = options.snoozeNow ?? options.now;
  if (thread.capabilities.supportsSnooze && effectiveSnoozed(thread, { now: snoozeNow })) {
    return "snoozed";
  }

  if (
    thread.capabilities.supportsSettlement &&
    effectiveSettled(thread, settleCallOptions(thread, options))
  ) {
    return "settled";
  }

  return "active";
}

export function seedCanonicalThreadOrder(displayOrderedKeys: readonly string[]): string[] {
  return uniqueNonEmptyKeys(displayOrderedKeys);
}

export function reconcileCanonicalThreadOrder(input: {
  storedOrder: readonly string[];
  presentKeys: readonly string[];
  createdAtByKey: Readonly<Record<string, string>>;
}): { order: string[]; changed: boolean } {
  const storedOrder = uniqueNonEmptyKeys(input.storedOrder);
  const storedSet = new Set(storedOrder);
  const presentSet = new Set(input.presentKeys.filter((key) => key.length > 0));

  const newKeys = [...presentSet].filter((key) => !storedSet.has(key));
  newKeys.sort((left, right) => {
    const createdDelta =
      parseCreatedAtMs(input.createdAtByKey[right]) - parseCreatedAtMs(input.createdAtByKey[left]);
    return createdDelta !== 0 ? createdDelta : left.localeCompare(right);
  });

  const order = [...newKeys, ...storedOrder];
  return {
    order,
    changed: !sameKeySequence(order, storedOrder),
  };
}

export function applyCanonicalGroupSlotMove(input: {
  canonicalOrder: readonly string[];
  movableKeys: readonly string[];
  nextMovableOrder: readonly string[];
}): string[] | null {
  const movableKeys = uniqueNonEmptyKeys(input.movableKeys);
  const nextMovableOrder = uniqueNonEmptyKeys(input.nextMovableOrder);
  if (movableKeys.length === 0 || nextMovableOrder.length !== movableKeys.length) {
    return null;
  }

  const movableSet = new Set(movableKeys);
  if (nextMovableOrder.some((key) => !movableSet.has(key))) {
    return null;
  }

  const slots: number[] = [];
  for (const [index, key] of input.canonicalOrder.entries()) {
    if (movableSet.has(key)) {
      slots.push(index);
    }
  }
  if (slots.length !== movableKeys.length) {
    return null;
  }

  const occupying = slots.map((index) => input.canonicalOrder[index]!);
  if (occupying.some((key, index) => key !== movableKeys[index])) {
    return null;
  }

  const nextOrder = [...input.canonicalOrder];
  for (const [slotIndex, canonicalIndex] of slots.entries()) {
    nextOrder[canonicalIndex] = nextMovableOrder[slotIndex]!;
  }
  return nextOrder;
}

export function planWorkspaceThreadDrag(input: {
  canonicalOrder: readonly string[];
  sourceProjectKey: string;
  targetProjectKey: string;
  sourceGroup: WorkspaceThreadGroup;
  targetGroup: WorkspaceThreadGroup;
  sourceKey: string;
  targetKey: string;
  movableKeys: readonly string[];
}): { nextOrder: string[] } | null {
  if (
    input.sourceProjectKey !== input.targetProjectKey ||
    input.sourceGroup !== input.targetGroup
  ) {
    return null;
  }

  const movableKeys = uniqueNonEmptyKeys(input.movableKeys);
  const fromIndex = movableKeys.indexOf(input.sourceKey);
  const toIndex = movableKeys.indexOf(input.targetKey);
  if (fromIndex < 0 || toIndex < 0) {
    return null;
  }

  const nextMovableOrder = moveIndex(movableKeys, fromIndex, toIndex);
  const nextOrder = applyCanonicalGroupSlotMove({
    canonicalOrder: input.canonicalOrder,
    movableKeys,
    nextMovableOrder,
  });
  return nextOrder === null ? null : { nextOrder };
}

export function nextSettledVisibleLimit(currentLimit: number): number {
  const normalized = Number.isFinite(currentLimit)
    ? Math.max(DEFAULT_SETTLED_VISIBLE_LIMIT, Math.floor(currentLimit))
    : DEFAULT_SETTLED_VISIBLE_LIMIT;
  return normalized + SETTLED_LOAD_MORE_STEP;
}

export function resetSettledVisibleLimit(): number {
  return DEFAULT_SETTLED_VISIBLE_LIMIT;
}

export function visibleSettledKeys(settledKeys: readonly string[], limit: number): string[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  return settledKeys.slice(0, safeLimit);
}

export function revealSettledLimitThroughKey(input: {
  settledKeys: readonly string[];
  targetKey: string;
  currentLimit: number;
}): { limit: number; alreadyVisible: boolean } | null {
  const index = input.settledKeys.indexOf(input.targetKey);
  if (index < 0) {
    return null;
  }

  const currentLimit = Number.isFinite(input.currentLimit)
    ? Math.max(0, Math.floor(input.currentLimit))
    : 0;
  if (index < currentLimit) {
    return { limit: currentLimit, alreadyVisible: true };
  }

  const needed = index + 1;
  const steps = Math.ceil(needed / SETTLED_LOAD_MORE_STEP);
  return {
    limit: Math.max(currentLimit, steps * SETTLED_LOAD_MORE_STEP),
    alreadyVisible: false,
  };
}

export function isWorkspaceSearchActive(query: string): boolean {
  return query.trim().length > 0;
}

export function searchWorkspaceThreadsByTitle<T extends { readonly title: string }>(
  threads: readonly T[],
  query: string,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return [];
  }
  return threads.filter((thread) => thread.title.toLowerCase().includes(normalizedQuery));
}

export function shouldIncludeWorkspaceDraft(input: { hasUserContent: boolean }): boolean {
  return input.hasUserContent;
}

export function applyDraftPromotionToOrder(
  order: readonly string[],
  draftKey: string,
  serverKey: string,
): string[] {
  if (draftKey.length === 0 || serverKey.length === 0) {
    return [...order];
  }
  if (draftKey === serverKey) {
    return uniqueNonEmptyKeys(order);
  }

  const next: string[] = [];
  let replaced = false;
  for (const key of order) {
    if (key === draftKey) {
      if (!replaced) {
        next.push(serverKey);
        replaced = true;
      }
      continue;
    }
    if (key === serverKey) {
      if (!replaced) {
        next.push(serverKey);
        replaced = true;
      }
      continue;
    }
    next.push(key);
  }
  return next;
}

export function transferThreadKeyBetweenOrders(input: {
  fromOrder: readonly string[];
  toOrder: readonly string[];
  key: string;
}): { fromOrder: string[]; toOrder: string[] } {
  const key = input.key;
  const fromOrder = input.fromOrder.filter((candidate) => candidate !== key);
  const destWithout = input.toOrder.filter((candidate) => candidate !== key);
  const toOrder = key.length === 0 ? destWithout : [key, ...destWithout];
  return { fromOrder, toOrder };
}

export interface WorkspaceDraftOrderDraft {
  readonly key: string;
  readonly projectKey: string;
  readonly createdAt?: string;
  readonly promotedToKey?: string | null;
  readonly aliasKeys?: readonly string[];
}

/**
 * Move current draft/promoted identities to their target project orders.
 * Only rewrites keys in the draft records, so offline real-thread keys stay.
 * An empty destination is left empty so first-attachment seed can still run.
 * Unseen identities prepend as one creation-desc / scoped-key batch.
 */
export function planDraftOrderMembership(input: {
  readonly ordersByProjectKey: Readonly<Record<string, readonly string[]>>;
  readonly drafts: ReadonlyArray<WorkspaceDraftOrderDraft>;
}): Record<string, string[]> {
  const drafts: Array<{
    canonicalKey: string;
    projectKey: string;
    createdAt: string;
    aliases: string[];
  }> = [];
  const seenCanonical = new Set<string>();
  for (const draft of input.drafts) {
    if (draft.key.length === 0 || draft.projectKey.length === 0) continue;
    const promoted =
      draft.promotedToKey != null && draft.promotedToKey.length > 0 ? draft.promotedToKey : null;
    const canonicalKey = promoted ?? draft.key;
    if (seenCanonical.has(canonicalKey)) continue;
    seenCanonical.add(canonicalKey);
    drafts.push({
      canonicalKey,
      projectKey: draft.projectKey,
      createdAt: draft.createdAt ?? "",
      aliases: uniqueNonEmptyKeys([
        draft.key,
        ...(draft.aliasKeys ?? []),
        ...(promoted ? [promoted] : []),
      ]),
    });
  }

  const identityTarget = new Map<string, string>();
  for (const draft of drafts) {
    for (const alias of draft.aliases) {
      identityTarget.set(alias, draft.projectKey);
    }
  }

  const next: Record<string, string[]> = {};
  for (const [projectKey, order] of Object.entries(input.ordersByProjectKey)) {
    let rewritten = uniqueNonEmptyKeys(order);
    for (const draft of drafts) {
      for (const alias of draft.aliases) {
        if (alias === draft.canonicalKey) continue;
        rewritten = applyDraftPromotionToOrder(rewritten, alias, draft.canonicalKey);
      }
    }
    next[projectKey] = rewritten.filter((key) => {
      const dest = identityTarget.get(key);
      return dest === undefined || dest === projectKey;
    });
  }

  const unseenByDest = new Map<string, Array<{ key: string; createdAt: string }>>();
  for (const draft of drafts) {
    const original = input.ordersByProjectKey[draft.projectKey];
    if (original === undefined || original.length === 0) continue;
    const destOrder = next[draft.projectKey] ?? uniqueNonEmptyKeys(original);
    if (destOrder.includes(draft.canonicalKey)) continue;
    const batch = unseenByDest.get(draft.projectKey) ?? [];
    batch.push({ key: draft.canonicalKey, createdAt: draft.createdAt });
    unseenByDest.set(draft.projectKey, batch);
  }

  for (const [projectKey, batch] of unseenByDest) {
    const uniqueBatch = uniqueNonEmptyKeys(batch.map((item) => item.key));
    const createdAtByKey = Object.fromEntries(
      batch.map((item) => [item.key, item.createdAt] as const),
    );
    uniqueBatch.sort((left, right) => {
      const createdDelta =
        parseCreatedAtMs(createdAtByKey[right]) - parseCreatedAtMs(createdAtByKey[left]);
      return createdDelta !== 0 ? createdDelta : left.localeCompare(right);
    });
    next[projectKey] = [...uniqueBatch, ...(next[projectKey] ?? [])];
  }

  return next;
}

export function resolveWorkspaceProjectPresentation(input: {
  live?: { title: string; workspaceRoot: string; environmentLabel: string | null } | null;
  lastKnown?: { title: string; workspaceRoot: string; environmentLabel: string | null } | null;
  connected?: boolean;
}): WorkspaceProjectPresentation {
  const connected = input.connected !== false;
  if (connected && input.live) {
    return { ...input.live, availability: "live" };
  }
  if (input.lastKnown) {
    return { ...input.lastKnown, availability: "cached" };
  }
  if (input.live) {
    return { ...input.live, availability: "cached" };
  }
  return {
    title: "",
    workspaceRoot: "",
    environmentLabel: null,
    availability: "unknown",
  };
}

export function orderThreadsByCanonical<T>(
  threads: readonly T[],
  canonicalOrder: readonly string[],
  getKey: (thread: T) => string,
): T[] {
  const remaining = new Map<string, T[]>();
  for (const thread of threads) {
    const key = getKey(thread);
    const bucket = remaining.get(key);
    if (bucket) {
      bucket.push(thread);
    } else {
      remaining.set(key, [thread]);
    }
  }

  const ordered: T[] = [];
  for (const key of canonicalOrder) {
    const bucket = remaining.get(key);
    if (!bucket || bucket.length === 0) {
      continue;
    }
    ordered.push(bucket.shift()!);
    if (bucket.length === 0) {
      remaining.delete(key);
    }
  }

  const unseen: T[] = [];
  for (const thread of threads) {
    const key = getKey(thread);
    const bucket = remaining.get(key);
    if (!bucket || bucket.length === 0) {
      continue;
    }
    const index = bucket.indexOf(thread);
    if (index < 0) {
      continue;
    }
    unseen.push(thread);
    bucket.splice(index, 1);
    if (bucket.length === 0) {
      remaining.delete(key);
    }
  }

  return [...unseen, ...ordered];
}

export function partitionWorkspaceThreads<T>(
  orderedThreads: readonly T[],
  classify: (thread: T) => WorkspaceThreadGroup | "archived",
): { active: T[]; snoozed: T[]; settled: T[] } {
  const active: T[] = [];
  const snoozed: T[] = [];
  const settled: T[] = [];
  for (const thread of orderedThreads) {
    const group = classify(thread);
    if (group === "active") {
      active.push(thread);
    } else if (group === "snoozed") {
      snoozed.push(thread);
    } else if (group === "settled") {
      settled.push(thread);
    }
  }
  return { active, snoozed, settled };
}

export function buildWorkspaceProjectThreadView<T extends { readonly title: string }>(input: {
  threads: readonly T[];
  getKey: (thread: T) => string;
  classify: (thread: T) => WorkspaceThreadGroup | "archived";
  canonicalOrder: readonly string[];
  settledLimit: number;
  snoozedExpanded: boolean;
  folderExpanded: boolean;
  query: string;
}): {
  active: T[];
  snoozed: T[];
  settled: T[];
  visibleSettled: T[];
  hiddenSettledCount: number;
  canLoadMore: boolean;
  canShowLess: boolean;
  showSnoozedDisclosure: boolean;
  searchMatches: T[];
  visibleThreads: T[];
} {
  const ordered = orderThreadsByCanonical(input.threads, input.canonicalOrder, input.getKey);
  const { active, snoozed, settled } = partitionWorkspaceThreads(ordered, input.classify);
  const visibleSettled = settled.slice(
    0,
    Number.isFinite(input.settledLimit) ? Math.max(0, Math.floor(input.settledLimit)) : 0,
  );
  const searching = isWorkspaceSearchActive(input.query);
  const eligibleForSearch = [...active, ...snoozed, ...settled];
  const searchMatches = searching
    ? searchWorkspaceThreadsByTitle(eligibleForSearch, input.query)
    : [];

  const visibleThreads = searching
    ? searchMatches
    : input.folderExpanded
      ? [...active, ...(input.snoozedExpanded ? snoozed : []), ...visibleSettled]
      : [];

  return {
    active,
    snoozed,
    settled,
    visibleSettled,
    hiddenSettledCount: Math.max(0, settled.length - visibleSettled.length),
    canLoadMore: settled.length > visibleSettled.length,
    canShowLess: input.settledLimit > DEFAULT_SETTLED_VISIBLE_LIMIT,
    showSnoozedDisclosure: snoozed.length > 0,
    searchMatches,
    visibleThreads,
  };
}

export function workspaceProjectKey(ref: ScopedProjectRef): string {
  return scopedProjectKey(ref);
}

export const WORKSPACE_SETTLED_INITIAL_LIMIT = DEFAULT_SETTLED_VISIBLE_LIMIT;
export const WORKSPACE_SETTLED_PAGE_SIZE = SETTLED_LOAD_MORE_STEP;

export function reconcileWorkspaceThreadOrder(input: {
  existingKeys: readonly string[];
  incoming: readonly { key: string; createdAt: string }[];
}): string[] {
  return reconcileCanonicalThreadOrder({
    storedOrder: input.existingKeys,
    presentKeys: input.incoming.map((item) => item.key),
    createdAtByKey: Object.fromEntries(input.incoming.map((item) => [item.key, item.createdAt])),
  }).order;
}

export function shouldPersistReconciledOrder(
  existingKeys: readonly string[],
  nextKeys: readonly string[],
): boolean {
  return !sameKeySequence(existingKeys, nextKeys);
}

export function applyWorkspaceStatusGroupReorder(input: {
  canonicalKeys: readonly string[];
  groupKeys: readonly string[];
  activeId: string;
  overId: string;
}): string[] | null {
  const result = planWorkspaceThreadDrag({
    canonicalOrder: input.canonicalKeys,
    sourceProjectKey: "project",
    targetProjectKey: "project",
    sourceGroup: "active",
    targetGroup: "active",
    sourceKey: input.activeId,
    targetKey: input.overId,
    movableKeys: input.groupKeys,
  });
  return result?.nextOrder ?? null;
}

export function classifyWorkspaceThreadGroup(
  thread: WorkspaceClassifiableThread,
  options: WorkspaceSettleOptions,
): WorkspaceThreadGroup | "hidden" {
  const group = classifyWorkspaceThread(thread, options);
  return group === "archived" ? "hidden" : group;
}

export function partitionWorkspaceThreadKeys(input: {
  orderedKeys: readonly string[];
  statusByKey: ReadonlyMap<string, WorkspaceThreadGroup | "archived" | "hidden">;
}): { active: string[]; snoozed: string[]; settled: string[] } {
  const active: string[] = [];
  const snoozed: string[] = [];
  const settled: string[] = [];
  for (const key of input.orderedKeys) {
    const status = input.statusByKey.get(key);
    if (status === "active") {
      active.push(key);
    } else if (status === "snoozed") {
      snoozed.push(key);
    } else if (status === "settled") {
      settled.push(key);
    }
  }
  return { active, snoozed, settled };
}

function settleCallOptions(
  thread: WorkspaceClassifiableThread,
  options: WorkspaceSettleOptions,
): {
  readonly now: string;
  readonly autoSettleAfterDays: number | null;
  readonly autoSettleOnMerge?: boolean;
  readonly changeRequest?: ChangeRequestSettleSource | null;
} {
  return {
    now: options.now,
    autoSettleAfterDays: options.autoSettleAfterDays,
    ...(options.autoSettleOnMerge === undefined
      ? {}
      : { autoSettleOnMerge: options.autoSettleOnMerge }),
    ...(thread.changeRequest === undefined ? {} : { changeRequest: thread.changeRequest }),
  };
}

function uniqueNonEmptyKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const key of keys) {
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(key);
  }
  return unique;
}

function sameKeySequence(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((key, index) => key === right[index]);
}

function parseCreatedAtMs(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function moveIndex<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) {
    return next;
  }
  next.splice(toIndex, 0, moved);
  return next;
}
