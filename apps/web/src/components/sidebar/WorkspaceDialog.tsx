import {
  parseScopedProjectKey,
  scopedProjectKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  collectProjectAttachActions,
  confirmProjectAttachMove,
  nextProjectAttachChoice,
  type ProjectAttachChoice,
} from "./workspaceUi";
import { useSidebarWorkspaceStore, type SidebarWorkspace } from "../../sidebarWorkspaceStore";

export type WorkspaceDialogMode =
  | { readonly type: "create" }
  | { readonly type: "rename"; readonly workspaceId: string; readonly name: string }
  | { readonly type: "attach"; readonly workspaceId: string };

type ProjectChoiceMap = Record<string, ProjectAttachChoice>;

function ownerByProjectKey(
  workspaces: readonly SidebarWorkspace[],
): Map<string, { ownerId: string; ownerName: string }> {
  const owners = new Map<string, { ownerId: string; ownerName: string }>();
  for (const workspace of workspaces) {
    for (const project of workspace.projects) {
      const key = scopedProjectKey(project);
      if (!owners.has(key)) {
        owners.set(key, { ownerId: workspace.id, ownerName: workspace.name });
      }
    }
  }
  return owners;
}

function applyMembership(input: {
  workspaceId: string;
  choices: ProjectChoiceMap;
  lastKnownByKey: ReadonlyMap<
    string,
    { title: string; workspaceRoot: string; environmentLabel: string | null }
  >;
}): { failedKeys: string[]; missingWorkspace: boolean } {
  const store = useSidebarWorkspaceStore.getState();
  const { attachKeys, moveKeys } = collectProjectAttachActions(input.choices);
  const failedKeys: string[] = [];
  let missingWorkspace = false;
  for (const key of attachKeys) {
    const ref = parseScopedProjectKey(key);
    if (!ref) continue;
    const result = store.attachProject(input.workspaceId, ref, input.lastKnownByKey.get(key));
    if (result.status === "missing-workspace") missingWorkspace = true;
    else if (result.status === "conflict") failedKeys.push(key);
  }
  for (const { key, ownerId } of moveKeys) {
    const ref = parseScopedProjectKey(key);
    if (!ref) continue;
    if (!store.moveProject(ref, ownerId, input.workspaceId)) {
      failedKeys.push(key);
    }
  }
  return { failedKeys, missingWorkspace };
}

function notifyWorkspaceUnavailable(description = "The project stays in Default."): void {
  toastManager.add(
    stackedThreadToast({
      type: "warning",
      title: "Workspace unavailable",
      description,
    }),
  );
}

