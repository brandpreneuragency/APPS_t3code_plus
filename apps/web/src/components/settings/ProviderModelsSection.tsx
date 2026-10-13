"use client";

import {
  ArchiveIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  PlusIcon,
  RotateCcwIcon,
  StarIcon,
  XIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { useMemo, useRef, useState } from "react";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { normalizeCustomModelSlug } from "@t3tools/shared/model";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { sortModelsForProviderInstance } from "../../modelOrdering";
import { MAX_CUSTOM_MODEL_LENGTH } from "../../modelSelection";
import {
  formatModelNameWithSubProvider,
  getDisplayModelName,
  getModelSubProviderLabel,
} from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  groupModelsBySubProvider,
  nextArchivedModelsForArchive,
  nextArchivedModelsForRestore,
  nextHiddenModelsForProviderVisibilityToggle,
  partitionProviderModels,
} from "./ProviderModelsSection.logic";

const CUSTOM_MODEL_PLACEHOLDER_BY_KIND: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "gpt-6.7-codex-ultra-preview",
  [ProviderDriverKind.make("claudeAgent")]: "claude-sonnet-5",
  [ProviderDriverKind.make("cursor")]: "claude-sonnet-4-6",
  [ProviderDriverKind.make("opencode")]: "openai/gpt-5",
};

const GROUP_EXPANSION_SCHEMA = Schema.Record(Schema.String, Schema.Boolean);
const DEFAULT_GROUP_EXPANSION: typeof GROUP_EXPANSION_SCHEMA.Type = {};
const CUSTOM_GROUP_KEY = "custom";

interface ProviderModelsSectionProps {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind | null;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly customModels: ReadonlyArray<string>;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly favoriteModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
  readonly archivedModels: ReadonlyArray<string>;
  readonly view: "models" | "archived";
  readonly onChange: (next: ReadonlyArray<string>) => void;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
  readonly onArchivedModelsChange: (next: ReadonlyArray<string>) => void;
}

