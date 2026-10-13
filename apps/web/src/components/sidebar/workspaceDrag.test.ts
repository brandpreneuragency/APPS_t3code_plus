import { describe, expect, it } from "vite-plus/test";

import {
  clearWorkspacePointerGuard,
  consumeWorkspaceClickGuard,
  consumeWorkspaceKeyboardGuard,
  createWorkspaceDragState,
  markWorkspaceDragCancel,
  markWorkspaceDragEnd,
  markWorkspaceDragStart,
  prepareWorkspaceKeyboardGesture,
} from "./workspaceDrag";

describe("workspace drag release guard", () => {
  it("suppresses the click after a pointer drag until the next pointer gesture", () => {
    const state = createWorkspaceDragState();

    markWorkspaceDragStart(state);
    markWorkspaceDragEnd(state);

    expect(consumeWorkspaceClickGuard(state)).toBe(true);
    expect(consumeWorkspaceClickGuard(state)).toBe(false);

    markWorkspaceDragStart(state);
    markWorkspaceDragEnd(state);
    clearWorkspacePointerGuard(state);
    expect(consumeWorkspaceClickGuard(state)).toBe(false);
  });

  it("consumes keyboard release once and keeps a synthetic click blocked", () => {
    const state = createWorkspaceDragState();

    markWorkspaceDragStart(state);
    markWorkspaceDragEnd(state);

    expect(consumeWorkspaceKeyboardGuard(state)).toBe(true);
    expect(consumeWorkspaceKeyboardGuard(state)).toBe(false);
    expect(consumeWorkspaceClickGuard(state)).toBe(true);
    expect(consumeWorkspaceClickGuard(state)).toBe(false);
  });

  it("treats cancelled drags like completed drags", () => {
    const state = createWorkspaceDragState();

    markWorkspaceDragStart(state);
    markWorkspaceDragCancel(state);

    expect(consumeWorkspaceClickGuard(state)).toBe(true);
  });

  it("allows the next fresh keyboard gesture when a drag release had no click", () => {
    const state = createWorkspaceDragState();

    markWorkspaceDragStart(state);
    markWorkspaceDragEnd(state);
    prepareWorkspaceKeyboardGesture(state);

    expect(consumeWorkspaceClickGuard(state)).toBe(false);
    expect(consumeWorkspaceKeyboardGuard(state)).toBe(false);
  });
});
