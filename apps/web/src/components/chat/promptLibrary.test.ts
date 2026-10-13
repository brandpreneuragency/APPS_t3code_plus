import { describe, expect, it } from "vite-plus/test";
import type { PromptLibrary } from "@t3tools/contracts";
import {
  filterPrompts,
  movePrompt,
  orderedPrompts,
  parsePromptTags,
  promptTagStyles,
} from "./promptLibrary";

const library: PromptLibrary = {
  first: { title: "Review", text: "Find bugs", favorite: true, order: 0, tags: ["Code"] },
  second: { title: "Draft", text: "Write a letter", favorite: false, order: 1, tags: ["Writing"] },
  third: { title: "Test", text: "Check edge cases", favorite: false, order: 2, tags: ["Code"] },
  removed: null,
};

describe("prompt library", () => {
  it("combines search, tags, and favorites without changing manual order", () => {
    expect(filterPrompts(library, "BUGS", "Code", true).map((prompt) => prompt.id)).toEqual([
      "first",
    ]);
    expect(filterPrompts(library, "", "Code", false).map((prompt) => prompt.id)).toEqual([
      "first",
      "third",
    ]);
    expect(filterPrompts(library, "letter", "Code", false)).toEqual([]);
  });

  it("reorders filtered prompts while retaining hidden prompts and content", () => {
    const patch = movePrompt(library, ["first", "third"], "third", -1);
    expect(orderedPrompts({ ...library, ...patch }).map((prompt) => prompt.id)).toEqual([
      "third",
      "second",
      "first",
    ]);
    expect(patch.first?.text).toBe("Find bugs");
    expect(movePrompt(library, ["first", "third"], "first", -1)).toEqual({});
  });

  it("can reorder prompts created with identical positions", () => {
    const tied = { ...library, third: { ...library.third!, order: 0 } };
    const patch = movePrompt(tied, ["first", "third"], "third", -1);
    expect(orderedPrompts({ ...tied, ...patch })[0]?.id).toBe("third");
  });

  it("normalizes duplicate tags and reuses existing capitalization", () => {
    expect(parsePromptTags(" code, Code, Work, , work ", ["Code"])).toEqual(["Code", "work"]);
  });

  it("assigns distinct tag colors including hash collisions, with translucent fills", () => {
    const styles = promptTagStyles(["Aa", "BB", "Code"]);
    expect(new Set([...styles.values()].map((style) => style.border)).size).toBe(3);
    expect(styles.get("Code")?.border).toMatch(/^2px solid /);
    expect(styles.get("Code")?.backgroundColor).toMatch(/\/ 0.30\)$/);
  });
});
