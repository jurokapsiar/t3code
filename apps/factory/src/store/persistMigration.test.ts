import { FactoryThreadKey } from "@t3tools/contracts/factory";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { StateStorage } from "zustand/middleware";
import { migratePresentationState } from "./persistMigration";

describe("migratePresentationState", () => {
  it("keeps valid theme and drops legacy credentials and favorites", () => {
    expect(
      migratePresentationState({
        theme: "light",
        instances: [{ token: "fake-sensitive-value" }],
        favoriteProjectIds: ["old-mock-project"],
      }),
    ).toEqual({ theme: "light" });
  });

  it("drops all domain and other presentation keys", () => {
    expect(
      migratePresentationState({
        theme: "dark",
        projects: [{ favorite: true }],
        threads: [{}],
        credentials: "fake-sensitive-value",
        selectedThreadId: "old-thread",
        selectedTarget: { environmentId: "source", threadId: "thread" },
        searchQuery: "old-query",
      }),
    ).toEqual({ theme: "dark" });
  });

  it.each([
    undefined,
    null,
    {},
    [],
    "light",
    1,
    true,
    { theme: "system" },
    { theme: null },
    { theme: 1 },
    { theme: ["light"] },
    { theme: {} },
  ])("uses the existing dark default for invalid input %j", (input) => {
    expect(migratePresentationState(input)).toEqual({ theme: "dark" });
  });
});

