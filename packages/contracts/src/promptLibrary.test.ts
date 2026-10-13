import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decode = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const prompt = {
  title: "Review",
  text: "Review this change.",
  favorite: false,
  order: 0,
  tags: ["Code"],
};

describe("prompt library settings", () => {
  it("starts empty for existing installations", () => {
    expect(decodeSettings({}).promptLibrary).toEqual({});
  });

  it("accepts saved prompts and deletion markers", () => {
    expect(decode({ promptLibrary: { first: prompt, removed: null } }).promptLibrary).toEqual({
      first: prompt,
      removed: null,
    });
  });

  it.each([{ title: "" }, { text: "" }, { tags: [""] }, { order: Infinity }])(
    "rejects invalid entries: %j",
    (invalid) => {
      expect(() => decode({ promptLibrary: { first: { ...prompt, ...invalid } } })).toThrow();
    },
  );
});