export function ProviderModelsSection({
  instanceId,
  driverKind,
  models,
  customModels,
  hiddenModels,
  favoriteModels,
  modelOrder,
  archivedModels,
  view,
  onChange,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onModelOrderChange,
  onArchivedModelsChange,
}: ProviderModelsSectionProps) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [expandedGroups, setExpandedGroups] = useLocalStorage(
    `provider-model-groups:${instanceId}:${view}`,
    DEFAULT_GROUP_EXPANSION,
    GROUP_EXPANSION_SCHEMA,
  );
  const hiddenModelSet = useMemo(() => new Set(hiddenModels), [hiddenModels]);
  const favoriteModelSet = useMemo(() => new Set(favoriteModels), [favoriteModels]);
  const { models: activeModels, archivedModels: archivedModelsForDisplay } = useMemo(
    () => partitionProviderModels(models, archivedModels),
    [archivedModels, models],
  );
  const displayedModels = view === "models" ? activeModels : archivedModelsForDisplay;
  const builtInModels = useMemo(
    () => activeModels.filter((model) => !model.isCustom),
    [activeModels],
  );
  const allBuiltInHidden =
    builtInModels.length > 0 && builtInModels.every((model) => hiddenModelSet.has(model.slug));
  const modelGroups = useMemo(
    () =>
      groupModelsBySubProvider(displayedModels).map((group) => ({
        ...group,
        models: sortModelsForProviderInstance(group.models, {
          favoriteModels: favoriteModelSet,
          groupFavorites: true,
          modelOrder,
        }),
      })),
    [displayedModels, favoriteModelSet, modelOrder],
  );

  const handleAdd = () => {
    const normalized = normalizeCustomModelSlug(input);
    if (!normalized) {
      setError("Enter a model slug.");
      return;
    }
    if (archivedModels.includes(normalized)) {
      setError("That model is archived. Restore it from Archived.");
      return;
    }
    if (models.some((model) => !model.isCustom && model.slug === normalized)) {
      setError("That model is already built in.");
      return;
    }
    if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
      setError(`Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`);
      return;
    }
    if (customModels.includes(normalized)) {
      setError("That custom model is already saved.");
      return;
    }

    onChange([...customModels, normalized]);
    setExpandedGroups((current) => ({ ...current, [CUSTOM_GROUP_KEY]: true }));
    setInput("");
    setError(null);

    const el = listRef.current;
    if (!el) return;
    const scrollToEnd = () => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    requestAnimationFrame(scrollToEnd);
    const observer = new MutationObserver(() => {
      scrollToEnd();
      observer.disconnect();
    });
    observer.observe(el, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 2_000);
  };

  const handleRemove = (slug: string) => {
    onChange(customModels.filter((model) => model !== slug));
    onModelOrderChange(modelOrder.filter((model) => model !== slug));
    onFavoriteModelsChange(favoriteModels.filter((model) => model !== slug));
    setError(null);
  };

  const handleToggleHidden = (slug: string) => {
    onHiddenModelsChange(
      hiddenModelSet.has(slug)
        ? hiddenModels.filter((model) => model !== slug)
        : [...hiddenModels, slug],
    );
  };

  const handleToggleFavorite = (slug: string) => {
    onFavoriteModelsChange(
      favoriteModelSet.has(slug)
        ? favoriteModels.filter((model) => model !== slug)
        : [...favoriteModels, slug],
    );
  };

  const title = view === "models" ? "Models" : "Archived";
  const emptyMessage = view === "models" ? "No models available." : "No archived models.";

  return (
    <div className="lg:flex lg:h-full lg:min-h-0 lg:flex-col">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
        <div>
          <div className="text-xs font-medium text-foreground">{title}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {displayedModels.length} model{displayedModels.length === 1 ? "" : "s"}{" "}
            {view === "archived" ? "archived" : "available"}.
          </div>
        </div>
        {view === "models" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  disabled={builtInModels.length === 0}
                  onClick={() =>
                    onHiddenModelsChange(
                      nextHiddenModelsForProviderVisibilityToggle({
                        models: activeModels,
                        hiddenModels,
                      }),
                    )
                  }
                  aria-label={
                    allBuiltInHidden ? "Show all models in picker" : "Hide all models from picker"
                  }
                />
              }
            >
              {allBuiltInHidden ? (
                <EyeIcon className="size-3" />
              ) : (
                <EyeOffIcon className="size-3" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {allBuiltInHidden ? "Show all in picker" : "Hide all from picker"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <div
        ref={listRef}
        className="mt-2 max-h-40 overflow-y-auto pb-1 lg:min-h-0 lg:max-h-none lg:flex-1"
      >
        {displayedModels.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">{emptyMessage}</p>
        ) : (
          modelGroups.map((group) => {
            const isNamedGroup = group.label !== null;
            const isExpanded = expandedGroups[group.key] === true;
            const groupId = `provider-instance-${instanceId}-${view}-${encodeURIComponent(group.key)}`;
            return (
              <div key={group.key}>
                {isNamedGroup ? (
                  <div className="sticky top-0 z-[1] flex items-center bg-card py-1.5 text-xs font-medium text-muted-foreground">
                    <Button
                      size="icon-micro"
                      variant="ghost"
                      className="mr-1"
                      onClick={() =>
                        setExpandedGroups((current) => ({
                          ...current,
                          [group.key]: current[group.key] !== true,
                        }))
                      }
                      aria-label={`${isExpanded ? "Collapse" : "Expand"} ${group.label} models`}
                      aria-expanded={isExpanded}
                      aria-controls={groupId}
                    >
                      {isExpanded ? (
                        <ChevronDownIcon className="size-3" />
                      ) : (
                        <ChevronRightIcon className="size-3" />
                      )}
                    </Button>
                    <span>{group.label}</span>
                    <span className="ml-1 text-[10px] font-normal">({group.models.length})</span>
                  </div>
                ) : null}
                <div id={isNamedGroup ? groupId : undefined} hidden={isNamedGroup && !isExpanded}>
                  {(!isNamedGroup || isExpanded) &&
                    group.models.map((model) => (
                      <ModelRow
                        key={`${instanceId}:${model.slug}`}
                        model={model}
                        view={view}
                        isHidden={!model.isCustom && hiddenModelSet.has(model.slug)}
                        isFavorite={favoriteModelSet.has(model.slug)}
                        onToggleFavorite={handleToggleFavorite}
                        onToggleHidden={handleToggleHidden}
                        onArchive={(slug) =>
                          onArchivedModelsChange(nextArchivedModelsForArchive(archivedModels, slug))
                        }
                        onRestore={(slug) =>
                          onArchivedModelsChange(nextArchivedModelsForRestore(archivedModels, slug))
                        }
                        onRemove={handleRemove}
                      />
                    ))}
                </div>
              </div>
            );
          })
        )}
      </div>
      {view === "models" ? (
        <>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              id={`provider-instance-${instanceId}-custom-model`}
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleAdd();
                }
              }}
              placeholder={driverKind ? CUSTOM_MODEL_PLACEHOLDER_BY_KIND[driverKind] : "model-slug"}
              spellCheck={false}
            />
            <Button className="shrink-0" variant="outline" onClick={handleAdd}>
              <PlusIcon className="size-3.5" />
              Add
            </Button>
          </div>
          {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
        </>
      ) : null}
    </div>
  );
}

