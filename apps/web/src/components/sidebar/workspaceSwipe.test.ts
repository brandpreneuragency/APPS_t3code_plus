import { describe, expect, it } from "vite-plus/test";
import { workspaceSwipeDirection } from "./workspaceSwipe";

describe("workspace panel swipe", () => {
  it("switches forward on left drag and backward on right drag", () => {
    expect(workspaceSwipeDirection(-80, 5)).toBe(1);
    expect(workspaceSwipeDirection(80, -5)).toBe(-1);
  });
  it("ignores small movements and primarily vertical gestures", () => {
    expect(workspaceSwipeDirection(59, 0)).toBe(0);
    expect(workspaceSwipeDirection(80, 70)).toBe(0);
    expect(workspaceSwipeDirection(-80, -70)).toBe(0);
    expect(workspaceSwipeDirection(0, 100)).toBe(0);
  });
});
