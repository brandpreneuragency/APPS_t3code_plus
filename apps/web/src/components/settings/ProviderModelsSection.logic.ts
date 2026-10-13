import type { ServerProviderModel } from "@t3tools/contracts";

const CUSTOM_GROUP_KEY = "custom";
const OTHER_GROUP_KEY = "other";

export type ProviderModelGroup<T> = {
  readonly key: string;
  readonly label: string | null;
  readonly models: ReadonlyArray<T>;
};

/**
 * Splits the live catalogue into the active and archived views. Archived slugs
 * that are no longer returned by a provider remain visible so users can
 * restore them after a provider catalogue changes.
 */
export function partitionProviderModels(
  models: ReadonlyArray<ServerProviderModel>,
  archivedModels: ReadonlyArray<string>,
): {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly archivedModels: ReadonlyArray<ServerProviderModel>;
} {
  const archivedSet = new Set(archivedModels);
  const liveBySlug = new Map(models.map((model) => [model.slug, model]));
  const archivedLiveModels = models.filter((model) => archivedSet.has(model.slug));
  const missingArchivedModels = [...archivedSet].flatMap((slug) => {
    if (liveBySlug.has(slug)) return [];
    return [
      { slug, name: slug, isCustom: false, capabilities: null } satisfies ServerProviderModel,
    ];
  });

  return {
    models: models.filter((model) => !archivedSet.has(model.slug)),
    archivedModels: [...archivedLiveModels, ...missingArchivedModels],
  };
}

export function nextArchivedModelsForArchive(
  archivedModels: ReadonlyArray<string>,
  slug: string,
): ReadonlyArray<string> {
  return archivedModels.includes(slug) ? archivedModels : [...archivedModels, slug];
}

export function nextArchivedModelsForRestore(
  archivedModels: ReadonlyArray<string>,
  slug: string,
): ReadonlyArray<string> {
  return archivedModels.filter((model) => model !== slug);
}

function trimmedSubProvider(model: Pick<ServerProviderModel, "subProvider">): string | undefined {
  const subProvider = model.subProvider?.trim();
  return subProvider && subProvider.length > 0 ? subProvider : undefined;
}

function providerModelGroupKey(
  model: Pick<ServerProviderModel, "subProvider" | "isCustom">,
): string {
  const subProvider = trimmedSubProvider(model);
  if (subProvider) {
    return `sub:${subProvider}`;
  }
  return model.isCustom ? CUSTOM_GROUP_KEY : OTHER_GROUP_KEY;
}

function providerModelGroupLabel(
  model: Pick<ServerProviderModel, "subProvider" | "isCustom">,
): string | null {
  const subProvider = trimmedSubProvider(model);
  if (subProvider) {
    return subProvider;
  }
  return model.isCustom ? "Custom" : "Other";
}

function groupSortRank(key: string): number {
  if (key === OTHER_GROUP_KEY) return 1;
  if (key === CUSTOM_GROUP_KEY) return 2;
  return 0;
}

/**
 * Settings Models tab: one unlabeled list when every model is from the
 * same home, otherwise a section per OpenCode/Hermes upstream provider.
 */
export function groupModelsBySubProvider<
  T extends Pick<ServerProviderModel, "subProvider" | "isCustom">,
>(models: ReadonlyArray<T>): ReadonlyArray<ProviderModelGroup<T>> {
  const hasSubProvider = models.some((model) => trimmedSubProvider(model) !== undefined);
  if (!hasSubProvider) {
    return [{ key: OTHER_GROUP_KEY, label: null, models }];
  }

  const groups = new Map<string, { label: string | null; models: T[] }>();
  for (const model of models) {
    const key = providerModelGroupKey(model);
    const existing = groups.get(key);
    if (existing) {
      existing.models.push(model);
      continue;
    }
    groups.set(key, { label: providerModelGroupLabel(model), models: [model] });
  }

  return [...groups.entries()]
    .sort(([leftKey, left], [rightKey, right]) => {
      const rank = groupSortRank(leftKey) - groupSortRank(rightKey);
      if (rank !== 0) {
        return rank;
      }
      return (left.label ?? "").localeCompare(right.label ?? "");
    })
    .map(([key, group]) => ({
      key,
      label: group.label,
      models: group.models,
    }));
}

/**
 * Header-eye toggle for one provider's Models tab: hide every built-in
 * model, or show them all. Custom models stay out of `hiddenModels`.
 */
export function nextHiddenModelsForProviderVisibilityToggle(input: {
  readonly models: ReadonlyArray<Pick<ServerProviderModel, "slug" | "isCustom">>;
  readonly hiddenModels: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const builtInSlugs = input.models.filter((model) => !model.isCustom).map((model) => model.slug);
  if (builtInSlugs.length === 0) {
    return input.hiddenModels;
  }

  const hiddenSet = new Set(input.hiddenModels);
  const allHidden = builtInSlugs.every((slug) => hiddenSet.has(slug));
  if (allHidden) {
    const builtInSet = new Set(builtInSlugs);
    return input.hiddenModels.filter((slug) => !builtInSet.has(slug));
  }

  const next = [...input.hiddenModels];
  for (const slug of builtInSlugs) {
    if (!hiddenSet.has(slug)) {
      next.push(slug);
    }
  }
  return next;
}
