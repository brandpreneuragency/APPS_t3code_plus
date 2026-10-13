import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const LAST_EDITOR_KEY = "t3code:last-editor";

function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

async function loadEditorPreferences(storage: Storage) {
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("localStorage", storage);
  return import("./editorPreferences");
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("resolveAndPersistPreferredEditor", () => {
  it("keeps a stored real editor", async () => {
    const storage = createStorage();
    storage.setItem(LAST_EDITOR_KEY, JSON.stringify("zed"));
    const { resolveAndPersistPreferredEditor } = await loadEditorPreferences(storage);

    expect(resolveAndPersistPreferredEditor(["zed", "vscode"])).toBe("zed");
  });

  it("ignores a stored file manager once a real editor is available", async () => {
    const storage = createStorage();
    storage.setItem(LAST_EDITOR_KEY, JSON.stringify("file-manager"));
    const { resolveAndPersistPreferredEditor } = await loadEditorPreferences(storage);

    expect(resolveAndPersistPreferredEditor(["file-manager", "vscode"])).toBe("vscode");
    expect(storage.getItem(LAST_EDITOR_KEY)).toBe(JSON.stringify("vscode"));
  });

  it("still uses the file manager when it is the only editor", async () => {
    const storage = createStorage();
    const { resolveAndPersistPreferredEditor } = await loadEditorPreferences(storage);

    expect(resolveAndPersistPreferredEditor(["file-manager"])).toBe("file-manager");
  });

  it("prefers a real editor over the file manager even when the file manager is listed first", async () => {
    const storage = createStorage();
    const { resolveAndPersistPreferredEditor } = await loadEditorPreferences(storage);

    expect(resolveAndPersistPreferredEditor(["file-manager", "idea", "vscode"])).toBe("vscode");
  });

  it("returns null when no editor is available", async () => {
    const storage = createStorage();
    const { resolveAndPersistPreferredEditor } = await loadEditorPreferences(storage);

    expect(resolveAndPersistPreferredEditor([])).toBeNull();
  });
});
