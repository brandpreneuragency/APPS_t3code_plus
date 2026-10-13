export function sidebarCardOrderKey(thread: {
  readonly environmentId: string;
  readonly id: string;
  readonly unsettledAt?: string | null | undefined;
}): string {
  return JSON.stringify([thread.environmentId, thread.id, thread.unsettledAt ?? null]);
}

export function orderSidebarCardKeys(
  currentKeys: readonly string[],
  savedKeys: readonly string[],
): string[] {
  const current = new Set(currentKeys);
  const saved = new Set(savedKeys);
  return [
    ...currentKeys.filter((key) => !saved.has(key)),
    ...[...saved].filter((key) => current.has(key)),
  ];
}

export function reorderSidebarCardKeys(
  savedKeys: readonly string[],
  visibleKeys: readonly string[],
  activeKey: string,
  overKey: string,
): readonly string[] {
  const reordered = orderSidebarCardKeys(visibleKeys, savedKeys);
  const from = reordered.indexOf(activeKey);
  const to = reordered.indexOf(overKey);
  if (from < 0 || to < 0 || from === to) return savedKeys;
  reordered.splice(to, 0, ...reordered.splice(from, 1));

  const visible = new Set(visibleKeys);
  const saved = new Set(savedKeys);
  const combined = [...visibleKeys.filter((key) => !saved.has(key)), ...saved];
  let visibleIndex = 0;
  return combined.map((key) => (visible.has(key) ? reordered[visibleIndex++]! : key));
}
