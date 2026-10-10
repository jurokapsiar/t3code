import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { FactoryThreadClassification, FactoryThreadKey } from "@t3tools/contracts/factory";
import { migratePresentationState } from "./persistMigration";

interface T3StoreState {
  theme: "dark" | "light";
  activeEnvironmentFilter: string;
  stateFilter: "all" | FactoryThreadClassification;
  groupFilter: string;
  searchQuery: string;
  expandedRowIds: string[];
  selectedTarget: FactoryThreadKey | null;
  viewMode: "dashboard" | "split" | "fullscreen";
  showNewThreadModal: boolean;
  setTheme: (theme: "dark" | "light") => void;
  toggleTheme: () => void;
  setActiveEnvironmentFilter: (filter: string) => void;
  setStateFilter: (filter: "all" | FactoryThreadClassification) => void;
  setGroupFilter: (filter: string) => void;
  setSearchQuery: (query: string) => void;
  toggleExpandRow: (rowId: string) => void;
  setExpandedRows: (rowIds: string[]) => void;
  setSelectedTarget: (target: FactoryThreadKey | null, mode?: "split" | "fullscreen") => void;
  setViewMode: (mode: "dashboard" | "split" | "fullscreen") => void;
  setShowNewThreadModal: (show: boolean) => void;
}

export const useT3Store = create<T3StoreState>()(
  persist(
    (set, get) => ({
      theme: "dark",
      activeEnvironmentFilter: "all",
      stateFilter: "all",
      groupFilter: "all",
      searchQuery: "",
      expandedRowIds: [],
      selectedTarget: null,
      viewMode: "dashboard",
      showNewThreadModal: false,

      setTheme: (theme) => {
        if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
        set({ theme });
      },
      toggleTheme: () => {
        const nextTheme = get().theme === "dark" ? "light" : "dark";
        if (typeof document !== "undefined") document.documentElement.dataset.theme = nextTheme;
        set({ theme: nextTheme });
      },
      setActiveEnvironmentFilter: (filter) => set({ activeEnvironmentFilter: filter }),
      setStateFilter: (filter) => set({ stateFilter: filter }),
      setGroupFilter: (filter) => set({ groupFilter: filter }),
      setSearchQuery: (query) => set({ searchQuery: query }),
      toggleExpandRow: (rowId) =>
        set((state) => ({
          expandedRowIds: state.expandedRowIds.includes(rowId)
            ? state.expandedRowIds.filter((id) => id !== rowId)
            : [...state.expandedRowIds, rowId],
        })),
      setExpandedRows: (rowIds) => set({ expandedRowIds: rowIds }),
      setSelectedTarget: (target, mode) =>
        set((state) => ({
          selectedTarget: target,
          viewMode: target
            ? mode || (state.viewMode === "dashboard" ? "split" : state.viewMode)
            : "dashboard",
        })),
      setViewMode: (mode) => set({ viewMode: mode }),
      setShowNewThreadModal: (show) => set({ showNewThreadModal: show }),
    }),
    {
      name: "t3-factory-storage",
      version: 3,
      migrate: migratePresentationState,
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...migratePresentationState(persistedState),
      }),
      onRehydrateStorage: () => (state, error) => {
        if (error !== undefined || !state) {
          console.error("Failed to hydrate presentation storage.");
          return;
        }
        try {
          state.setTheme(state.theme);
        } catch {
          console.error("Failed to rewrite presentation storage.");
        }
      },
      partialize: (state) => ({ theme: state.theme }),
    },
  ),
);
