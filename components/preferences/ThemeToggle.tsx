"use client";

// ShapesOS — one-click light/dark switch for the sidebar (member-requested,
// Oct 2026: "make it easily switchable"). Writes the same `theme` preference
// the Appearance page edits (PATCH /api/preferences → the per-member record
// + the shell cookie, so the next server paint matches), and applies the
// theme classes to <html> immediately, like the Appearance preview does.
// Disabled until the current preferences load so an optimistic paint can
// always be reverted.

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { ThemePreference, UserPreferences } from "@/lib/preferences/schema";

/** Mirror of the theme part of shellClassNames (lib/preferences/shell.ts) —
    touches only theme classes so a full preferences snapshot is not needed
    for the optimistic paint. */
function applyThemeClasses(theme: ThemePreference): void {
  const root = document.documentElement;
  for (const c of [...root.classList]) {
    if (c === "dark" || c.startsWith("theme-")) root.classList.remove(c);
  }
  root.classList.add(`theme-${theme}`);
  if (theme === "dark") root.classList.add("dark");
}

/** The theme currently painted, from <html> itself (server-rendered). */
function paintedTheme(): "light" | "dark" {
  const root = document.documentElement;
  if (root.classList.contains("theme-dark") || root.classList.contains("dark")) return "dark";
  if (root.classList.contains("theme-light")) return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeToggle() {
  const { t } = useI18n();
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/preferences", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { preferences?: UserPreferences } | null) => {
        if (live && b?.preferences) setPrefs(b.preferences);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const painted = prefs ? (prefs.theme === "system" ? paintedTheme() : prefs.theme) : paintedTheme();
  const next: ThemePreference = painted === "dark" ? "light" : "dark";
  const label = next === "light" ? t("shell.themeToggleToLight") : t("shell.themeToggleToDark");

  async function toggle() {
    if (!prefs || pending) return;
    const before = prefs;
    setPending(true);
    applyThemeClasses(next);
    try {
      const res = await fetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: next }),
      });
      const body = (await res.json().catch(() => ({}))) as { preferences?: UserPreferences };
      if (!res.ok || !body.preferences) throw new Error(`HTTP ${res.status}`);
      setPrefs(body.preferences);
    } catch {
      applyThemeClasses(before.theme);
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={!prefs || pending}
      aria-label={label}
      title={label}
      className="flex size-9 shrink-0 items-center justify-center rounded-full text-night-soft transition-[background-color,color] duration-150 hover:bg-night-hover hover:text-night-text disabled:opacity-50"
    >
      {next === "light" ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
    </button>
  );
}
