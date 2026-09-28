// Marketr — Phase 13C clipper: brand-kit captions.
//
// buildAss / buildSrt are pure builders (words + style → caption text).
// resolveCaptionStyle reads the workspace's DEFAULT BrandKit through
// withWorkspaceScope (RLS-scoped); applyStyleRulesToCaptions gates caption
// text against the workspace style rules.
//
// STYLE-RULE SEMANTICS (13B decisions resolved 2026-09-27): tone rules are
// machine-checked but never machine-enforced — severity=block on a tone rule
// downgrades to flag (flagged for review, let through); hard ban rules stay
// blocking. Ban patterns match whole words (\b…\b), so "ass" never matches
// "class". This module calls enforceStyleRules() AS-IS and inherits the
// decided semantics automatically.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  enforceStyleRules,
  StyleRuleBlockedError,
} from "@/lib/intelligence/company/style-check";
import type { CaptionStyle, Word } from "./types";

export { StyleRuleBlockedError };

/** Sane defaults when the workspace has no brand kit (brand-law violet). */
export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  font: "Inter",
  color: "#FFFFFF",
  highlightColor: "#7C3AED",
  position: "bottom",
  wordHighlight: true,
};

function isHex(s: unknown): s is string {
  return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/**
 * Resolve the caption style from the workspace's DEFAULT brand kit
 * (colors.primary/accent/text, fonts.heading/body). Falls back to the
 * oldest kit when no default is flagged, then to DEFAULT_CAPTION_STYLE.
 * All DB access is RLS-scoped via withWorkspaceScope.
 */
export async function resolveCaptionStyle(workspaceId: string): Promise<CaptionStyle> {
  const kit = await withWorkspaceScope(workspaceId, (tx) =>
    tx.brandKit.findFirst({
      where: { workspaceId, isDefault: true },
      orderBy: { createdAt: "asc" },
    }).then(
      (k) =>
        k ??
        tx.brandKit.findFirst({
          where: { workspaceId },
          orderBy: { createdAt: "asc" },
        }),
    ),
  );
  if (!kit) return { ...DEFAULT_CAPTION_STYLE };

  const colors = asRecord(kit.colors);
  const fonts = asRecord(kit.fonts);
  const highlight = isHex(colors.primary)
    ? colors.primary
    : isHex(colors.accent)
      ? colors.accent
      : DEFAULT_CAPTION_STYLE.highlightColor;
  const color = isHex(colors.text) ? colors.text : DEFAULT_CAPTION_STYLE.color;
  const font =
    typeof fonts.heading === "string" && fonts.heading.trim()
      ? fonts.heading.trim()
      : typeof fonts.body === "string" && fonts.body.trim()
        ? fonts.body.trim()
        : DEFAULT_CAPTION_STYLE.font;

  return { font, color, highlightColor: highlight, position: "bottom", wordHighlight: true };
}

/**
 * Gate caption text against the workspace style rules.
 * Fail-closed: a severity=block violation rethrows StyleRuleBlockedError
 * and the caller must REFUSE the render. severity=flag violations are
 * returned as warnings for the review UI.
 */
export async function applyStyleRulesToCaptions(
  text: string,
  workspaceId: string,
): Promise<{ warnings: string[] }> {
  // enforceStyleRules throws StyleRuleBlockedError on block violations —
  // deliberately NOT caught here: the render path must refuse, not warn.
  const result = await enforceStyleRules(text, workspaceId);
  return {
    warnings: result.violations
      .filter((v) => v.severity === "flag")
      .map((v) => `[${v.kind}] "${v.pattern}"`),
  };
}

// ---------------------------------------------------------------------------
// ASS builder (karaoke word highlight)
// ---------------------------------------------------------------------------

/** CSS #RRGGBB → ASS &HAABBGGRR (alpha 00 = opaque). */
function assColor(hex: string): string {
  const h = hex.replace("#", "");
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

/** Seconds → ASS timestamp H:MM:SS.cc */
function assTime(sec: number): string {
  const s = Math.max(0, sec);
  const cs = Math.floor((s % 1) * 100);
  const total = Math.floor(s);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${hh}:${pad(mm)}:${pad(ss)}.${pad(cs)}`;
}

const ALIGN: Record<CaptionStyle["position"], number> = {
  bottom: 2,
  center: 5,
  top: 8,
};

/**
 * Group words into caption events: break on sentence end or every
 * ~8 words / ~3.2s, whichever comes first.
 */
function groupWords(words: Word[]): Word[][] {
  const groups: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    cur.push(w);
    const span = cur.length > 0 ? w.end - cur[0].start : 0;
    if (/[.!?…]["'”’)]?$/.test(w.w) || cur.length >= 8 || span >= 3.2) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

/**
 * Build an ASS subtitle file with karaoke word highlighting.
 * Karaoke semantics: text renders in SecondaryColour (base) until "sung",
 * then sweeps to PrimaryColour (highlight) — so PrimaryColour is the brand
 * highlight and SecondaryColour the base caption color.
 */
export function buildAss(words: Word[], style: CaptionStyle): string {
  const size = 64;
  const marginV = style.position === "bottom" ? 220 : 60; // clear platform UI overlay zones
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Clip,${style.font},${size},${assColor(style.highlightColor)},${assColor(style.color)},&H80000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,${ALIGN[style.position]},40,40,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  for (const group of groupWords(words)) {
    if (group.length === 0) continue;
    const start = assTime(group[0].start);
    const end = assTime(group[group.length - 1].end);
    const text = style.wordHighlight
      ? group
          .map((w) => `{\\k${Math.max(1, Math.round((w.end - w.start) * 100))}}${w.w}`)
          .join(" ")
      : group.map((w) => w.w).join(" ");
    lines.push(`Dialogue: 0,${start},${end},Clip,,0,0,0,,${text}`);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// SRT builder
// ---------------------------------------------------------------------------

/** Seconds → SRT timestamp HH:MM:SS,mmm */
function srtTime(sec: number): string {
  const s = Math.max(0, sec);
  const ms = Math.floor((s % 1) * 1000);
  const total = Math.floor(s);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)},${pad3(ms)}`;
}

/** Build a plain SRT file; word groups become cue lines (max ~84 chars). */
export function buildSrt(words: Word[]): string {
  const cues: string[] = [];
  for (const group of groupWords(words)) {
    if (group.length === 0) continue;
    const start = srtTime(group[0].start);
    const end = srtTime(group[group.length - 1].end);
    const text = group.map((w) => w.w).join(" ");
    cues.push(`${cues.length + 1}\n${start} --> ${end}\n${text}`);
  }
  return cues.join("\n\n") + "\n";
}
