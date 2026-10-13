import type { PromptLibrary, SavedPrompt } from "@t3tools/contracts";

export function orderedPrompts(library: PromptLibrary) {
  return Object.entries(library)
    .flatMap(([id, prompt]) => (prompt ? [{ ...prompt, id }] : []))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

export function filterPrompts(
  library: PromptLibrary,
  query: string,
  tag: string | null,
  favoritesOnly: boolean,
) {
  const search = query.trim().toLocaleLowerCase();
  return orderedPrompts(library).filter(
    (prompt) =>
      (!favoritesOnly || prompt.favorite) &&
      (!tag || prompt.tags.includes(tag)) &&
      (!search || `${prompt.title}\n${prompt.text}`.toLocaleLowerCase().includes(search)),
  );
}

export function parsePromptTags(value: string, existing: readonly string[]) {
  const tags = new Map<string, string>();
  for (const raw of value.split(",")) {
    const name = raw.trim();
    const key = name.toLocaleLowerCase();
    if (name) {
      tags.set(key, existing.find((tag) => tag.toLocaleLowerCase() === key) ?? name);
    }
  }
  return [...tags.values()];
}

export function promptTagStyles(tags: readonly string[]) {
  const hues = new Set<number>();
  return new Map(
    [...tags].sort().map((tag) => {
      let hash = 0;
      for (const character of tag) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
      let hue = hash % 360;
      while (hues.has(hue)) hue += 0.5;
      hues.add(hue);
      return [
        tag,
        {
          border: `2px solid hsl(${hue} 70% 55%)`,
          backgroundColor: `hsl(${hue} 70% 55% / 0.30)`,
        },
      ] as const;
    }),
  );
}

export function movePrompt(
  library: PromptLibrary,
  visibleIds: readonly string[],
  id: string,
  direction: -1 | 1,
): PromptLibrary {
  const index = visibleIds.indexOf(id);
  const neighborId = visibleIds[index + direction];
  if (index < 0 || !neighborId) return {};
  const prompts = orderedPrompts(library);
  const currentIndex = prompts.findIndex((prompt) => prompt.id === id);
  const neighborIndex = prompts.findIndex((prompt) => prompt.id === neighborId);
  if (currentIndex < 0 || neighborIndex < 0) return {};
  [prompts[currentIndex], prompts[neighborIndex]] = [
    prompts[neighborIndex]!,
    prompts[currentIndex]!,
  ];
  return Object.fromEntries(
    prompts.flatMap((prompt, order) => {
      if (prompt.order === order) return [];
      const { id: promptId, ...entry } = prompt;
      return [[promptId, { ...entry, order } satisfies SavedPrompt]];
    }),
  );
}