describe("store persistence and selection", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function loadStore(persisted?: unknown, writeError?: Error) {
    const items = new Map<string, string>();
    if (persisted !== undefined) {
      items.set("t3-factory-storage", JSON.stringify(persisted));
    }
    const localStorage: StateStorage = {
      getItem: (name) => items.get(name) ?? null,
      setItem: (name, value) => {
        if (writeError) throw writeError;
        items.set(name, value);
      },
      removeItem: (name) => {
        items.delete(name);
      },
    };
    vi.stubGlobal("window", { localStorage });
    const { useT3Store: store } = await import("./useT3Store");
    const readPersisted = (): unknown => {
      const value = items.get("t3-factory-storage");
      if (value === undefined) throw new Error("No persisted store value");
      return JSON.parse(value);
    };
    return { store, readPersisted };
  }

  it("migrates version zero and does not seed legacy domain data", async () => {
    const { store, readPersisted } = await loadStore({
      version: 0,
      state: {
        theme: "light",
        instances: [{ token: "fake-sensitive-value" }],
        favoriteProjectIds: ["old-mock-project"],
        projects: [],
        threads: [],
      },
    });
    expect(store.persist.hasHydrated()).toBe(true);
    expect(store.getState().theme).toBe("light");
    expect(readPersisted()).toEqual({ version: 3, state: { theme: "light" } });
  });

  it.each([
    { version: 1, theme: "light", expectedTheme: "light" },
    { version: 1, theme: "dark", expectedTheme: "dark" },
    { version: 1, theme: "invalid", expectedTheme: "dark" },
    { version: undefined, theme: "light", expectedTheme: "light" },
    { version: undefined, theme: "dark", expectedTheme: "dark" },
    { version: undefined, theme: "invalid", expectedTheme: "dark" },
  ])(
    "rewrites contaminated version $version with theme $theme immediately on hydration",
    async ({ version, theme, expectedTheme }) => {
      const { store, readPersisted } = await loadStore({
        version,
        state: {
          theme,
          credentials: "fake-sensitive-value",
          instances: [{ token: "fake-sensitive-value" }],
          favoriteProjectIds: ["old-mock-project"],
          projects: [],
          threads: [],
          selectedThreadId: "old-thread",
          searchQuery: "old-query",
          setTheme: null,
        },
      });
      expect(store.persist.hasHydrated()).toBe(true);
      expect(readPersisted()).toEqual({ version: 3, state: { theme: expectedTheme } });
      expect(store.getState().theme).toBe(expectedTheme);
      expect(store.getState().searchQuery).toBe("");
      expect(store.getState().setTheme).toBeTypeOf("function");
    },
  );

  it.each([3, undefined])(
    "reports a denied hydration rewrite at version %s without leaking data or losing theme",
    async (version) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const persisted = {
        version,
        state: { theme: "light", credentials: "fake-sensitive-value" },
      };
      const { store, readPersisted } = await loadStore(
        persisted,
        new Error("fake-sensitive-value"),
      );
      expect(store.persist.hasHydrated()).toBe(true);
      expect(store.getState().theme).toBe("light");
      expect(store.getState().setTheme).toBeTypeOf("function");
      expect(readPersisted()).toEqual(
        version === 3
          ? { version: 3, state: { theme: "light", credentials: "fake-sensitive-value" } }
          : { state: { theme: "light", credentials: "fake-sensitive-value" } },
      );
      expect(log).toHaveBeenCalledExactlyOnceWith("Failed to rewrite presentation storage.");
    },
  );

  it("reports migration write errors without logging stored data", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store, readPersisted } = await loadStore(
      {
        version: 0,
        state: { theme: "light", credentials: "fake-sensitive-value" },
      },
      new Error("fake-sensitive-value"),
    );
    expect(store.persist.hasHydrated()).toBe(false);
    expect(store.getState().theme).toBe("light");
    expect(store.getState().setTheme).toBeTypeOf("function");
    expect(readPersisted()).toEqual({
      version: 0,
      state: { theme: "light", credentials: "fake-sensitive-value" },
    });
    expect(log).toHaveBeenCalledExactlyOnceWith("Failed to hydrate presentation storage.");
  });

  it("starts with dark theme and empty selections when storage is empty", async () => {
    const { store } = await loadStore();
    expect(store.getState().theme).toBe("dark");
    expect(store.getState().selectedTarget).toBeNull();
  });

  it.each([0, 1, 2, undefined])("validates hydration at persisted version %s", async (version) => {
    const { store, readPersisted } = await loadStore({
      version,
      state: { theme: "invalid", instances: [], projects: [], threads: [], setTheme: null },
    });
    expect(store.persist.hasHydrated()).toBe(true);
    expect(store.getState().theme).toBe("dark");
    store.getState().setTheme("light");
    expect(readPersisted()).toEqual({ version: 3, state: { theme: "light" } });
  });

  it("reloads theme but not legacy domain data, filters, or selections", async () => {
    const { store, readPersisted } = await loadStore();
    store.getState().setSearchQuery("temporary");
    store.getState().setTheme("light");
    expect(readPersisted()).toEqual({ version: 3, state: { theme: "light" } });

    vi.resetModules();
    const { useT3Store: reloaded } = await import("./useT3Store");
    expect(reloaded.getState().theme).toBe("light");
    expect(reloaded.getState().searchQuery).toBe("");
    expect(reloaded.getState().selectedTarget).toBeNull();
    reloaded.getState().toggleTheme();
    expect(readPersisted()).toEqual({ version: 3, state: { theme: "dark" } });
  });

  it("selects identical thread IDs on different sources and closes without losing filters", async () => {
    const { store, readPersisted } = await loadStore();
    const first = Schema.decodeUnknownSync(FactoryThreadKey)({
      environmentId: "source-a",
      threadId: "thread-1",
    });
    const second = Schema.decodeUnknownSync(FactoryThreadKey)({
      environmentId: "source-b",
      threadId: "thread-1",
    });
    store.getState().setViewMode("dashboard");
    store.getState().setSearchQuery("keep-filter");
    const expansion = store.getState().expandedRowIds;
    store.getState().setSelectedTarget(first);
    expect(store.getState().selectedTarget).toEqual(first);
    expect(store.getState().viewMode).toBe("split");
    store.getState().setSelectedTarget(second, "fullscreen");
    expect(store.getState().selectedTarget).toEqual(second);
    expect(store.getState().viewMode).toBe("fullscreen");
    store.getState().setSelectedTarget(first);
    expect(store.getState().viewMode).toBe("fullscreen");
    store.getState().setSelectedTarget(null);
    expect(store.getState().selectedTarget).toBeNull();
    expect(store.getState().viewMode).toBe("dashboard");
    expect(store.getState().searchQuery).toBe("keep-filter");
    expect(store.getState().expandedRowIds).toEqual(expansion);
    expect(readPersisted()).toEqual({ version: 3, state: { theme: "dark" } });
  });
});
