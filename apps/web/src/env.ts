/**
 * True when running inside the Electron preload bridge, false in a regular browser.
 * The preload script sets window.desktopBridge via contextBridge before any web-app
 * code executes, so this is reliable at module load time.
 */
export const isElectron = typeof window !== "undefined" && window.desktopBridge !== undefined;

export const sidebarWorkspacesEnabled =
  isElectron || (import.meta.env.DEV && import.meta.env.VITE_ALPHA_WORKSPACES === "1");
