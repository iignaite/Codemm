"use client";

import { useSyncExternalStore } from "react";

const THEME_KEY = "codem-theme";
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readIsDark(): boolean {
  return localStorage.getItem(THEME_KEY) === "dark";
}

export function useThemeMode(): { darkMode: boolean; toggleDarkMode: () => void } {
  // localStorage is an external store; useSyncExternalStore keeps every
  // consumer of this hook in sync and renders light on the server snapshot.
  const darkMode = useSyncExternalStore(subscribe, readIsDark, () => false);

  const toggleDarkMode = () => {
    localStorage.setItem(THEME_KEY, darkMode ? "light" : "dark");
    for (const listener of listeners) listener();
  };

  return { darkMode, toggleDarkMode };
}
