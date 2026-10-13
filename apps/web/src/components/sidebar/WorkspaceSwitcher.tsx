import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { ChevronLeftIcon, ChevronRightIcon, HomeIcon, PlusIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { Alert, AlertDescription } from "../ui/alert";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceDialog, type WorkspaceDialogMode } from "./WorkspaceDialog";
import {
  formatWorkspaceStorageError,
  reorderCustomWorkspaceIds,
  WORKSPACE_DND_DISTANCE_THRESHOLD,
  WORKSPACE_SWITCHER_DEFAULT_ID,
} from "./workspaceUi";
import {
  clearWorkspacePointerGuard,
  consumeWorkspaceClickGuard,
  createWorkspaceDragState,
  markWorkspaceDragCancel,
  markWorkspaceDragEnd,
  markWorkspaceDragStart,
  prepareWorkspaceKeyboardGesture,
  type WorkspaceDragState,
} from "./workspaceDrag";
import { useSidebarWorkspaceStore } from "../../sidebarWorkspaceStore";

const DOT_BUTTON_CLASS =
  "inline-flex size-5 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar";

function WorkspaceDot(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onContextMenu?: (event: ReactMouseEvent) => void;
  readonly draggable?: boolean;
  readonly id: string;
  readonly dragState: WorkspaceDragState;
}) {
  const sortable = useSortable({
    id: props.id,
    disabled: !props.draggable,
  });
  const style = props.draggable
    ? {
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
      }
    : undefined;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            ref={props.draggable ? sortable.setNodeRef : undefined}
            style={style}
            {...(props.draggable ? sortable.attributes : {})}
            {...(props.draggable ? sortable.listeners : {})}
            aria-label={props.label}
            aria-current={props.selected ? "true" : undefined}
            className={cn(
              DOT_BUTTON_CLASS,
              props.draggable && "cursor-grab active:cursor-grabbing",
            )}
            onPointerDownCapture={() => clearWorkspacePointerGuard(props.dragState)}
            onKeyDownCapture={() => prepareWorkspaceKeyboardGesture(props.dragState)}
            onClick={(event) => {
              if (consumeWorkspaceClickGuard(props.dragState)) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              props.onSelect();
            }}
            onContextMenu={(event) => {
              if (consumeWorkspaceClickGuard(props.dragState)) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              props.onContextMenu?.(event);
            }}
          />
        }
      >
        <span
          aria-hidden
          className={cn(
            "size-2 rounded-full",
            props.selected
              ? "bg-[var(--contrast-icon-muted)]"
              : "bg-sidebar-muted-foreground/35 hover:bg-sidebar-muted-foreground/60",
          )}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export const WorkspaceSwitcher = memo(function WorkspaceSwitcher() {
  const selectedWorkspaceId = useSidebarWorkspaceStore((state) => state.selectedWorkspaceId);
  const workspaces = useSidebarWorkspaceStore((state) => state.workspaces);
  const selectWorkspace = useSidebarWorkspaceStore((state) => state.selectWorkspace);
  const deleteWorkspace = useSidebarWorkspaceStore((state) => state.deleteWorkspace);
  const reorderWorkspaces = useSidebarWorkspaceStore((state) => state.reorderWorkspaces);
  const storageError = useSidebarWorkspaceStore((state) => state.storageError);
  const [dialog, setDialog] = useState<WorkspaceDialogMode | null>(null);
  const dragStateRef = useRef<WorkspaceDragState>(createWorkspaceDragState());
  const stripRef = useRef<HTMLDivElement>(null);
  const storageMessage = formatWorkspaceStorageError(storageError);

  const customIds = useMemo(() => workspaces.map((workspace) => workspace.id), [workspaces]);
  const selectedIndex = workspaces.findIndex((workspace) => workspace.id === selectedWorkspaceId);
  const previousWorkspaceId = workspaces[selectedIndex - 1]?.id ?? null;
  const nextWorkspaceId = workspaces[selectedIndex + 1]?.id;
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: WORKSPACE_DND_DISTANCE_THRESHOLD },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragStart = useCallback(() => {
    markWorkspaceDragStart(dragStateRef.current);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      markWorkspaceDragEnd(dragStateRef.current);
      const overId = event.over?.id;
      if (typeof event.active.id === "string" && typeof overId === "string") {
        const next = reorderCustomWorkspaceIds({
          customIds,
          activeId: event.active.id,
          overId,
        });
        if (next) reorderWorkspaces(next);
      }
    },
    [customIds, reorderWorkspaces],
  );

  const selectWorkspaceSafely = useCallback(
    (id: string | null) => {
      if (consumeWorkspaceClickGuard(dragStateRef.current)) return;
      selectWorkspace(id);
    },
    [selectWorkspace],
  );

  useEffect(() => {
    const selected = stripRef.current?.querySelector<HTMLElement>("[aria-current='true']");
    selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedWorkspaceId, customIds]);

  const handleCustomContextMenu = useCallback(
    (event: ReactMouseEvent, workspaceId: string, workspaceName: string) => {
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            [
              { id: "rename", label: "Rename" },
              { id: "delete", label: "Delete", destructive: true },
            ],
            { x: event.clientX, y: event.clientY },
          ),
        );
        if (clicked._tag === "Failure" || clicked.value == null) return;
        const workspaceStillExists = () =>
          useSidebarWorkspaceStore
            .getState()
            .workspaces.some((workspace) => workspace.id === workspaceId);
        if (!workspaceStillExists()) return;
        if (clicked.value === "rename") {
          setDialog({ type: "rename", workspaceId, name: workspaceName });
          return;
        }
        if (clicked.value !== "delete") return;
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(`Delete workspace “${workspaceName}”? Projects stay in Default.`, {
            variant: "destructive",
          }),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
        if (!workspaceStillExists()) return;
        deleteWorkspace(workspaceId);
      })();
    },
    [deleteWorkspace],
  );

  return (
    <div className="mb-2 min-w-0" data-testid="workspace-switcher">
      {storageMessage ? (
        <Alert variant="warning" className="mb-2 py-1.5">
          <AlertDescription className="text-xs">{storageMessage}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex h-7 min-w-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="New workspace"
                className={cn(
                  DOT_BUTTON_CLASS,
                  "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                )}
                onPointerDownCapture={() => clearWorkspacePointerGuard(dragStateRef.current)}
                onKeyDownCapture={() => prepareWorkspaceKeyboardGesture(dragStateRef.current)}
                onClick={(event) => {
                  if (consumeWorkspaceClickGuard(dragStateRef.current)) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                  }
                  setDialog({ type: "create" });
                }}
              />
            }
          >
            <PlusIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">New workspace</TooltipPopup>
        </Tooltip>
        <div
          ref={stripRef}
          className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div className="mx-auto flex w-max min-w-full items-center justify-center gap-0.5 px-1">
            <WorkspaceDot
              id={WORKSPACE_SWITCHER_DEFAULT_ID}
              label="Default"
              selected={selectedWorkspaceId === null}
              dragState={dragStateRef.current}
              onSelect={() => selectWorkspaceSafely(null)}
            />
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={() => markWorkspaceDragCancel(dragStateRef.current)}
            >
              <SortableContext items={customIds} strategy={horizontalListSortingStrategy}>
                {workspaces.map((workspace) => (
                  <WorkspaceDot
                    key={workspace.id}
                    id={workspace.id}
                    label={workspace.name}
                    selected={selectedWorkspaceId === workspace.id}
                    draggable
                    dragState={dragStateRef.current}
                    onSelect={() => selectWorkspaceSafely(workspace.id)}
                    onContextMenu={(event) =>
                      handleCustomContextMenu(event, workspace.id, workspace.name)
                    }
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {[
            {
              label: "Home workspace",
              Icon: HomeIcon,
              target: null,
              disabled: selectedWorkspaceId === null,
            },
            {
              label: "Previous workspace",
              Icon: ChevronLeftIcon,
              target: previousWorkspaceId,
              disabled: selectedIndex < 0,
            },
            {
              label: "Next workspace",
              Icon: ChevronRightIcon,
              target: nextWorkspaceId,
              disabled: nextWorkspaceId === undefined,
            },
          ].map(({ label, Icon, target, disabled }) => (
            <Tooltip key={label}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={label}
                    disabled={disabled}
                    className={cn(
                      DOT_BUTTON_CLASS,
                      "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-35",
                    )}
                    onPointerDownCapture={() => clearWorkspacePointerGuard(dragStateRef.current)}
                    onKeyDownCapture={() => prepareWorkspaceKeyboardGesture(dragStateRef.current)}
                    onClick={() => selectWorkspaceSafely(target ?? null)}
                  />
                }
              >
                <Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">{label}</TooltipPopup>
            </Tooltip>
          ))}
        </div>
      </div>
      <WorkspaceDialog mode={dialog} onClose={() => setDialog(null)} />
    </div>
  );
});
