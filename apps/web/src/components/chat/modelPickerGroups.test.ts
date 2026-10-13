import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildModelPickerGroupSections,
  modelPickerGroupSource,
  modelPickerVendorLabel,
  resolveModelSlugForGroup,
} from "./modelPickerGroups";

function model(input: {
  slug: string;
  instanceId?: string;
  displayName?: string;
  subProvider?: string;
  driver?: string;
}) {
  return {
    slug: input.slug,
    instanceId: ProviderInstanceId.make(input.instanceId ?? "commandCode"),
    instanceDisplayName: input.displayName ?? "Command Code",
    driverKind: ProviderDriverKind.make(input.driver ?? "commandCode"),
    ...(input.subProvider ? { subProvider: input.subProvider } : {}),
  };
}

describe("model picker groups", () => {
  it("labels known vendor prefixes", () => {
    expect(modelPickerVendorLabel("google")).toBe("Google");
    expect(modelPickerVendorLabel("x-ai")).toBe("xAI");
  });

  it("groups Command Code models by slug vendor", () => {
    const sections = buildModelPickerGroupSections([
      model({ slug: "google/gemini-3.5-flash" }),
      model({ slug: "google/gemini-3.7-flash" }),
      model({ slug: "anthropic/claude-sonnet-5" }),
      model({ slug: "taste-1", displayName: "Command Code" }),
    ]);

    expect(sections.map((section) => section.title)).toEqual(["Google", "Anthropic", "Command Code"]);
    expect(sections[0]?.items.map((item) => item.slug)).toEqual([
      "google/gemini-3.5-flash",
      "google/gemini-3.7-flash",
    ]);
  });

  it("prefers subProvider over slug prefix", () => {
    expect(
      modelPickerGroupSource(model({ slug: "google/gemini-3.8-flash", subProvider: "Google AI" })),
    ).toMatchObject({ title: "Google AI", slugPrefix: "google" });
  });

  it("prefixes a short slug with the group vendor", () => {
    expect(resolveModelSlugForGroup("gemini-3.8-flash", "google")).toBe("google/gemini-3.8-flash");
    expect(resolveModelSlugForGroup("google/gemini-3.8-flash", "google")).toBe(
      "google/gemini-3.8-flash",
    );
  });
});
