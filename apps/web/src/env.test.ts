import { afterEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("sidebar workspace availability", () => {
  it.each([
    { desktop: true, dev: false, alpha: "", enabled: true },
    { desktop: false, dev: true, alpha: "1", enabled: true },
    { desktop: false, dev: true, alpha: "", enabled: false },
    { desktop: false, dev: false, alpha: "1", enabled: false },
  ])("resolves $enabled for desktop=$desktop dev=$dev alpha=$alpha", async (scenario) => {
    vi.stubGlobal("window", scenario.desktop ? { desktopBridge: {} } : {});
    vi.stubEnv("DEV", scenario.dev);
    vi.stubEnv("VITE_ALPHA_WORKSPACES", scenario.alpha);
    const env = await import("./env");
    expect(env.sidebarWorkspacesEnabled).toBe(scenario.enabled);
    expect(env.isElectron).toBe(scenario.desktop);
  });
});
