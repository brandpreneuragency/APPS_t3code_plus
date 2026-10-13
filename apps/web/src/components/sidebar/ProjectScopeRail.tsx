import { FolderIcon, FolderPlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import {
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { cn } from "~/lib/utils";
import { filterProjectScopeRailItems } from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { PROJECT_SCOPE_RAIL_WIDTH } from "../threadSidebarWidth";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const ALL_PROJECTS_VALUE = "all";

export function ProjectScopeRail({
  projects,
  selectedProjectKey,
  onSelectProjectKey,
  onOpenProjectSettings,
  onAddProject,
}: {
  projects: readonly SidebarProjectSnapshot[];
  selectedProjectKey: string | null;
  onSelectProjectKey: (projectKey: string | null) => void;
  onOpenProjectSettings: (
    event: ReactMouseEvent<HTMLButtonElement>,
    project: SidebarProjectSnapshot,
  ) => void;
  onAddProject: () => void;
}) {
  const [query, setQuery] = useState("");
  const items = useMemo(
    () => [
      { value: ALL_PROJECTS_VALUE, label: "All projects", project: null },
      ...projects.map((project) => ({
        value: project.projectKey,
        label: project.displayName,
        project,
      })),
    ],
    [projects],
  );
  const visibleItems = useMemo(
    () => (projects.length === 0 ? [] : filterProjectScopeRailItems(items, query)),
    [items, projects.length, query],
  );
  const selectedValue = selectedProjectKey ?? ALL_PROJECTS_VALUE;

  const moveOptionFocus = (current: HTMLElement, direction: 1 | -1) => {
    const options = current
      .closest("[data-project-scope-rail]")
      ?.querySelectorAll<HTMLButtonElement>("[data-project-scope-option]");
    if (!options || options.length === 0) return;
    const index = Array.prototype.indexOf.call(options, current);
    if (index < 0) return;
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= options.length) return;
    options[nextIndex]?.focus();
  };

  const handleOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    moveOptionFocus(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
  };

  return (
    <div
      data-project-scope-rail=""
      className="flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar"
      style={{ width: PROJECT_SCOPE_RAIL_WIDTH }}
    >
      <div className="flex shrink-0 items-center gap-1 p-[var(--sidebar-content-inset)] pb-1">
        <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-sm text-sidebar-muted-foreground">
          <SearchIcon aria-hidden className="size-3.5 shrink-0 text-sidebar-muted-foreground/80" />
          <Input
            nativeInput
            unstyled
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search"
            aria-label="Search projects"
            className="min-w-0 flex-1 [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:text-sidebar-foreground [&_[data-slot=input]]:placeholder:text-sidebar-muted-foreground"
          />
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                className="size-8 shrink-0 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                aria-label="New project"
                onClick={onAddProject}
              />
            }
          >
            <FolderPlusIcon className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="right">New project</TooltipPopup>
        </Tooltip>
      </div>
      <ScrollArea hideScrollbars scrollFade className="min-h-0 flex-1">
        {projects.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground/60">No projects yet</p>
        ) : visibleItems.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground/60">No matching projects.</p>
        ) : (
          <div role="listbox" aria-label="Filter threads by project" className="flex flex-col gap-px px-1.5 pb-2">
            {visibleItems.map((item) => {
              const selected = item.value === selectedValue;
              const project = item.project;
              return (
                <div key={item.value} className="group/project-scope flex items-center">
                  <button
                    type="button"
                    role="option"
                    data-project-scope-option=""
                    aria-selected={selected}
                    onClick={() =>
                      onSelectProjectKey(item.value === ALL_PROJECTS_VALUE ? null : item.value)
                    }
                    onKeyDown={handleOptionKeyDown}
                    className={cn(
                      "flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[var(--control-radius)] px-1.5 text-left text-sm font-medium outline-hidden ring-ring focus-visible:ring-2",
                      selected
                        ? "bg-sidebar-row-selected text-sidebar-foreground"
                        : "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                    )}
                  >
                    {project ? (
                      <ProjectFavicon
                        environmentId={project.environmentId}
                        cwd={project.workspaceRoot}
                        faviconPath={project.faviconPath}
                        className="size-4 shrink-0"
                      />
                    ) : (
                      <FolderIcon className="size-4 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  </button>
                  {project ? (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Project settings for ${project.displayName}`}
                      title={`Project settings for ${project.displayName}`}
                      className="mr-0.5 size-6 shrink-0 text-icon-muted opacity-80 hover:opacity-100"
                      onClick={(event) => onOpenProjectSettings(event, project)}
                    >
                      <SettingsIcon className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
