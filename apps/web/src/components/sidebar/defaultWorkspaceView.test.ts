import { describe, expect, it } from "vite-plus/test";

import {
  getDefaultSidebarView,
  patchDefaultSidebarView,
  resetDefaultSidebarViewForTests,
} from "./defaultWorkspaceView";

describe("defaultWorkspaceView", () => {
  it("preserves search, filter, paging, and scroll across unmount snapshots", () => {
    resetDefaultSidebarViewForTests();
    patchDefaultSidebarView({
      query: "klasor",
      projectScopeKey: "repo:agora",
      scrollTop: 240,
      settledVisibleCount: 35,
      expandedThreadListKeys: ["p1"],
    });
    expect(getDefaultSidebarView()).toEqual({
      query: "klasor",
      projectScopeKey: "repo:agora",
      scrollTop: 240,
      settledVisibleCount: 35,
      expandedThreadListKeys: ["p1"],
    });
    resetDefaultSidebarViewForTests();
    expect(getDefaultSidebarView().query).toBe("");
  });
});
