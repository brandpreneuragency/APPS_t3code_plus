import { describe, expect, it } from "vite-plus/test";
import {
  EDIT_CODE_PROGRESS_MESSAGES,
  getEditCodeProgressMessage,
} from "./editCodeProgressMessages";

describe("edit code progress messages", () => {
  it("contains ten unique short messages", () => {
    expect(EDIT_CODE_PROGRESS_MESSAGES).toHaveLength(10);
    expect(new Set(EDIT_CODE_PROGRESS_MESSAGES).size).toBe(10);
    expect(
      EDIT_CODE_PROGRESS_MESSAGES.every((message) =>
        /^[A-Za-z]+(?: [A-Za-z]+){1,3}$/.test(message),
      ),
    ).toBe(true);
  });

  it("selects the same message for the same turn", () => {
    const first = getEditCodeProgressMessage("2026-09-20T12:00:00.000Z");

    expect(first).toBe(getEditCodeProgressMessage("2026-09-20T12:00:00.000Z"));
    expect(EDIT_CODE_PROGRESS_MESSAGES).toContain(first);
    expect(getEditCodeProgressMessage(null)).toBe(EDIT_CODE_PROGRESS_MESSAGES[0]);
  });
});
