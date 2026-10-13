import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { AlarmClockOffIcon, PinIcon, SquarePenIcon, XIcon } from "lucide-react";
import {
  memo,
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type { ChangeRequestSettleSource } from "@t3tools/client-runtime/state/thread-settled";
import { type DraftId, type DraftSessionState } from "../../composerDraftStore";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { isMacPlatform } from "../../lib/utils";
import { cn } from "../../lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { shouldShowInstanceBadge } from "../../providerInstances";
import {
  isSidebarNestedLinkClick,
  isTrailingDoubleClick,
  resolveThreadStatusPill,
} from "../Sidebar.logic";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { animatePinnedLayoutChanges } from "../Sidebar.logic";
import {
  clearWorkspacePointerGuard,
  consumeWorkspaceClickGuard,
  consumeWorkspaceKeyboardGuard,
  prepareWorkspaceKeyboardGesture,
  type WorkspaceDragState,
} from "./workspaceDrag";

const ROW_CLASS =
  "group/workspace-row flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-sm outline-none select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

export const WorkspaceThreadRow = memo(function WorkspaceThreadRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly group: "active" | "snoozed" | "settled";
  readonly dragId: string;
  readonly dragState: WorkspaceDragState;
  readonly isActive: boolean;
  readonly isSelected: boolean;
  readonly jumpLabel: string | null;
  readonly liveStatus: boolean;
  readonly canDrag: boolean;
  readonly providerEntry: ProviderInstanceEntry | null;
  readonly providerEntries: Iterable<ProviderInstanceEntry>;
  readonly isRenaming: boolean;
  readonly renamingTitle: string;
  readonly wakeLabel: string | null;
  readonly onRenameTitleChange: (value: string) => void;
  readonly onCommitRename: () => void;
  readonly onCancelRename: () => void;
  readonly onClick: (event: ReactMouseEvent, threadKey: string) => void;
  readonly onActivate: () => void;
  readonly onStartRename: () => void;
  readonly onWake?: () => void;
  readonly projectCwd: string | null;
  readonly changeRequest: ChangeRequestSettleSource | null;
  readonly onBulkContextMenu?: (event: ReactMouseEvent) => boolean;
  readonly isTargetValid?: () => boolean;
}) {
  const threadRef = scopeThreadRef(props.thread.environmentId, props.thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const { openMenu } = useThreadActionMenu({
    threadRef,
    projectCwd: props.projectCwd,
    changeRequest: props.changeRequest,
    onStartRename: props.onStartRename,
    ...(props.isTargetValid ? { isTargetValid: props.isTargetValid } : {}),
  });
  const sortable = useSortable({
    id: props.dragId,
    disabled: !props.canDrag,
    animateLayoutChanges: animatePinnedLayoutChanges,
  });
  const status = props.liveStatus ? resolveThreadStatusPill({ thread: props.thread }) : null;
  const settled = props.group === "settled";
  const dot = settled
    ? { label: "Settled", dotClass: "bg-[var(--contrast-icon-muted)]" }
    : status && ["Working", "Connecting", "Monitoring"].includes(status.label)
      ? { label: status.label, dotClass: "bg-orange-500" }
      : (status ??
        (props.liveStatus && props.thread.latestTurn?.completedAt
          ? { label: "Completed", dotClass: "bg-emerald-500" }
          : {
              label: props.liveStatus ? "Idle" : "Disconnected",
              dotClass: "bg-[var(--contrast-icon-muted)]",
            }));

  const handleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (consumeWorkspaceClickGuard(props.dragState)) {
        event.preventDefault();
        return;
      }
      if (isSidebarNestedLinkClick(event.target)) return;
      if (isTrailingDoubleClick(event.detail)) return;
      props.onClick(event, threadKey);
    },
    [props, threadKey],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest("button, input, a")) return;
      prepareWorkspaceKeyboardGesture(props.dragState);
      const sortableKeyDown = sortable.listeners?.onKeyDown;
      if (typeof sortableKeyDown === "function") {
        sortableKeyDown(event);
      }
      if (consumeWorkspaceKeyboardGuard(props.dragState)) {
        event.preventDefault();
        return;
      }
      if (event.defaultPrevented || sortable.isSorting || sortable.isDragging) return;
      if (event.key === "Enter") {
        event.preventDefault();
        props.onActivate();
      }
    },
    [props, sortable.isDragging, sortable.isSorting, sortable.listeners],
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      if (consumeWorkspaceClickGuard(props.dragState)) {
        event.preventDefault();
        return;
      }
      if (props.onBulkContextMenu?.(event)) return;
      event.preventDefault();
      if (!props.liveStatus) return;
      void openMenu({ x: event.clientX, y: event.clientY });
    },
    [openMenu, props],
  );

  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (consumeWorkspaceClickGuard(props.dragState)) {
        event.preventDefault();
        return;
      }
      if (props.isRenaming || !props.liveStatus) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if ((event.target as HTMLElement).closest("button, a, input")) return;
      event.preventDefault();
      props.onStartRename();
    },
    [props],
  );

  return (
    <li
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className="list-none"
      data-thread-item
    >
      <div
        role="button"
        tabIndex={0}
        {...(props.canDrag ? sortable.attributes : {})}
        {...(props.canDrag
          ? Object.fromEntries(
              Object.entries(sortable.listeners ?? {}).filter(([key]) => key !== "onKeyDown"),
            )
          : {})}
        aria-current={props.isActive ? "true" : undefined}
        data-testid={`workspace-thread-row-${props.thread.id}`}
        className={cn(
          ROW_CLASS,
          props.canDrag && "cursor-grab active:cursor-grabbing",
          props.isSelected && props.isActive
            ? "bg-sidebar-row-active font-medium text-sidebar-foreground"
            : props.isSelected
              ? "bg-sidebar-row-selected text-sidebar-foreground"
              : props.isActive
                ? "bg-sidebar-row-active font-medium text-sidebar-foreground"
                : "text-sidebar-muted-foreground/90 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
          settled && !props.isActive && "text-sidebar-muted-foreground/70",
        )}
        onPointerDownCapture={() => clearWorkspacePointerGuard(props.dragState)}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
      >
        <span
          aria-label={dot.label}
          className={cn("size-1.5 shrink-0 rounded-full", dot.dotClass)}
        />
        {props.isRenaming ? (
          <input
            className="min-w-0 flex-1 truncate rounded-sm border border-ring bg-transparent px-0.5 text-sm outline-none"
            value={props.renamingTitle}
            autoFocus
            onChange={(event) => props.onRenameTitleChange(event.currentTarget.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                props.onCommitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                props.onCancelRename();
              }
            }}
            onBlur={props.onCommitRename}
          />
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={<span className="min-w-0 flex-1 truncate">{props.thread.title}</span>}
            />
            <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
              {props.thread.title}
            </TooltipPopup>
          </Tooltip>
        )}
        {props.thread.pinnedAt != null ? (
          <PinIcon aria-label="Pinned" className="size-3 shrink-0 text-muted-foreground/60" />
        ) : null}
        {props.jumpLabel ? (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {props.jumpLabel}
          </span>
        ) : null}
        {props.group === "snoozed" && props.onWake ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Wake thread"
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (consumeWorkspaceClickGuard(props.dragState)) return;
                    if (props.isTargetValid?.() === false) return;
                    props.onWake?.();
                  }}
                />
              }
            >
              <AlarmClockOffIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {props.wakeLabel ? `Wake (${props.wakeLabel})` : "Wake thread"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {props.providerEntry ? (
          <ProviderInstanceIcon
            driverKind={props.providerEntry.driverKind}
            displayName={props.providerEntry.displayName}
            accentColor={props.providerEntry.accentColor}
            showBadge={shouldShowInstanceBadge(props.providerEntry, props.providerEntries)}
            className="size-3.5"
            iconClassName="size-3.5"
          />
        ) : null}
      </div>
    </li>
  );
});

