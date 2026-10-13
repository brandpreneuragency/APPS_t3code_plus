import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useCallback } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useClientSettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import { useUiStateStore } from "../../uiStateStore";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { readEnvironmentSupportsTitleRegeneration } from "../../state/entities";
import {
  archiveSelectedThreadEntries,
  buildMultiSelectThreadContextMenuItems,
} from "../Sidebar.logic";
import { resolveSnoozePresets } from "../Sidebar.snooze";
import { buildThreadActionMenuItems } from "../threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  isUnchangedWorkspaceBulkSelection,
  isWorkspaceBulkTitleRegenerationEligible,
  workspaceBulkBlockedMessage,
  workspaceBulkHasRunningThread,
  workspaceBulkTitleRegenerationMenu,
  type WorkspaceBulkSelection,
} from "./workspaceSelection";

function failureToast(title: string, error: unknown): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

export function useWorkspaceThreadMenu(input: {
  readonly getThread: (threadKey: string) => EnvironmentThreadShell | undefined;
  readonly resolveSelectedThreads: (threadKeys: readonly string[]) => WorkspaceBulkSelection;
  readonly projectCwd: string | null;
  readonly supports: (environmentId: EnvironmentThreadShell["environmentId"]) => {
    readonly settlement: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly isSettled: (threadKey: string) => boolean;
  readonly isSnoozed: (threadKey: string) => boolean;
  readonly onStartRename: (threadKey: string, title: string) => void;
}) {
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    confirmAndUnpinThread,
    archiveThread,
    deleteThread,
  } = useThreadActions();
  const handleNewThread = useNewThreadHandler();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((settings) => settings.confirmThreadArchive);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: "Path copied", description: path });
    },
    onError: (error) => failureToast("Failed to copy path", error),
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({ type: "success", title: "Branch copied", description: branch });
    },
    onError: (error) => failureToast("Failed to copy branch", error),
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) => {
      toastManager.add({ type: "success", title: "Thread ID copied", description: threadId });
    },
    onError: (error) => failureToast("Failed to copy thread ID", error),
  });

  const showThreadMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKey = scopedThreadKey(threadRef);
      const thread = input.getThread(threadKey);
      if (!thread) return;
      const supports = input.supports(thread.environmentId);
      const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat);
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          buildThreadActionMenuItems({
            branch: thread.branch ?? null,
            isPinned: thread.pinnedAt != null,
            isSettled: input.isSettled(threadKey),
            isSnoozed: input.isSnoozed(threadKey),
            canSnoozeNow: canSnooze(thread, { now: new Date().toISOString() }),
            isRegeneratingTitle: thread.titleRegeneration != null,
            isRunning: thread.session?.status === "running" && thread.session.activeTurnId != null,
            supports: {
              settlement: supports.settlement,
              snooze: supports.snooze,
              pinning: supports.pinning,
              titleRegeneration: supports.titleRegeneration,
            },
            snoozePresets,
          }),
          position,
        ),
      );
      if (clicked._tag === "Failure" || clicked.value == null) return;
      if (clicked.value.startsWith("snooze:")) {
        const preset = snoozePresets.find(
          (candidate) => `snooze:${candidate.id}` === clicked.value,
        );
        if (preset) {
          const result = await snoozeThread(threadRef, preset.snoozedUntil);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast("Failed to snooze thread", squashAtomCommandFailure(result));
          }
        }
        return;
      }
      switch (clicked.value) {
        case "new-thread-on-branch": {
          const result = await settlePromise(() =>
            handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId), {
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              envMode: thread.worktreePath ? "worktree" : "local",
              startFromOrigin: false,
            }),
          );
          if (result._tag === "Failure") {
            failureToast("Could not create thread", squashAtomCommandFailure(result));
          }
          return;
        }
        case "settle": {
          const result = await settleThread(threadRef);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast("Failed to settle thread", squashAtomCommandFailure(result));
          }
          return;
        }
        case "unsettle": {
          const result = await unsettleThread(threadRef);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast("Failed to un-settle thread", squashAtomCommandFailure(result));
          }
          return;
        }
        case "unsnooze": {
          const result = await unsnoozeThread(threadRef);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast("Failed to wake thread", squashAtomCommandFailure(result));
          }
          return;
        }
        case "pin": {
          const result = await pinThread(threadRef);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast("Failed to pin thread", squashAtomCommandFailure(result));
          }
          return;
        }
        case "unpin": {
          const result = await confirmAndUnpinThread(threadRef);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast("Failed to unpin thread", squashAtomCommandFailure(result));
          }
          return;
        }
        case "rename":
          input.onStartRename(threadKey, thread.title);
          return;
        case "regenerate-title": {
          const result = await updateThreadMetadata({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, regenerateTitle: true },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast("Failed to regenerate thread title", squashAtomCommandFailure(result));
          }
          return;
        }
        case "mark-unread":
          markThreadUnread(threadKey, thread.latestTurn?.completedAt);
          return;
        case "copy-path": {
          const path = thread.worktreePath ?? input.projectCwd;
          if (!path) {
            failureToast(
              "Path unavailable",
              new Error("This thread does not have a path to copy."),
            );
            return;
          }
          copyPathToClipboard(path, { path });
          return;
        }
        case "copy-branch":
          if (thread.branch) copyBranchToClipboard(thread.branch, { branch: thread.branch });
          return;
        case "copy-thread-id":
          copyThreadIdToClipboard(thread.id, { threadId: thread.id });
          return;
        case "archive": {
          if (confirmThreadArchive) {
            const confirmed = await settlePromise(() =>
              api.dialogs.confirm(`Archive thread "${thread.title}"?`),
            );
            if (confirmed._tag === "Failure" || !confirmed.value) return;
          }
          const result = await archiveThread(threadRef);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast("Failed to archive thread", squashAtomCommandFailure(result));
          }
          return;
        }
        case "delete": {
          if (confirmThreadDelete) {
            const confirmed = await settlePromise(() =>
              api.dialogs.confirm(
                [
                  `Delete thread "${thread.title}"?`,
                  "This permanently clears conversation history for this thread.",
                ].join("\n"),
                { variant: "destructive" },
              ),
            );
            if (confirmed._tag === "Failure" || !confirmed.value) return;
          }
          const result = await deleteThread(threadRef);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast("Failed to delete thread", squashAtomCommandFailure(result));
          }
        }
      }
    },
    [
      archiveThread,
      confirmAndUnpinThread,
      confirmThreadArchive,
      confirmThreadDelete,
      copyBranchToClipboard,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      handleNewThread,
      input,
      markThreadUnread,
      pinThread,
      settleThread,
      snoozeThread,
      timestampFormat,
      unsnoozeThread,
      unsettleThread,
      updateThreadMetadata,
    ],
  );

  const showMultiSelectMenu = useCallback(
    async (
      threadKeys: readonly string[],
      position: { x: number; y: number },
      onClear: () => void,
    ) => {
      const api = readLocalApi();
      if (!api || threadKeys.length === 0) return;
      const opened = input.resolveSelectedThreads(threadKeys);
      if (opened.status === "empty" || opened.status === "cancelled") return;
      if (opened.status !== "ready") {
        failureToast(
          "Can't apply this action",
          new Error(workspaceBulkBlockedMessage(opened.reason)),
        );
        return;
      }
      const count = opened.threadKeys.length;
      const hasRunningThread = workspaceBulkHasRunningThread(opened.threads);
      const allSupportTitleRegeneration = opened.threads.every((thread) =>
        readEnvironmentSupportsTitleRegeneration(thread.environmentId),
      );
      const anyRegeneratingTitle = opened.threads.some(
        (thread) => thread.titleRegeneration != null,
      );
      const titleItem = workspaceBulkTitleRegenerationMenu({
        count,
        allSupport: allSupportTitleRegeneration,
        anyRegenerating: anyRegeneratingTitle,
      });
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            ...buildMultiSelectThreadContextMenuItems({
              count,
              hasRunningThread,
            }),
            ...(titleItem ? [titleItem] : []),
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure" || clicked.value == null) return;
      const revalidated = (): Extract<
        WorkspaceBulkSelection,
        { readonly status: "ready" }
      > | null => {
        const current = input.resolveSelectedThreads(opened.threadKeys);
        if (current.status === "cancelled") return null;
        if (!isUnchangedWorkspaceBulkSelection(opened, current)) {
          failureToast(
            "Selection is no longer valid",
            new Error(
              current.status === "blocked"
                ? workspaceBulkBlockedMessage(current.reason)
                : "A selected thread left this workspace or is no longer live.",
            ),
          );
          return null;
        }
        return current;
      };
      const current = revalidated();
      if (!current) return;
      const threads = current.threads;
      if (clicked.value === "mark-unread") {
        for (const thread of threads) {
          markThreadUnread(
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
            thread.latestTurn?.completedAt,
          );
        }
        onClear();
        return;
      }
      if (clicked.value === "regenerate-title") {
        if (
          !isWorkspaceBulkTitleRegenerationEligible({
            threads,
            supportsTitleRegeneration: readEnvironmentSupportsTitleRegeneration,
          })
        ) {
          failureToast(
            "Can't regenerate titles",
            new Error("Title regeneration is no longer available for every selected thread."),
          );
          return;
        }
        for (const thread of threads) {
          const result = await updateThreadMetadata({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, regenerateTitle: true },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast("Failed to regenerate thread titles", squashAtomCommandFailure(result));
            return;
          }
        }
        onClear();
        return;
      }
      if (clicked.value === "archive") {
        if (confirmThreadArchive) {
          const confirmed = await settlePromise(() =>
            api.dialogs.confirm(`Archive ${count} thread${count === 1 ? "" : "s"}?`),
          );
          if (confirmed._tag === "Failure" || !confirmed.value) return;
        }
        const archiveSelection = revalidated();
        if (!archiveSelection) return;
        if (workspaceBulkHasRunningThread(archiveSelection.threads)) {
          failureToast(
            "Can't archive running threads",
            new Error("Interrupt or wait for the running thread before archiving."),
          );
          return;
        }
        const result = await archiveSelectedThreadEntries({
          entries: archiveSelection.threads.map((thread) => ({
            threadKey: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
            threadRef: scopeThreadRef(thread.environmentId, thread.id),
          })),
          archive: (entry, onArchived) => archiveThread(entry.threadRef, { onArchived }),
        });
        if (result.mutationFailure) {
          failureToast(
            "Failed to archive threads",
            squashAtomCommandFailure(result.mutationFailure),
          );
          return;
        }
        onClear();
        return;
      }
      if (clicked.value !== "delete") return;
      if (confirmThreadDelete) {
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete ${count} thread${count === 1 ? "" : "s"}?`,
              "This permanently clears conversation history for these threads.",
            ].join("\n"),
            { variant: "destructive" },
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      const deleteSelection = revalidated();
      if (!deleteSelection) return;
      for (const thread of deleteSelection.threads) {
        const result = await deleteThread(scopeThreadRef(thread.environmentId, thread.id));
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failureToast("Failed to delete threads", squashAtomCommandFailure(result));
          return;
        }
      }
      onClear();
    },
    [
      archiveThread,
      confirmThreadArchive,
      confirmThreadDelete,
      deleteThread,
      input,
      markThreadUnread,
      updateThreadMetadata,
    ],
  );

  return { showThreadMenu, showMultiSelectMenu, unsnoozeThread };
}
