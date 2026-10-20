// ShapesOS — Phase 18.1 (WS=desk): split view state (PURE, client-safe).
//
// /dashboard/split?left=<path>&right=<path>&ratio=<20–80> shows two dashboard
// pages side by side (each in a same-origin pane), e.g. a record next to the
// Assistant or next to another record. Everything lives in the URL so the
// view survives a reload and can be shared with yourself. Pane paths are
// validated here: only this app's /dashboard pages (never split view itself,
// never another origin).

export const SPLIT_PATH = "/dashboard/split";
export const DEFAULT_RIGHT = "/dashboard/assistant";
export const RATIO_MIN = 20;
export const RATIO_MAX = 80;
export const RATIO_STEP = 5;

export interface SplitState {
  left: string;
  right: string;
  /** Width of the left pane, percent. */
  ratio: number;
}

/** A pane path, or null when it must not be shown in a pane. Query kept (a tab is part of the record), hash dropped. */
export function sanitizePaneHref(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw.startsWith("/dashboard")) return null;
  if (raw.startsWith("//") || raw.includes("\\") || /[\u0000-\u001f\s]/.test(raw)) return null;
  if (raw.length > 500) return null;
  const [path, query = ""] = raw.split("#")[0]!.split("?") as [string, string?];
  if (path !== "/dashboard" && !path.startsWith("/dashboard/")) return null;
  if (path === SPLIT_PATH || path.startsWith(`${SPLIT_PATH}/`)) return null;
  if (/(^|\/)\.\.?(\/|$)/.test(path)) return null;
  return query ? `${path}?${query}` : path;
}

export function clampRatio(n: unknown): number {
  const v = typeof n === "number" ? n : Number.parseFloat(String(n ?? ""));
  if (!Number.isFinite(v)) return 50;
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, Math.round(v)));
}

/** Read the state from URL params (missing or invalid panes fall back to Overview / the Assistant). */
export function parseSplit(params: { get(name: string): string | null }): SplitState {
  return {
    left: sanitizePaneHref(params.get("left")) ?? "/dashboard",
    right: sanitizePaneHref(params.get("right")) ?? DEFAULT_RIGHT,
    ratio: clampRatio(params.get("ratio") ?? 50),
  };
}

export function splitUrl(s: SplitState): string {
  const p = new URLSearchParams({ left: s.left, right: s.right });
  if (s.ratio !== 50) p.set("ratio", String(s.ratio));
  return `${SPLIT_PATH}?${p.toString()}`;
}

export function swapPanes(s: SplitState): SplitState {
  return { left: s.right, right: s.left, ratio: 100 - s.ratio };
}

export function nudgeRatio(s: SplitState, delta: number): SplitState {
  return { ...s, ratio: clampRatio(s.ratio + delta) };
}