function ModelRow({
  model,
  view,
  isHidden,
  isFavorite,
  onToggleFavorite,
  onToggleHidden,
  onArchive,
  onRestore,
  onRemove,
}: {
  readonly model: ServerProviderModel;
  readonly view: "models" | "archived";
  readonly isHidden: boolean;
  readonly isFavorite: boolean;
  readonly onToggleFavorite: (slug: string) => void;
  readonly onToggleHidden: (slug: string) => void;
  readonly onArchive: (slug: string) => void;
  readonly onRestore: (slug: string) => void;
  readonly onRemove: (slug: string) => void;
}) {
  const capLabels: string[] = [];
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  if (descriptors.some((descriptor) => descriptor.id === "fastMode")) capLabels.push("Fast mode");
  if (descriptors.some((descriptor) => descriptor.id === "thinking")) capLabels.push("Thinking");
  if (
    descriptors.some(
      (descriptor) =>
        descriptor.type === "select" &&
        ["reasoningEffort", "effort", "reasoning", "variant"].includes(descriptor.id),
    )
  ) {
    capLabels.push("Reasoning");
  }
  const displayName = getDisplayModelName(model);
  const subProviderLabel = getModelSubProviderLabel(model);
  const accessibleName = formatModelNameWithSubProvider({
    name: displayName,
    subProvider: model.subProvider,
  });
  const hasDetails = capLabels.length > 0 || model.name !== model.slug;

  return (
    <div
      className={cn(
        "grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-1",
        isHidden && "text-muted-foreground",
      )}
    >
      <div className="flex min-w-0 items-center gap-1">
        <span
          className={cn(
            "min-w-0 truncate text-xs",
            isHidden ? "text-muted-foreground line-through" : "text-foreground/90",
          )}
        >
          {subProviderLabel ? (
            <span className={cn(!isHidden && "text-muted-foreground")}>{subProviderLabel} / </span>
          ) : null}
          {displayName}
        </span>
        {hasDetails ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost"
                  className="text-muted-foreground/60 hover:text-muted-foreground"
                  aria-label={`Details for ${accessibleName}`}
                />
              }
            >
              <InfoIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top" className="max-w-56">
              <div className="space-y-1">
                <code className="block text-[11px] text-foreground">{model.slug}</code>
                {capLabels.length > 0 ? (
                  <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                    {capLabels.map((label) => (
                      <span key={label} className="text-[10px] text-muted-foreground">
                        {label}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {isHidden ? <span className="text-[10px] text-muted-foreground">hidden</span> : null}
        {model.isCustom ? <span className="text-[10px] text-muted-foreground">custom</span> : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {view === "models" ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    className={cn(isFavorite && "text-yellow-500 hover:text-yellow-600")}
                    onClick={() => onToggleFavorite(model.slug)}
                    aria-label={`${isFavorite ? "Remove" : "Add"} ${accessibleName} ${isFavorite ? "from" : "to"} favorites`}
                  />
                }
              >
                <StarIcon className={cn("size-3", isFavorite && "fill-current")} />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {isFavorite ? "Remove from favorites" : "Add to favorites"}
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    onClick={() => onArchive(model.slug)}
                    aria-label={`Archive ${accessibleName}`}
                  />
                }
              >
                <ArchiveIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">Archive</TooltipPopup>
            </Tooltip>
            {!model.isCustom ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-micro"
                      variant="ghost-muted"
                      onClick={() => onToggleHidden(model.slug)}
                      aria-label={`${isHidden ? "Show" : "Hide"} ${accessibleName}`}
                    />
                  }
                >
                  {isHidden ? <EyeIcon className="size-3" /> : <EyeOffIcon className="size-3" />}
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {isHidden ? "Show in picker" : "Hide from picker"}
                </TooltipPopup>
              </Tooltip>
            ) : null}
            {model.isCustom ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-micro"
                      variant="ghost-muted"
                      aria-label={`Remove ${model.slug}`}
                      onClick={() => onRemove(model.slug)}
                    />
                  }
                >
                  <XIcon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">Remove custom model</TooltipPopup>
              </Tooltip>
            ) : null}
          </>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  onClick={() => onRestore(model.slug)}
                  aria-label={`Restore ${accessibleName}`}
                />
              }
            >
              <RotateCcwIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">Restore</TooltipPopup>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
