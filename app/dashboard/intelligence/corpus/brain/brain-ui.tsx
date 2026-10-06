// Marketr — Knowledge Brain: shared UI atoms (Agentic OS).
//
// Status color+shape law: the four status colors appear ONLY for agent
// states, always color + shape + text label. Pillar identity is a category,
// so pillars re-anchor to neutral tokens (ink / muted / subtle) — never the
// status colors, never brand violet. PILLAR_COLORS holds DOM-safe var()
// references for inline styles; canvas/THREE contexts (which cannot parse
// var()) use pillarColorHex() / resolveToken(), resolved once from the
// computed stylesheet on the client.

import type { BrainPillar } from "@/lib/intelligence/corpus/graph";

/** Pillar → neutral token name. Categories are neutrals only. */
export const PILLAR_TOKENS: Record<BrainPillar, string> = {
  marketing: "--aos-ink",
  growth: "--aos-text-muted",
  design: "--aos-text-subtle",
};

/** DOM-safe color references (valid in React inline styles). */
export const PILLAR_COLORS: Record<BrainPillar, string> = {
  marketing: "var(--aos-ink)",
  growth: "var(--aos-text-muted)",
  design: "var(--aos-text-subtle)",
};

const tokenCache = new Map<string, string>();

/** Resolve a token to a plain CSS color string for canvas 2D / THREE, which
 *  cannot parse var(). Client-only; falls back to the CSS keyword "black". */
export function resolveToken(name: string): string {
  if (typeof document === "undefined") return "black";
  // Phase 18.1: keyed by the <html> classes so a theme / contrast change
  // (light ↔ dark) re-resolves instead of serving the old colours.
  const osDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  const key = `${document.documentElement.className}|${osDark}|${name}`;
  let v = tokenCache.get(key);
  if (!v) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "black";
    tokenCache.set(key, v);
  }
  return v;
}

/** Resolved pillar color for canvas/THREE contexts. */
export function pillarColorHex(p: BrainPillar): string {
  return resolveToken(PILLAR_TOKENS[p]);
}

export const PILLAR_LABEL: Record<BrainPillar, string> = {
  marketing: "Marketing",
  growth: "Growth",
  design: "Design",
};

export type ChipTone = "neutral" | "running" | "needs" | "done" | "failed" | "queued" | "paused" | "deny";

const CHIP_SHAPES: Partial<Record<ChipTone, string>> = {
  running: "aos-shape aos-shape--running aos-is-live",
  needs: "aos-shape aos-shape--needs",
  done: "aos-shape aos-shape--done",
  failed: "aos-shape aos-shape--failed",
  queued: "aos-shape aos-shape--queued",
  paused: "aos-shape aos-shape--paused",
  deny: "aos-shape aos-shape--failed",
};

const CHIP_TONES: Record<ChipTone, string> = {
  neutral: "bg-white text-ink shadow-control",
  running: "bg-running text-white",
  needs: "bg-needs text-black",
  done: "bg-done text-white",
  failed: "bg-failed text-white",
  // Queued: white with a 1.5px black ring. Paused: line gray.
  queued: "bg-white text-ink shadow-outline",
  paused: "bg-line text-ink",
  // Denied / rejected: white with failed-text label and a 1.5px failed inset ring.
  deny: "bg-white text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)]",
};

/** Status badge: 28px pill, status fill + its shape + label. Categories and
 *  anything that is not an agent state use tone="neutral". */
export function Chip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: ChipTone }) {
  const shape = CHIP_SHAPES[tone];
  return (
    <span
      className={`inline-flex h-badge items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-sm font-semibold leading-none ${CHIP_TONES[tone]}`}
    >
      {shape && (
        <span className={shape} role="img" aria-label={tone} style={{ "--aos-shape-size": "10px" } as React.CSSProperties} />
      )}
      {children}
    </span>
  );
}

/** Inputs: 44px/36px, radius-md, 1.5px control border, white; focus border +
 *  3px focus halo (the global 2px outline is disabled here to match the
 *  input spec exactly — buttons keep it). */
export const inputCls =
  "rounded-md border-[1.5px] border-control bg-white px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-3 focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";

/** Primary action: black pill, 36px, press feedback. */
export const btnPrimary =
  "aos-press inline-flex h-control-sm items-center justify-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white hover:bg-ink-hover disabled:bg-disabled disabled:text-disabled-fg";

/** Secondary action: white pill with 1.5px black inset ring. */
export const btnGhost =
  "aos-press inline-flex h-control-sm items-center justify-center gap-1.5 rounded-full bg-white px-4 text-sm font-semibold text-ink shadow-outline hover:bg-hover-paper disabled:bg-disabled disabled:text-disabled-fg";

/** Semantic action fills (from the design system's action table).
 *  Run/Resume → running blue; Approve → done green; Deny/Delete →
 *  white with failed-text label and a 1.5px failed inset ring. */
export const btnRun =
  "aos-press inline-flex h-control-sm items-center justify-center gap-1.5 rounded-full bg-running px-4 text-sm font-semibold text-white hover:bg-running-pressed disabled:bg-disabled disabled:text-disabled-fg";
export const btnApprove =
  "aos-press inline-flex h-control-sm items-center justify-center gap-1.5 rounded-full bg-done px-4 text-sm font-semibold text-white disabled:bg-disabled disabled:text-disabled-fg";
export const btnDeny =
  "aos-press inline-flex h-control-sm items-center justify-center gap-1.5 rounded-full bg-white px-4 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] hover:bg-failed-tint disabled:bg-disabled disabled:text-disabled-fg";
