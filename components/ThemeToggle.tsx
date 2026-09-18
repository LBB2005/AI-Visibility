"use client";

import { useSyncExternalStore } from "react";

type Mode = "system" | "light" | "dark";
const NEXT: Record<Mode, Mode> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Mode, string> = { system: "Auto theme", light: "Light", dark: "Dark" };

// The inline script in layout.tsx sets data-theme before hydration; the DOM is the store.
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const getSnapshot = (): Mode => {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
};

export default function ThemeToggle() {
  const mode = useSyncExternalStore(subscribe, getSnapshot, () => "system" as Mode);

  const cycle = () => {
    const m = NEXT[mode];
    try {
      if (m === "system") localStorage.removeItem("avc-theme");
      else localStorage.setItem("avc-theme", m);
    } catch {}
    if (m === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = m;
    listeners.forEach((l) => l());
  };

  return (
    <button onClick={cycle} className="chip hover:text-ink" aria-label={`Theme: ${LABEL[mode]}. Click to change.`}>
      <span
        aria-hidden
        className="inline-block h-2.5 w-2.5 rounded-full border border-current"
        style={{ background: mode === "dark" ? "currentColor" : "transparent" }}
      />
      {LABEL[mode]}
    </button>
  );
}
