import { useCallback, useMemo } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { openCommandPalette } from "../commandPaletteBus";
import { sidebarWorkspacesEnabled } from "../env";
import { resolveThreadActionProjectRef, startNewThreadFromContext } from "../lib/chatThreadActions";
import { selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { useSidebarWorkspaceStore } from "../sidebarWorkspaceStore";
import { useProjects } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useHandleNewThread } from "./useHandleNewThread";
import { useClientSettings, useLegacySidebarEnabled } from "./useSettings";
import {
  isCustomWorkspaceSelection,
  presentProjectKeySet,
  resolveWorkspaceNewThreadDecision,
} from "./useWorkspaceCreation.logic";

export type { WorkspaceNewThreadDecision } from "./useWorkspaceCreation.logic";
export {
  captureWorkspacePaletteScope,
  resolveWorkspaceNewThreadDecision,
} from "./useWorkspaceCreation.logic";

export function useWorkspaceCreation() {
  const selectedWorkspaceId = useSidebarWorkspaceStore((store) => store.selectedWorkspaceId);
  const workspaces = useSidebarWorkspaceStore((store) => store.workspaces);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const projectGroupCount = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }).length,
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );

  const isCustomWorkspace = isCustomWorkspaceSelection({
    workspacesEnabled: sidebarWorkspacesEnabled,
    selectedWorkspaceId,
    workspaces,
  });
  const workspaceId = isCustomWorkspace ? selectedWorkspaceId : null;

  const handleWorkspaceNewThread = useCallback(
    async (local = false): Promise<void> => {
      const store = useSidebarWorkspaceStore.getState();
      const custom = isCustomWorkspaceSelection({
        workspacesEnabled: sidebarWorkspacesEnabled,
        selectedWorkspaceId: store.selectedWorkspaceId,
        workspaces: store.workspaces,
      });

      if (!custom) {
        if (!local && !legacySidebarEnabled && projectGroupCount > 1) {
          openCommandPalette({ open: "new-thread-in" });
          return;
        }
        await startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      const initiatingWorkspaceId = store.selectedWorkspaceId;
      const workspace = store.workspaces.find((item) => item.id === initiatingWorkspaceId);
      if (!initiatingWorkspaceId || !workspace) {
        await startNewThreadFromContext({
          activeDraftThread,
          activeThread: activeThread ?? undefined,
          defaultProjectRef,
          handleNewThread,
        });
        return;
      }

      const connectedEnvironmentIds = new Set(
        environments
          .filter((environment) => environment.connection.phase === "connected")
          .map((environment) => environment.environmentId),
      );
      const currentProjectRef = resolveThreadActionProjectRef({
        activeDraftThread,
        activeThread: activeThread ?? undefined,
        defaultProjectRef,
        handleNewThread,
      });
      const decision = resolveWorkspaceNewThreadDecision({
        attachedProjects: workspace.projects,
        connectedEnvironmentIds,
        presentProjectKeys: presentProjectKeySet(projects),
        currentProjectRef,
        local,
      });

      switch (decision.kind) {
        case "create":
          await handleNewThread(decision.projectRef);
          return;
        case "pick":
          openCommandPalette({
            open: "new-thread-in",
            workspaceId: initiatingWorkspaceId,
          });
          return;
        case "add-project":
          openCommandPalette({
            open: "add-project",
            workspaceId: initiatingWorkspaceId,
          });
          return;
        case "disconnected":
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "No connected projects in this workspace",
              description: "Reconnect an environment or add a project.",
            }),
          );
          return;
      }
    },
    [
      activeDraftThread,
      activeThread,
      defaultProjectRef,
      environments,
      handleNewThread,
      legacySidebarEnabled,
      projectGroupCount,
      projects,
    ],
  );

  return {
    isCustomWorkspace,
    workspaceId,
    handleWorkspaceNewThread,
  };
}
