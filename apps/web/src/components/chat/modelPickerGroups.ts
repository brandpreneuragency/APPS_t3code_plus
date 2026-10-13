import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { normalizeCustomModelSlug } from "@t3tools/shared/model";

const VENDOR_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  "command-code": "Command Code",
  commandcode: "Command Code",
  deepseek: "DeepSeek",
  google: "Google",
  meta: "Meta",
  mistralai: "Mistral",
  moonshotai: "Moonshot",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  qwen: "Qwen",
  xai: "xAI",
  "x-ai": "xAI",
  "z-ai": "Z.AI",
};

export type ModelPickerGroupable = {
  readonly slug: string;
  readonly subProvider?: string | undefined;
  readonly instanceId: ProviderInstanceId;
  readonly instanceDisplayName: string;
  readonly driverKind: ProviderDriverKind;
};

export type ModelPickerGroupSection<T extends ModelPickerGroupable> = {
  readonly id: string;
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly title: string;
  readonly slugPrefix: string | null;
  readonly items: T[];
};

function titleCaseVendor(value: string): string {
  return value
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function modelPickerVendorLabel(value: string): string {
  const key = value.trim().toLowerCase();
  return VENDOR_LABELS[key] ?? titleCaseVendor(key);
}

export function modelPickerGroupSource(model: ModelPickerGroupable): {
  readonly id: string;
  readonly title: string;
  readonly slugPrefix: string | null;
} {
  const subProvider = model.subProvider?.trim();
  if (subProvider) {
    return {
      id: `sub:${subProvider.toLowerCase()}`,
      title: /[A-Z\s]/u.test(subProvider)
        ? subProvider
        : modelPickerVendorLabel(subProvider),
      slugPrefix: slugPrefixFromModel(model) ?? subProvider.toLowerCase(),
    };
  }
  const prefix = slugPrefixFromModel(model);
  if (prefix) {
    return {
      id: `vendor:${prefix}`,
      title: modelPickerVendorLabel(prefix),
      slugPrefix: prefix,
    };
  }
  return {
    id: `instance:${model.instanceId}`,
    title: model.instanceDisplayName,
    slugPrefix: null,
  };
}

function slugPrefixFromModel(model: ModelPickerGroupable): string | null {
  const separator = model.slug.indexOf("/");
  if (separator <= 0) {
    return null;
  }
  return model.slug.slice(0, separator).toLowerCase();
}

export function buildModelPickerGroupSections<T extends ModelPickerGroupable>(
  models: ReadonlyArray<T>,
): Array<ModelPickerGroupSection<T>> {
  const sections: Array<ModelPickerGroupSection<T>> = [];
  const indexByKey = new Map<string, number>();

  for (const model of models) {
    const source = modelPickerGroupSource(model);
    const key = `${model.instanceId}:${source.id}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, sections.length);
      sections.push({
        id: source.id,
        instanceId: model.instanceId,
        driverKind: model.driverKind,
        title: source.title,
        slugPrefix: source.slugPrefix,
        items: [model],
      });
      continue;
    }
    sections[existingIndex]!.items.push(model);
  }

  return sections;
}

export function resolveModelSlugForGroup(
  raw: string,
  slugPrefix: string | null,
): string {
  const normalized = normalizeCustomModelSlug(raw);
  if (!normalized) {
    return "";
  }
  if (normalized.includes("/") || !slugPrefix) {
    return normalized;
  }
  return `${slugPrefix}/${normalized}`;
}