export const WorkspaceDraftRow = memo(function WorkspaceDraftRow(props: {
  readonly draftId: DraftId;
  readonly session: DraftSessionState;
  readonly title: string;
  readonly dragId: string;
  readonly dragState: WorkspaceDragState;
  readonly canDrag: boolean;
  readonly isActive: boolean;
  readonly onActivate: (draftId: DraftId) => void;
  readonly onDiscard: (draftId: DraftId) => void;
}) {
  const sortable = useSortable({
    id: props.dragId,
    disabled: !props.canDrag,
    animateLayoutChanges: animatePinnedLayoutChanges,
  });
  const handleActivate = useCallback(
    (event: ReactMouseEvent) => {
      if (consumeWorkspaceClickGuard(props.dragState)) {
        event.preventDefault();
        return;
      }
      if (sortable.isDragging || sortable.isSorting) return;
      props.onActivate(props.draftId);
    },
    [props, sortable.isDragging, sortable.isSorting],
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if ((event.target as HTMLElement).closest("button")) return;
      prepareWorkspaceKeyboardGesture(props.dragState);
      const sortableKeyDown = sortable.listeners?.onKeyDown;
      if (typeof sortableKeyDown === "function") {
        sortableKeyDown(event);
      }
      if (consumeWorkspaceKeyboardGuard(props.dragState)) {
        event.preventDefault();
        return;
      }
      if (event.defaultPrevented || sortable.isSorting || sortable.isDragging) return;
      if (event.key === "Enter") {
        event.preventDefault();
        props.onActivate(props.draftId);
      }
    },
    [props, sortable.isDragging, sortable.isSorting, sortable.listeners],
  );

  return (
    <li
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className="list-none"
      data-thread-item
    >
      <div
        role="button"
        tabIndex={0}
        {...(props.canDrag ? sortable.attributes : {})}
        {...(props.canDrag
          ? Object.fromEntries(
              Object.entries(sortable.listeners ?? {}).filter(([key]) => key !== "onKeyDown"),
            )
          : {})}
        data-testid="workspace-draft-row"
        className={cn(
          ROW_CLASS,
          props.canDrag && "cursor-grab active:cursor-grabbing",
          props.isActive
            ? "bg-sidebar-row-active font-medium text-sidebar-foreground"
            : "text-sidebar-muted-foreground/90 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
        onPointerDownCapture={() => clearWorkspacePointerGuard(props.dragState)}
        onClick={handleActivate}
        onKeyDown={handleKeyDown}
      >
        <SquarePenIcon className="size-3 shrink-0 text-muted-foreground" />
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 flex-1 truncate">{props.title}</span>} />
          <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
            {props.title}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Discard draft"
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover/workspace-row:opacity-100"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (consumeWorkspaceClickGuard(props.dragState)) return;
                  props.onDiscard(props.draftId);
                }}
              />
            }
          >
            <XIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">Discard draft</TooltipPopup>
        </Tooltip>
      </div>
    </li>
  );
});

export function isWorkspaceRowModClick(event: ReactMouseEvent, platform: string): boolean {
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey;
}