export function WorkspaceDialog(props: {
  readonly mode: WorkspaceDialogMode | null;
  readonly onClose: () => void;
}) {
  const { mode, onClose } = props;
  const workspaces = useSidebarWorkspaceStore((state) => state.workspaces);
  const createWorkspace = useSidebarWorkspaceStore((state) => state.createWorkspace);
  const renameWorkspace = useSidebarWorkspaceStore((state) => state.renameWorkspace);
  const selectWorkspace = useSidebarWorkspaceStore((state) => state.selectWorkspace);
  const projects = useProjects();
  const { environments } = useEnvironments();
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [choices, setChoices] = useState<ProjectChoiceMap>({});
  const createdWorkspaceIdRef = useRef<string | null>(null);

  const environmentLabelById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const owners = useMemo(() => ownerByProjectKey(workspaces), [workspaces]);
  const targetWorkspaceId =
    mode?.type === "rename" || mode?.type === "attach" ? mode.workspaceId : null;
  const targetWorkspaceExists =
    targetWorkspaceId === null ||
    workspaces.some((workspace) => workspace.id === targetWorkspaceId);
  const lastKnownByKey = useMemo(() => {
    const next = new Map<
      string,
      { title: string; workspaceRoot: string; environmentLabel: string | null }
    >();
    for (const project of projects) {
      next.set(scopedProjectKey(scopeProjectRef(project.environmentId, project.id)), {
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        environmentLabel: environmentLabelById.get(project.environmentId) ?? null,
      });
    }
    return next;
  }, [environmentLabelById, projects]);

  useEffect(() => {
    if (mode == null) {
      setName("");
      setNameError(null);
      setChoices({});
      createdWorkspaceIdRef.current = null;
      return;
    }
    setName(mode.type === "rename" ? mode.name : "");
    setNameError(null);
    setChoices({});
  }, [mode]);

  useEffect(() => {
    if (mode?.type !== "rename" && mode?.type !== "attach") return;
    if (targetWorkspaceExists) return;
    notifyWorkspaceUnavailable("The dialog was closed because the workspace was deleted.");
    onClose();
  }, [mode, onClose, targetWorkspaceExists]);

  const open = mode !== null;
  const showProjectPicker = mode?.type === "create" || mode?.type === "attach";
  const attachActions = collectProjectAttachActions(choices);

  const handleToggleProject = useCallback(
    (key: string, selected: boolean) => {
      const owner = owners.get(key);
      const alreadyHere = owner?.ownerId === targetWorkspaceId;
      setChoices((current) => ({
        ...current,
        [key]: alreadyHere
          ? { kind: "unselected" }
          : nextProjectAttachChoice({
              current: current[key] ?? { kind: "unselected" },
              ownerId: owner?.ownerId ?? null,
              ownerName: owner?.ownerName ?? null,
              selected,
            }),
      }));
    },
    [owners, targetWorkspaceId],
  );

  const handleSubmit = useCallback(() => {
    if (mode == null) return;
    if (!targetWorkspaceExists) {
      notifyWorkspaceUnavailable();
      onClose();
      return;
    }
    if (attachActions.blockedKeys.length > 0) {
      setNameError("Choose Move or Cancel for projects that already belong to another workspace.");
      return;
    }
    if (mode.type === "create") {
      const id = createdWorkspaceIdRef.current ?? createWorkspace(name);
      if (id == null) {
        setNameError("Enter a workspace name.");
        return;
      }
      createdWorkspaceIdRef.current = id;
      const result = applyMembership({ workspaceId: id, choices, lastKnownByKey });
      if (result.missingWorkspace) {
        notifyWorkspaceUnavailable();
        createdWorkspaceIdRef.current = null;
        onClose();
        return;
      }
      if (result.failedKeys.length > 0) {
        setChoices((current) => {
          const next = { ...current };
          for (const key of result.failedKeys) {
            const owner = owners.get(key);
            next[key] = {
              kind: "conflict",
              ownerId: owner?.ownerId ?? "",
              ownerName: owner?.ownerName ?? "another workspace",
            };
          }
          return next;
        });
        setNameError("Some projects could not be moved. Confirm Move again.");
        return;
      }
      selectWorkspace(id);
      createdWorkspaceIdRef.current = null;
      onClose();
      return;
    }
    if (mode.type === "rename") {
      if (!renameWorkspace(mode.workspaceId, name)) {
        setNameError("Enter a workspace name.");
        return;
      }
      onClose();
      return;
    }
    const result = applyMembership({
      workspaceId: mode.workspaceId,
      choices,
      lastKnownByKey,
    });
    if (result.missingWorkspace) {
      notifyWorkspaceUnavailable();
      onClose();
      return;
    }
    if (result.failedKeys.length > 0) {
      setChoices((current) => {
        const next = { ...current };
        for (const key of result.failedKeys) {
          const owner = owners.get(key);
          next[key] = {
            kind: "conflict",
            ownerId: owner?.ownerId ?? "",
            ownerName: owner?.ownerName ?? "another workspace",
          };
        }
        return next;
      });
      setNameError("Some projects could not be moved. Confirm Move again.");
      return;
    }
    onClose();
  }, [
    attachActions.blockedKeys.length,
    choices,
    createWorkspace,
    lastKnownByKey,
    mode,
    name,
    onClose,
    owners,
    renameWorkspace,
    selectWorkspace,
    targetWorkspaceExists,
  ]);

  const handleNewFolder = useCallback(() => {
    if (mode?.type !== "attach") return;
    onClose();
    openCommandPalette({ open: "add-project", workspaceId: mode.workspaceId });
  }, [mode, onClose]);

  const title =
    mode?.type === "rename"
      ? "Rename workspace"
      : mode?.type === "attach"
        ? "Add projects"
        : "New workspace";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {mode?.type === "attach"
              ? "Choose existing projects to attach. New folders use the current environment picker."
              : mode?.type === "rename"
                ? "The name stays on this desktop."
                : "Create an empty workspace, or attach existing projects. A project can belong to one custom workspace."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {mode?.type !== "attach" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="workspace-name">Name</Label>
              <Input
                id="workspace-name"
                aria-label="Workspace name"
                value={name}
                autoFocus
                onChange={(event) => {
                  setName(event.currentTarget.value);
                  setNameError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !showProjectPicker) {
                    event.preventDefault();
                    handleSubmit();
                  }
                }}
              />
            </div>
          ) : null}
          {showProjectPicker ? (
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-foreground">Existing projects</span>
                {mode?.type === "attach" ? (
                  <Button type="button" size="xs" variant="ghost" onClick={handleNewFolder}>
                    New folder
                  </Button>
                ) : null}
              </div>
              {projects.length === 0 ? (
                <p className="text-xs text-muted-foreground">No projects yet.</p>
              ) : (
                <ul className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-border/70 p-1">
                  {projects.map((project) => {
                    const ref = scopeProjectRef(project.environmentId, project.id);
                    const key = scopedProjectKey(ref);
                    const owner = owners.get(key);
                    const alreadyHere = owner?.ownerId === targetWorkspaceId;
                    const choice = choices[key] ?? { kind: "unselected" };
                    const checked = choice.kind === "attach" || choice.kind === "move";
                    const environmentLabel =
                      environmentLabelById.get(project.environmentId) ?? null;
                    return (
                      <li key={key} className="rounded-md px-1.5 py-1">
                        <label className="flex cursor-pointer items-start gap-2">
                          <Checkbox
                            checked={checked || choice.kind === "conflict"}
                            disabled={alreadyHere}
                            onCheckedChange={(value) => handleToggleProject(key, value === true)}
                            className="mt-0.5"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-foreground">
                              {project.title}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {[environmentLabel, project.workspaceRoot]
                                .filter(Boolean)
                                .join(" · ")}
                              {alreadyHere
                                ? " · already in this workspace"
                                : owner
                                  ? ` · in ${owner.ownerName}`
                                  : ""}
                            </span>
                          </span>
                        </label>
                        {choice.kind === "conflict" ? (
                          <div className="mt-1.5 ml-6 flex flex-wrap items-center gap-2 text-xs">
                            <span className="text-muted-foreground">
                              Move from {choice.ownerName}?
                            </span>
                            <Button
                              type="button"
                              size="xs"
                              onClick={() =>
                                setChoices((current) => ({
                                  ...current,
                                  [key]: confirmProjectAttachMove(choice),
                                }))
                              }
                            >
                              Move
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              onClick={() => handleToggleProject(key, false)}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : null}
          {nameError ? <p className="text-xs text-destructive">{nameError}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={attachActions.blockedKeys.length > 0 && showProjectPicker}
          >
            {mode?.type === "rename" ? "Save" : mode?.type === "attach" ? "Add" : "Create"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
