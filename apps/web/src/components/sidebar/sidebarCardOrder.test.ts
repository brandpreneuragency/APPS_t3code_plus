import { describe, expect, it } from "vite-plus/test";

import {
  orderSidebarCardKeys,
  reorderSidebarCardKeys,
  sidebarCardOrderKey,
} from "./sidebarCardOrder";

describe("sidebar card order", () => {
  it("keeps the default order until a card is moved", () => {
    expect(orderSidebarCardKeys(["new", "middle", "old"], [])).toEqual(["new", "middle", "old"]);
  });

  it("moves cards in either direction and restores a saved order", () => {
    const keys = ["first", "second", "third"];
    const saved = reorderSidebarCardKeys([], keys, "third", "first");
    expect(saved).toEqual(["third", "first", "second"]);
    expect(orderSidebarCardKeys(keys, JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(reorderSidebarCardKeys(saved, keys, "third", "second")).toEqual(keys);
  });

  it("keeps hidden and disconnected cards in their slots when filtering", () => {
    const saved = ["remote:first", "local:first", "remote:second", "local:second"];
    expect(
      reorderSidebarCardKeys(saved, ["local:first", "local:second"], "local:second", "local:first"),
    ).toEqual(["remote:first", "local:second", "remote:second", "local:first"]);
  });

  it("puts new cards first without reshuffling arranged cards", () => {
    expect(orderSidebarCardKeys(["new", "first", "second"], ["second", "first"])).toEqual([
      "new",
      "second",
      "first",
    ]);
    expect(
      reorderSidebarCardKeys(["second", "first"], ["new", "first", "second"], "new", "first"),
    ).toEqual(["second", "first", "new"]);
  });

  it("ignores cancelled, unchanged, or stale drop targets", () => {
    const saved = ["first", "second"];
    expect(reorderSidebarCardKeys(saved, saved, "first", "first")).toBe(saved);
    expect(reorderSidebarCardKeys(saved, saved, "missing", "first")).toBe(saved);
    expect(reorderSidebarCardKeys(saved, saved, "first", "missing")).toBe(saved);
  });

  it("separates identical thread IDs in different environments", () => {
    expect(sidebarCardOrderKey({ environmentId: "local", id: "same" })).not.toBe(
      sidebarCardOrderKey({ environmentId: "remote", id: "same" }),
    );
  });

  it("returns an un-settled card to the top without changing other positions", () => {
    const thread = { environmentId: "local", id: "returning" };
    const oldKey = sidebarCardOrderKey(thread);
    const newKey = sidebarCardOrderKey({ ...thread, unsettledAt: "2026-09-20T12:00:00Z" });
    expect(orderSidebarCardKeys(["first", newKey, "second"], ["second", oldKey, "first"])).toEqual([
      newKey,
      "second",
      "first",
    ]);
  });
});
