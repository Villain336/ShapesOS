// Marketr — Phase 11 "Canvas": curated template pack FACTORY (part 1).
// Layout families × curated palettes × real marketing copy → DesignDocuments.
// Run: npx tsx scripts/generate-template-pack.mts
// Output: lib/design/template-data/pack.json (data; the registry imports it).
//
// Design contract (locked Marketr style):
// - light #FAFAF7 grounds, violet primaries, stone text, Lucide-style icons
// - tasteful marketing color stories beyond violet (emerald/amber/rose/sky)
// - original designs only; every layout is parameterized by page size
// - copy is real marketing copy, never lorem ipsum (see copy.mts)

import type {
  DesignDocument,
  DesignElement,
  EllipseElement,
  LineElement,
  RectElement,
  SvgElement,
  TextElement,
} from "../../lib/design/types";
import { DESIGN_SCHEMA_VERSION } from "../../lib/design/types";

// ── Palettes ─────────────────────────────────────────────────────────────

export interface Palette {
  id: string;
  label: string;
  /** Page background. */
  bg: string;
  /** Card surface. */
  card: string;
  /** Primary action / accent. */
  primary: string;
  /** Label color on top of primary. */
  onPrimary: string;
  /** Headline ink. */
  ink: string;
  /** Secondary text. */
  muted: string;
  /** Soft tint block. */
  soft: string;
  /** Dark treatment (white ink). */
  dark: boolean;
}

const INK = "#1c1917";
const MUTED = "#78716c";
const PAPER = "#FAFAF7";
const WHITE = "#ffffff";

export const PALETTES: Record<string, Palette> = {
  violetLight: {
    id: "violetLight", label: "Violet light",
    bg: PAPER, card: WHITE, primary: "#7c3aed", onPrimary: WHITE,
    ink: INK, muted: MUTED, soft: "#F5F3FF", dark: false,
  },
  lavender: {
    id: "lavender", label: "Lavender",
    bg: "#F5F3FF", card: WHITE, primary: "#7c3aed", onPrimary: WHITE,
    ink: INK, muted: MUTED, soft: "#ede9fe", dark: false,
  },
  emerald: {
    id: "emerald", label: "Emerald",
    bg: PAPER, card: WHITE, primary: "#059669", onPrimary: WHITE,
    ink: INK, muted: MUTED, soft: "#ecfdf5", dark: false,
  },
  amber: {
    id: "amber", label: "Amber",
    bg: "#FFFBEB", card: WHITE, primary: "#d97706", onPrimary: WHITE,
    ink: INK, muted: MUTED, soft: "#fef3c7", dark: false,
  },
  rose: {
    id: "rose", label: "Rose",
    bg: "#FFF1F2", card: WHITE, primary: "#e11d48", onPrimary: WHITE,
    ink: INK, muted: MUTED, soft: "#ffe4e6", dark: false,
  },
  sky: {
    id: "sky", label: "Sky",
    bg: "#F0F9FF", card: WHITE, primary: "#0284c7", onPrimary: WHITE,
    ink: INK, muted: MUTED, soft: "#e0f2fe", dark: false,
  },
  inkDark: {
    id: "inkDark", label: "Ink dark",
    bg: "#1c1917", card: "#292524", primary: "#8b5cf6", onPrimary: WHITE,
    ink: "#FAFAF7", muted: "#a8a29e", soft: "#292524", dark: true,
  },
  violetBold: {
    id: "violetBold", label: "Violet bold",
    bg: "#6d28d9", card: "#7c3aed", primary: WHITE, onPrimary: "#6d28d9",
    ink: WHITE, muted: "#ede9fe", soft: "#7c3aed", dark: true,
  },
};

export const LIGHT_PALETTES = [
  PALETTES.violetLight, PALETTES.lavender, PALETTES.emerald,
  PALETTES.sky, PALETTES.amber, PALETTES.rose,
];
export const DARK_PALETTES = [PALETTES.inkDark, PALETTES.violetBold];

// ── Sizes (existing 9 formats + new marketing formats) ────────────────────

export interface SizeDef { w: number; h: number }

export const SIZES: Record<string, SizeDef> = {
  "instagram-post": { w: 1080, h: 1080 },
  "instagram-story": { w: 1080, h: 1920 },
  "x-post": { w: 1200, h: 675 },
  "facebook-post": { w: 1200, h: 630 },
  "linkedin-post": { w: 1200, h: 627 },
  "blog-hero": { w: 1200, h: 630 },
  "og-image": { w: 1200, h: 630 },
  "ad-square": { w: 1080, h: 1080 },
  "ad-story": { w: 1080, h: 1920 },
  "email-header": { w: 1200, h: 400 },
  "youtube-thumbnail": { w: 1280, h: 720 },
  "linkedin-banner": { w: 1584, h: 396 },
  "x-header": { w: 1500, h: 500 },
  "facebook-cover": { w: 1640, h: 624 },
  "pinterest-pin": { w: 1000, h: 1500 },
  "tiktok-cover": { w: 1080, h: 1920 },
  "webinar-promo": { w: 1080, h: 1350 },
  "product-launch": { w: 1200, h: 630 },
  "sale-promo": { w: 1080, h: 1080 },
  "testimonial-card": { w: 1080, h: 1080 },
  "quote-card": { w: 1080, h: 1080 },
  "hiring-post": { w: 1200, h: 627 },
  "event-invite": { w: 1080, h: 1350 },
  "newsletter-header": { w: 1200, h: 400 },
  "podcast-cover": { w: 1400, h: 1400 },
  "ebook-cover": { w: 1600, h: 2560 },
  "case-study-card": { w: 1200, h: 630 },
  "stat-card": { w: 1080, h: 1080 },
  "before-after": { w: 1080, h: 1080 },
  "checklist": { w: 1080, h: 1350 },
  "holiday-sale": { w: 1080, h: 1080 },
};

// ── Copy shapes ──────────────────────────────────────────────────────────

export interface CopyStd {
  eyebrow?: string;
  headline: string;
  sub?: string;
  cta?: string;
  brand?: string;
  product?: string;
  productTag?: string;
  smallPrint?: string;
}
export interface CopyQuote { quote: string; author: string; role: string; brand?: string }
export interface CopyTestimonial { quote: string; author: string; role: string; brand?: string }
export interface CopyStat {
  eyebrow?: string; headline: string;
  stats: { value: string; label: string }[];
  cta?: string; brand?: string;
}
export interface CopyChecklist {
  eyebrow?: string; headline: string; items: string[]; cta?: string; brand?: string;
}
export interface CopyBeforeAfter {
  eyebrow?: string; headline: string;
  beforeLabel: string; afterLabel: string;
  before: string[]; after: string[];
  cta?: string; brand?: string;
}

export type CopyShape = "standard" | "quote" | "testimonial" | "stat" | "checklist" | "beforeafter";

// ── Factory context & element makers ─────────────────────────────────────

export interface Ctx {
  key: string;
  w: number;
  h: number;
  pal: Palette;
  seq: number;
}

export function nid(ctx: Ctx): string {
  ctx.seq += 1;
  return `${ctx.key}-e${ctx.seq}`;
}

export const clamp = (v: number, a: number, b: number): number =>
  Math.min(b, Math.max(a, v));

/** Rough average glyph advance; good enough for wrap/overflow sanity checks. */
export function estW(text: string, size: number, bold = false, letterSpacing = 0): number {
  const avg = bold ? 0.6 : 0.54;
  return text.length * size * avg + letterSpacing * Math.max(0, text.length - 1);
}

interface TextOpts {
  text: string; x: number; y: number; size: number; fill: string;
  align?: "left" | "center" | "right";
  bold?: boolean; italic?: boolean; width?: number;
  letterSpacing?: number; lineHeight?: number;
  fragments?: TextElement["fragments"];
  opacity?: number;
}

export function T(ctx: Ctx, name: string, o: TextOpts): TextElement {
  return {
    id: nid(ctx), type: "text", name,
    x: o.x, y: o.y, rotation: 0, opacity: o.opacity ?? 1, visible: true, locked: false,
    text: o.text, fontFamily: "Inter", fontSize: o.size,
    fontStyle: o.bold ? (o.italic ? "bold-italic" : "bold") : o.italic ? "italic" : "normal",
    fill: o.fill, align: o.align ?? "left",
    lineHeight: o.lineHeight ?? 1.25, letterSpacing: o.letterSpacing ?? 0,
    width: o.width, fragments: o.fragments,
  };
}

interface RectOpts {
  x: number; y: number; w: number; h: number; fill: string;
  gradient?: [string, string]; radius?: number; opacity?: number;
  stroke?: string; strokeWidth?: number;
}

export function R(ctx: Ctx, name: string, o: RectOpts): RectElement {
  return {
    id: nid(ctx), type: "rect", name,
    x: o.x, y: o.y, rotation: 0, opacity: o.opacity ?? 1, visible: true, locked: false,
    width: o.w, height: o.h, fill: o.fill,
    gradient: o.gradient, cornerRadius: o.radius ?? 0,
    stroke: o.stroke, strokeWidth: o.strokeWidth,
  };
}

interface EllipseOpts {
  cx: number; cy: number; rx: number; ry: number; fill: string;
  gradient?: [string, string]; opacity?: number;
}

export function E(ctx: Ctx, name: string, o: EllipseOpts): EllipseElement {
  return {
    id: nid(ctx), type: "ellipse", name,
    x: o.cx, y: o.cy, rotation: 0, opacity: o.opacity ?? 1, visible: true, locked: false,
    radiusX: o.rx, radiusY: o.ry, fill: o.fill, gradient: o.gradient,
  };
}

export function LN(ctx: Ctx, name: string, x: number, y: number, points: number[], stroke: string, sw: number): LineElement {
  return {
    id: nid(ctx), type: "line", name,
    x, y, rotation: 0, opacity: 1, visible: true, locked: false,
    points, stroke, strokeWidth: sw,
  };
}

export function SG(ctx: Ctx, name: string, path: string, x: number, y: number, size: number, fill: string): SvgElement {
  return {
    id: nid(ctx), type: "svg", name,
    x, y, rotation: 0, opacity: 1, visible: true, locked: false,
    path, width: size, height: size, fill,
  };
}

// ── Original geometric icons (24×24 viewBox, fill-based) ─────────────────

function starPath(): string {
  const cx = 12, cy = 12, R = 10.6, r = 4.5;
  let d = "";
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? R : r;
    d += `${i === 0 ? "M" : "L"}${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
  }
  return d + "Z";
}

export const ICONS: Record<string, string> = {
  check: "M9.55 15.57 5.7 11.72 4.28 13.14 9.55 18.41 19.72 8.24 18.3 6.82Z",
  star: starPath(),
  arrowRight: "M13 5.5 18.5 12 13 18.5 11.6 17.1 15.7 13H4v-2h11.7L11.6 6.9Z",
  play: "M8 5.5v13l11-6.5Z",
  bolt: "M13.5 2 4.5 13.5h6L9.5 22 19 10h-6.5Z",
};

export const STAR_AMBER = "#f59e0b";

// ── Shared bits ──────────────────────────────────────────────────────────

export function brandMark(ctx: Ctx, cx: number, cy: number, r: number): DesignElement[] {
  const p = ctx.pal;
  return [
    E(ctx, "Decor brand halo", { cx, cy, rx: r * 1.55, ry: r * 1.55, fill: p.primary, opacity: 0.14 }),
    E(ctx, "Brand mark", { cx, cy, rx: r, ry: r, fill: p.primary, gradient: [p.primary, p.primary] }),
  ];
}

/** CTA pill + centered label. Returns [rect, label]; label is vertically centered. */
export function ctaPill(ctx: Ctx, cx: number, y: number, label: string, size: number): DesignElement[] {
  const p = ctx.pal;
  const pillH = clamp(Math.min(ctx.w, ctx.h) * 0.06, 38, 68);
  const pillW = clamp(estW(label, size, true) + size * 3.4, ctx.w * 0.22, ctx.w * 0.56);
  const x = cx - pillW / 2;
  return [
    R(ctx, "CTA pill", { x, y, w: pillW, h: pillH, fill: p.primary, radius: pillH / 2 }),
    T(ctx, "CTA label", {
      text: label, x, y: y + (pillH - size * 1.2) / 2, size, fill: p.onPrimary,
      align: "center", bold: true, width: pillW,
    }),
  ];
}

export function footerBrand(ctx: Ctx, copy: { brand?: string }, y: number, size: number, alignCenter = true): TextElement | null {
  if (!copy.brand) return null;
  const p = ctx.pal;
  return T(ctx, "Footer brand", {
    text: copy.brand, x: alignCenter ? 0 : ctx.w * 0.07, y, size, fill: p.muted,
    align: alignCenter ? "center" : "left", width: alignCenter ? ctx.w : undefined, letterSpacing: 2,
  });
}

export function makeDoc(ctx: Ctx, elements: DesignElement[], bg: string): DesignDocument {
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    pages: [{
      id: `${ctx.key}-p1`, name: "Page 1",
      width: ctx.w, height: ctx.h, background: bg, elements,
    }],
  };
}

// ── Layout families ──────────────────────────────────────────────────────
// Each builder is parameterized by page size: fractions of w/h with clamps,
// cursor-based vertical rhythm so short banners and tall covers both work.
// Element names starting with "Decor " are exempt from bounds sanity checks.

export type AnyCopy = CopyStd | CopyQuote | CopyTestimonial | CopyStat | CopyChecklist | CopyBeforeAfter;

export interface LayoutDef {
  id: string;
  label: string;
  shape: CopyShape;
  dark: boolean;
  build: (ctx: Ctx, copy: AnyCopy) => DesignElement[];
}

type StdBuild = (ctx: Ctx, copy: CopyStd) => DesignElement[];

/** 1 — Centered hero: brand mark, eyebrow, headline, sub, CTA pill, footer. */
const heroCentered: StdBuild = (ctx, c) => {
  const { w, h, pal: p } = ctx;
  const u = Math.min(w, h);
  const els: DesignElement[] = [];
  els.push(
    E(ctx, "Decor blob top", { cx: w * 0.78, cy: h * 0.02, rx: w * 0.3, ry: w * 0.3, fill: p.primary, gradient: [p.primary, p.soft], opacity: 0.16 }),
    E(ctx, "Decor blob bottom", { cx: -w * 0.06, cy: h * 0.86, rx: w * 0.22, ry: w * 0.22, fill: p.primary, gradient: [p.primary, p.soft], opacity: 0.12 }),
  );
  const sE = clamp(u * 0.022, 12, 22);
  const sH = clamp(u * 0.075, 26, 92);
  const sS = clamp(u * 0.027, 14, 30);
  const sC = clamp(u * 0.024, 14, 24);
  const markR = clamp(w * 0.026, 12, 30);
  const headLines = Math.max(1, Math.ceil(estW(c.headline, sH, true) / (w * 0.86)));
  const subLines = c.sub ? Math.max(1, Math.ceil(estW(c.sub, sS) / (w * 0.7))) : 0;
  const pillH = clamp(u * 0.06, 38, 68);
  const gap = u * 0.028;
  const totalH = markR * 2 + gap + sE * 1.4 + gap + sH * 1.12 * headLines + gap
    + (c.sub ? sS * 1.35 * subLines + gap : 0)
    + (c.cta ? pillH + gap : 0);
  let y = h < 620 ? Math.max(h * 0.06, (h - totalH) / 2) : h * 0.09;
  els.push(...brandMark(ctx, w / 2, y + markR, markR));
  y += markR * 2 + gap;
  if (c.eyebrow) {
    els.push(T(ctx, "Eyebrow", { text: c.eyebrow, x: 0, y, size: sE, fill: p.muted, align: "center", bold: true, width: w, letterSpacing: 3 }));
    y += sE * 1.4 + gap;
  }
  els.push(T(ctx, "Headline", { text: c.headline, x: w * 0.07, y, size: sH, fill: p.ink, align: "center", bold: true, width: w * 0.86, lineHeight: 1.12 }));
  y += sH * 1.12 * headLines + gap;
  if (c.sub) {
    els.push(T(ctx, "Subtext", { text: c.sub, x: w * 0.15, y, size: sS, fill: p.muted, align: "center", width: w * 0.7, lineHeight: 1.35 }));
    y += sS * 1.35 * subLines + gap;
  }
  if (c.cta) {
    els.push(...ctaPill(ctx, w / 2, y, c.cta, sC));
    y += pillH + gap;
  }
  if (h >= 480 && y + sE < h * 0.98) {
    const f = footerBrand(ctx, c, h * 0.925, sE);
    if (f) els.push(f);
  }
  return els;
};

/** 2 — Split: left content column, right visual panel (landscape & banners). */
const splitLeft: StdBuild = (ctx, c) => {
  const { w, h, pal: p } = ctx;
  const u = Math.min(w, h);
  const compact = h < 520;
  const els: DesignElement[] = [];
  els.push(
    E(ctx, "Decor blob right", { cx: w * 0.92, cy: h * 0.1, rx: w * 0.2, ry: h * 0.5, fill: p.primary, gradient: [p.primary, p.soft], opacity: 0.14 }),
  );
  const sE = clamp(u * 0.024, 12, 20);
  const sH = compact ? clamp(h * 0.115, 20, 46) : clamp(u * 0.068, 24, 76);
  const sS = clamp(u * 0.026, 13, 26);
  const sC = clamp(u * 0.024, 13, 22);
  const colX = w * 0.07;
  const colW = w * (compact ? 0.56 : 0.5);
  // Accent rule
  els.push(LN(ctx, "Accent rule", colX, h * (compact ? 0.2 : 0.24), [0, 0, 0, h * 0.2], p.primary, compact ? 4 : 6));
  let y = h * (compact ? 0.18 : 0.22);
  if (c.eyebrow) {
    els.push(T(ctx, "Eyebrow", { text: c.eyebrow, x: colX, y, size: sE, fill: p.muted, bold: true, letterSpacing: 3 }));
    y += sE * 1.5 + u * 0.018;
  }
  const headLines = Math.max(1, Math.ceil(estW(c.headline, sH, true) / colW));
  els.push(T(ctx, "Headline", { text: c.headline, x: colX, y, size: sH, fill: p.ink, bold: true, width: colW, lineHeight: 1.12 }));
  y += sH * 1.12 * headLines + u * 0.022;
  if (c.sub && !compact) {
    const subLines = Math.max(1, Math.ceil(estW(c.sub, sS) / (colW * 0.92)));
    els.push(T(ctx, "Subtext", { text: c.sub, x: colX, y, size: sS, fill: p.muted, width: colW * 0.92, lineHeight: 1.35 }));
    y += sS * 1.35 * subLines + u * 0.03;
  } else if (c.sub) {
    els.push(T(ctx, "Subtext", { text: c.sub, x: colX, y, size: sS, fill: p.muted, width: colW * 0.95, lineHeight: 1.3 }));
    y += sS * 1.5 + u * 0.028;
  }
  if (c.cta && y < h * 0.86) els.push(...ctaPill(ctx, colX + clamp(estW(c.cta, sC, true) + sC * 3.4, w * 0.22, w * 0.56) / 2, y, c.cta, sC));
  // Right visual panel
  const px = w * 0.64, pw = w * 0.29, py = h * 0.14, ph = h * 0.72;
  els.push(R(ctx, "Visual panel", { x: px, y: py, w: pw, h: ph, fill: p.soft, radius: Math.min(28, ph * 0.08) }));
  els.push(E(ctx, "Decor panel blob", { cx: px + pw * 0.7, cy: py + ph * 0.3, rx: pw * 0.42, ry: pw * 0.42, fill: p.primary, opacity: 0.16 }));
  const iconSize = Math.min(pw, ph) * 0.34;
  els.push(SG(ctx, "Panel icon", ICONS.bolt, px + pw / 2 - iconSize / 2, py + ph / 2 - iconSize / 2, iconSize, p.primary));
  if (h >= 480) {
    const f = footerBrand(ctx, c, h * 0.9, sE, false);
    if (f) els.push(f);
  }
  return els;
};

/** 3 — Badge top: pill badge, big centered headline, rule, sub, CTA. */
const badgeTop: StdBuild = (ctx, c) => {
  const { w, h, pal: p } = ctx;
  const u = Math.min(w, h);
  const els: DesignElement[] = [];
  els.push(
    E(ctx, "Decor blob left", { cx: w * 0.06, cy: h * 0.08, rx: w * 0.2, ry: w * 0.2, fill: p.primary, gradient: [p.primary, p.soft], opacity: 0.12 }),
  );
  const sE = clamp(u * 0.022, 12, 22);
  const sH = clamp(u * 0.08, 28, 96);
  const sS = clamp(u * 0.027, 14, 30);
  const sC = clamp(u * 0.024, 14, 24);
  const headLines = Math.max(1, Math.ceil(estW(c.headline, sH, true) / (w * 0.86)));
  const subLines = c.sub ? Math.max(1, Math.ceil(estW(c.sub, sS) / (w * 0.7))) : 0;
  const pillH = clamp(u * 0.06, 38, 68);
  const gap = u * 0.03;
  const badgeH = clamp(u * 0.048, 30, 54);
  const totalH = (c.eyebrow ? badgeH + gap : 0) + sH * 1.12 * headLines + gap
    + (c.sub ? sS * 1.35 * subLines + gap : 0) + (c.cta ? pillH : 0);
  let y = h < 620 ? Math.max(h * 0.08, (h - totalH) / 2) : h * 0.12;
  if (c.eyebrow) {
    const bw = estW(c.eyebrow, sE, true, 2) + sE * 3;
    els.push(R(ctx, "Badge", { x: w / 2 - bw / 2, y, w: bw, h: badgeH, fill: p.soft, radius: badgeH / 2 }));
    els.push(T(ctx, "Eyebrow", { text: c.eyebrow, x: w / 2 - bw / 2, y: y + (badgeH - sE * 1.2) / 2, size: sE, fill: p.primary, align: "center", bold: true, width: bw, letterSpacing: 2 }));
    y += badgeH + gap;
  }
  els.push(T(ctx, "Headline", { text: c.headline, x: w * 0.07, y, size: sH, fill: p.ink, align: "center", bold: true, width: w * 0.86, lineHeight: 1.12 }));
  y += sH * 1.12 * headLines + gap * 0.7;
  els.push(LN(ctx, "Headline rule", w / 2 - w * 0.06, y, [0, 0, w * 0.12, 0], p.primary, 5));
  y += gap;
  if (c.sub) {
    els.push(T(ctx, "Subtext", { text: c.sub, x: w * 0.15, y, size: sS, fill: p.muted, align: "center", width: w * 0.7, lineHeight: 1.35 }));
    y += sS * 1.35 * subLines + gap;
  }
  if (c.cta) els.push(...ctaPill(ctx, w / 2, y, c.cta, sC));
  if (h >= 480) {
    const f = footerBrand(ctx, c, h * 0.925, sE);
    if (f) els.push(f);
  }
  return els;
};

/** 4 — Announcement bar: full-width primary band on top, centered content. */
const announcementBar: StdBuild = (ctx, c) => {
  const { w, h, pal: p } = ctx;
  const u = Math.min(w, h);
  const els: DesignElement[] = [];
  const bandH = clamp(h * 0.11, 44, 110);
  const sA = clamp(bandH * 0.3, 13, 26);
  els.push(R(ctx, "Announcement band", { x: 0, y: 0, w, h: bandH, fill: p.primary }));
  if (c.eyebrow) {
    els.push(T(ctx, "Announcement", { text: c.eyebrow, x: 0, y: (bandH - sA * 1.2) / 2, size: sA, fill: p.onPrimary, align: "center", bold: true, width: w, letterSpacing: 3 }));
  }
  const sH = clamp(u * 0.075, 26, 88);
  const sS = clamp(u * 0.027, 14, 30);
  const sC = clamp(u * 0.024, 14, 24);
  const headLines = Math.max(1, Math.ceil(estW(c.headline, sH, true) / (w * 0.86)));
  const subLines = c.sub ? Math.max(1, Math.ceil(estW(c.sub, sS) / (w * 0.7))) : 0;
  const pillH = clamp(u * 0.06, 38, 68);
  const gap = u * 0.03;
  const totalH = sH * 1.12 * headLines + gap + (c.sub ? sS * 1.35 * subLines + gap : 0) + (c.cta ? pillH : 0);
  const availH = h - bandH;
  let y = bandH + (availH < 620 ? Math.max(availH * 0.08, (availH - totalH) / 2) : availH * 0.14);
  els.push(T(ctx, "Headline", { text: c.headline, x: w * 0.07, y, size: sH, fill: p.ink, align: "center", bold: true, width: w * 0.86, lineHeight: 1.12 }));
  y += sH * 1.12 * headLines + gap;
  if (c.sub) {
    els.push(T(ctx, "Subtext", { text: c.sub, x: w * 0.15, y, size: sS, fill: p.muted, align: "center", width: w * 0.7, lineHeight: 1.35 }));
    y += sS * 1.35 * subLines + gap;
  }
  if (c.cta) els.push(...ctaPill(ctx, w / 2, y, c.cta, sC));
  if (h >= 480) {
    const f = footerBrand(ctx, c, h * 0.925, sA);
    if (f) els.push(f);
  }
  return els;
};

/** 5 — Dark bold: dark bg, huge headline with accent word, CTA. (dark palettes only) */
const darkBold: StdBuild = (ctx, c) => {
  const { w, h, pal: p } = ctx;
  const u = Math.min(w, h);
  const els: DesignElement[] = [];
  els.push(
    E(ctx, "Decor glow", { cx: w * 0.5, cy: h * 0.18, rx: w * 0.45, ry: h * 0.3, fill: p.primary, opacity: 0.22 }),
    E(ctx, "Decor blob corner", { cx: w * 1.02, cy: h * 0.95, rx: w * 0.25, ry: w * 0.25, fill: p.primary, opacity: 0.14 }),
  );
  const sE = clamp(u * 0.024, 13, 24);
  const sH = clamp(u * 0.088, 30, 104);
  const sS = clamp(u * 0.028, 14, 32);
  const sC = clamp(u * 0.025, 14, 26);
  // Accent the last word of the headline via fragments.
  const words = c.headline.split(" ");
  const last = words.length > 1 ? words[words.length - 1] : "";
  const rest = words.length > 1 ? words.slice(0, -1).join(" ") + " " : c.headline;
  const fragments = last
    ? [{ text: rest }, { text: last, fill: p.id === "violetBold" ? "#fde68a" : "#a78bfa" }]
    : undefined;
  const headLines = Math.max(1, Math.ceil(estW(c.headline, sH, true) / (w * 0.86)));
  const subLines = c.sub ? Math.max(1, Math.ceil(estW(c.sub, sS) / (w * 0.7))) : 0;
  const pillH = clamp(u * 0.062, 40, 72);
  const gap = u * 0.032;
  const totalH = (c.eyebrow ? sE * 1.4 + gap : 0) + sH * 1.1 * headLines + gap
    + (c.sub ? sS * 1.35 * subLines + gap : 0) + (c.cta ? pillH : 0);
  let y = h < 620 ? Math.max(h * 0.08, (h - totalH) / 2) : h * 0.13;
  if (c.eyebrow) {
    els.push(T(ctx, "Eyebrow", { text: c.eyebrow, x: 0, y, size: sE, fill: p.id === "violetBold" ? "#fde68a" : "#a78bfa", align: "center", bold: true, width: w, letterSpacing: 4 }));
    y += sE * 1.4 + gap;
  }
  els.push(T(ctx, "Headline", { text: c.headline, x: w * 0.07, y, size: sH, fill: p.ink, align: "center", bold: true, width: w * 0.86, lineHeight: 1.1, fragments }));
  y += sH * 1.1 * headLines + gap;
  if (c.sub) {
    els.push(T(ctx, "Subtext", { text: c.sub, x: w * 0.15, y, size: sS, fill: p.muted, align: "center", width: w * 0.7, lineHeight: 1.35 }));
    y += sS * 1.35 * subLines + gap;
  }
  if (c.cta) els.push(...ctaPill(ctx, w / 2, y, c.cta, sC));
  if (h >= 480) {
    const f = footerBrand(ctx, c, h * 0.925, sE);
    if (f) els.push(f);
  }
  return els;
};

/** 6 — Minimal frame: thin inset border, small brand, centered stack, text-button CTA. */
const minimalFrame: StdBuild = (ctx, c) => {
  const { w, h, pal: p } = ctx;
  const u = Math.min(w, h);
  const els: DesignElement[] = [];
  const m = clamp(u * 0.045, 18, 54);
  els.push(R(ctx, "Frame", { x: m, y: m, w: w - 2 * m, h: h - 2 * m, fill: p.bg, radius: 8, stroke: p.primary, strokeWidth: 3 }));
  const sB = clamp(u * 0.02, 11, 18);
  const sE = clamp(u * 0.022, 12, 22);
  const sH = clamp(u * 0.07, 26, 84);
  const sS = clamp(u * 0.027, 14, 30);
  els.push(T(ctx, "Brand", { text: (c.brand ?? "yourbrand.com").toUpperCase(), x: m * 1.8, y: m * 1.8, size: sB, fill: p.ink, bold: true, letterSpacing: 2 }));
  const headLines = Math.max(1, Math.ceil(estW(c.headline, sH, true) / (w * 0.78)));
  const subLines = c.sub ? Math.max(1, Math.ceil(estW(c.sub, sS) / (w * 0.64))) : 0;
  const gap = u * 0.03;
  const totalH = (c.eyebrow ? sE * 1.4 + gap : 0) + sH * 1.12 * headLines + gap
    + (c.sub ? sS * 1.35 * subLines + gap : 0) + (c.cta ? sS * 1.6 : 0);
  let y = (h - totalH) / 2;
  if (c.eyebrow) {
    els.push(T(ctx, "Eyebrow", { text: c.eyebrow, x: 0, y, size: sE, fill: p.primary, align: "center", bold: true, width: w, letterSpacing: 4 }));
    y += sE * 1.4 + gap;
  }
  els.push(T(ctx, "Headline", { text: c.headline, x: w * 0.11, y, size: sH, fill: p.ink, align: "center", bold: true, width: w * 0.78, lineHeight: 1.12 }));
  y += sH * 1.12 * headLines + gap;
  if (c.sub) {
    els.push(T(ctx, "Subtext", { text: c.sub, x: w * 0.18, y, size: sS, fill: p.muted, align: "center", width: w * 0.64, lineHeight: 1.35 }));
    y += sS * 1.35 * subLines + gap;
  }
  if (c.cta) {
    const cw = estW(c.cta, sS, true);
    els.push(T(ctx, "CTA label", { text: c.cta, x: w / 2 - cw / 2, y, size: sS, fill: p.primary, bold: true }));
    els.push(LN(ctx, "CTA underline", w / 2 - cw / 2, y + sS * 1.35, [0, 0, cw, 0], p.primary, 3));
  }
  return els;
};

/** 7 — Product spotlight: content + product card mock (side or stacked). */
const productSpotlight: StdBuild = (ctx, c) => {
  const { w, h, pal: p } = ctx;
  const u = Math.min(w, h);
  const els: DesignElement[] = [];
  const landscape = w >= h * 1.05;
  const sE = clamp(u * 0.022, 12, 20);
  const sH = clamp(u * 0.066, 24, 72);
  const sS = clamp(u * 0.026, 13, 26);
  const sC = clamp(u * 0.024, 13, 22);
  els.push(
    E(ctx, "Decor blob", { cx: w * 0.1, cy: h * 0.9, rx: w * 0.2, ry: w * 0.2, fill: p.primary, gradient: [p.primary, p.soft], opacity: 0.12 }),
  );
  const colX = w * 0.07;
  const colW = landscape ? w * 0.44 : w * 0.86;
  let y = h * (landscape ? 0.2 : 0.09);
  if (c.eyebrow) {
    els.push(T(ctx, "Eyebrow", { text: c.eyebrow, x: colX, y, size: sE, fill: p.primary, bold: true, letterSpacing: 3 }));
    y += sE * 1.5 + u * 0.02;
  }
  const headLines = Math.max(1, Math.ceil(estW(c.headline, sH, true) / colW));
  els.push(T(ctx, "Headline", {
    text: c.headline, x: landscape ? colX : 0, y, size: sH, fill: p.ink,
    align: landscape ? "left" : "center", bold: true, width: colW, lineHeight: 1.12,
  }));
  y += sH * 1.12 * headLines + u * 0.024;
  if (c.sub) {
    const subLines = Math.max(1, Math.ceil(estW(c.sub, sS) / (colW * 0.95)));
    els.push(T(ctx, "Subtext", {
      text: c.sub, x: landscape ? colX : w * 0.07, y, size: sS, fill: p.muted,
      align: landscape ? "left" : "center", width: colW * 0.95, lineHeight: 1.35,
    }));
    y += sS * 1.35 * subLines + u * 0.03;
  }
  if (c.cta) {
    if (landscape) els.push(...ctaPill(ctx, colX + clamp(estW(c.cta, sC, true) + sC * 3.4, w * 0.22, w * 0.56) / 2, y, c.cta, sC));
    else els.push(...ctaPill(ctx, w / 2, y, c.cta, sC));
    y += clamp(u * 0.06, 38, 68) + u * 0.03;
  }
  // Product card
  const cardW = landscape ? w * 0.34 : Math.min(w * 0.72, 560);
  const cardH = landscape ? h * 0.64 : clamp(h - y - h * 0.07, u * 0.3, h * 0.4);
  const cardX = landscape ? w * 0.58 : (w - cardW) / 2;
  const cardY = landscape ? h * 0.18 : y;
  const cr = Math.min(28, cardH * 0.08);
  els.push(R(ctx, "Product card", { x: cardX, y: cardY, w: cardW, h: cardH, fill: p.card, radius: cr, stroke: "#e7e5e4", strokeWidth: 2 }));
  const imgPad = cardW * 0.08;
  const imgH = cardH * 0.58;
  els.push(R(ctx, "Product visual", { x: cardX + imgPad, y: cardY + imgPad, w: cardW - imgPad * 2, h: imgH, fill: p.soft, radius: cr * 0.7 }));
  const iconSize = Math.min(cardW - imgPad * 2, imgH) * 0.4;
  els.push(SG(ctx, "Product icon", ICONS.bolt, cardX + cardW / 2 - iconSize / 2, cardY + imgPad + imgH / 2 - iconSize / 2, iconSize, p.primary));
  const nameSize = clamp(cardW * 0.055, 14, 26);
  els.push(T(ctx, "Product name", {
    text: c.product ?? "Your product", x: cardX + imgPad, y: cardY + imgPad * 2 + imgH,
    size: nameSize, fill: p.ink, bold: true, width: cardW - imgPad * 2,
  }));
  els.push(T(ctx, "Product tag", {
    text: c.productTag ?? "New arrival", x: cardX + imgPad, y: cardY + imgPad * 2 + imgH + nameSize * 1.4,
    size: nameSize * 0.72, fill: p.muted, width: cardW - imgPad * 2,
  }));
  if (h >= 480 && landscape) {
    const f = footerBrand(ctx, c, h * 0.9, sE, false);
    if (f) els.push(f);
  }
  return els;
};

/** 8 — Quote card: giant quote mark, italic quote, author. */
function quoteCard(ctx: Ctx, c: CopyQuote): DesignElement[] {
  const { w, h, pal: p } = ctx;
  const u = Math.min(w, h);
  const els: DesignElement[] = [];
  const sQ = clamp(u * 0.042, 20, 52);
  const sA = clamp(u * 0.026, 14, 30);
  const sR = clamp(u * 0.022, 12, 24);
  const quoteLines = Math.max(1, Math.ceil(estW(c.quote, sQ) / (w * 0.78)));
  const gap = u * 0.035;
  const markSize = clamp(u * 0.28, 110, 300);
  const totalH = sQ * 1.4 * quoteLines + gap + 5 + gap + sA * 1.3 + sR * 1.3;
  let y = (h - totalH) / 2 + markSize * 0.28;
  els.push(T(ctx, "Decor quote mark", { text: "\u201C", x: w * 0.08, y: y - markSize * 0.72, size: markSize, fill: p.primary, opacity: 0.16 }));
  els.push(T(ctx, "Quote", { text: c.quote, x: w * 0.11, y, size: sQ, fill: p.ink, italic: true, width: w * 0.78, lineHeight: 1.4 }));
  y += sQ * 1.4 * quoteLines + gap;
  els.push(LN(ctx, "Divider", w / 2 - w * 0.05, y, [0, 0, w * 0.1, 0], p.primary, 4));
  y += gap;
  els.push(T(ctx, "Author", { text: c.author, x: 0, y, size: sA, fill: p.ink, align: "center", bold: true, width: w }));
  y += sA * 1.3;
  els.push(T(ctx, "Role", { text: c.role, x: 0, y, size: sR, fill: p.muted, align: "center", width: w }));
  if (h >= 480) {
    const f = footerBrand(ctx, c, h * 0.925, sR);
    if (f) els.push(f);
  }
  return els;
}

/** 9 — Testimonial: stars, quote, avatar + name/role on a card. */
function testimonial(ctx: Ctx, c: CopyTestimonial): DesignElement[] {
  const { w, h, pal: p } = ctx;
  const u = Math.min(w, h);
  const els: DesignElement[] = [];
  const m = u * 0.07;
  els.push(R(ctx, "Card", { x: m, y: m, w: w - 2 * m, h: h - 2 * m, fill: "#ffffff", radius: 32, stroke: "#e7e5e4", strokeWidth: 2 }));
  const sQ = clamp(u * 0.034, 18, 42);
  const sA = clamp(u * 0.028, 15, 32);
  const sR = clamp(u * 0.022, 12, 24);
  const starSize = clamp(u * 0.038, 22, 44);
  const avatarR = clamp(u * 0.05, 30, 58);
  const quoteLines = Math.max(1, Math.ceil(estW(c.quote, sQ) / (w * 0.72)));
  const gap = u * 0.032;
  const totalH = starSize + gap + sQ * 1.4 * quoteLines + gap + avatarR * 2 + gap * 0.6 + sA * 1.3 + sR * 1.3;
  let y = m + (h - 2 * m - totalH) / 2;
  const rowW = starSize * 5 + starSize * 0.5 * 4;
  for (let i = 0; i < 5; i++) {
    els.push(SG(ctx, `Star ${i + 1}`, ICONS.star, w / 2 - rowW / 2 + i * starSize * 1.5, y, starSize, STAR_AMBER));
  }
  y += starSize + gap;
  els.push(T(ctx, "Quote", { text: `\u201C${c.quote}\u201D`, x: w * 0.14, y, size: sQ, fill: p.ink, align: "center", width: w * 0.72, lineHeight: 1.4 }));
  y += sQ * 1.4 * quoteLines + gap;
  els.push(E(ctx, "Avatar", { cx: w / 2, cy: y + avatarR, rx: avatarR, ry: avatarR, fill: p.primary, gradient: [p.primary, p.soft] }));
  const initials = c.author.split(" ").map((s) => s[0]).join("").slice(0, 2).toUpperCase();
  els.push(T(ctx, "Initials", { text: initials, x: w / 2 - avatarR, y: y + avatarR - sA * 0.62, size: sA, fill: "#ffffff", align: "center", bold: true, width: avatarR * 2 }));
  y += avatarR * 2 + gap * 0.6;
  els.push(T(ctx, "Author", { text: c.author, x: 0, y, size: sA, fill: p.ink, align: "center", bold: true, width: w }));
  y += sA * 1.3;
  els.push(T(ctx, "Role", { text: c.role, x: 0, y, size: sR, fill: p.muted, align: "center", width: w }));
  return els;
}

/** 10 — Stat row: eyebrow, headline, 3 stats with dividers, CTA. */
function statRow(ctx: Ctx, c: CopyStat): DesignElement[] {
  const { w, h, pal: p } = ctx;
  const u = Math.min(w, h);
  const els: DesignElement[] = [];
  const portrait = h > w * 1.15;
  const sE = clamp(u * 0.022, 12, 22);
  const sH = clamp(u * 0.058, 24, 68);
  const sV = clamp(u * 0.068, 30, 80);
  const sL = clamp(u * 0.022, 12, 22);
  const sC = clamp(u * 0.024, 14, 24);
  const gap = u * 0.035;
  const headLines = Math.max(1, Math.ceil(estW(c.headline, sH, true) / (w * 0.84)));
  const pillH = clamp(u * 0.06, 38, 68);
  const statBlockH = portrait ? sV * 1.2 + sL * 1.4 + gap : sV * 1.2 + sL * 1.4;
  const totalH = (c.eyebrow ? sE * 1.4 + gap : 0) + sH * 1.12 * headLines + gap
    + statBlockH * 3 + (c.cta ? gap + pillH : 0);
  let y = h < 700 ? Math.max(h * 0.07, (h - totalH) / 2) : h * 0.1;
  if (c.eyebrow) {
    els.push(T(ctx, "Eyebrow", { text: c.eyebrow, x: 0, y, size: sE, fill: p.muted, align: "center", bold: true, width: w, letterSpacing: 3 }));
    y += sE * 1.4 + gap;
  }
  els.push(T(ctx, "Headline", { text: c.headline, x: w * 0.08, y, size: sH, fill: p.ink, align: "center", bold: true, width: w * 0.84, lineHeight: 1.12 }));
  y += sH * 1.12 * headLines + gap;
  if (portrait) {
    const rowH = sV * 1.2 + sL * 1.4 + gap * 0.8;
    c.stats.slice(0, 3).forEach((s, i) => {
      els.push(T(ctx, `Stat value ${i + 1}`, { text: s.value, x: 0, y, size: sV, fill: p.primary, align: "center", bold: true, width: w }));
      els.push(T(ctx, `Stat label ${i + 1}`, { text: s.label.toUpperCase(), x: 0, y: y + sV * 1.2, size: sL, fill: p.muted, align: "center", width: w, letterSpacing: 2 }));
      y += rowH;
      if (i < 2) els.push(LN(ctx, `Divider ${i + 1}`, w * 0.3, y - gap * 0.35, [0, 0, w * 0.4, 0], "#e7e5e4", 2));
    });
  } else {
    const colW = w * 0.26;
    const startX = (w - colW * 3) / 2;
    const top = y;
    c.stats.slice(0, 3).forEach((s, i) => {
      const cx = startX + colW * i;
      els.push(T(ctx, `Stat value ${i + 1}`, { text: s.value, x: cx, y: top, size: sV, fill: p.primary, align: "center", bold: true, width: colW }));
      els.push(T(ctx, `Stat label ${i + 1}`, { text: s.label.toUpperCase(), x: cx, y: top + sV * 1.2, size: sL, fill: p.muted, align: "center", width: colW, letterSpacing: 2 }));
      if (i < 2) els.push(LN(ctx, `Divider ${i + 1}`, cx + colW, top + sV * 0.1, [0, 0, 0, sV * 1.1], "#e7e5e4", 2));
    });
    y += statBlockH;
  }
  if (c.cta && y + pillH < h * 0.96) els.push(...ctaPill(ctx, w / 2, y + gap * 0.4, c.cta, sC));
  return els;
}

/** 11 — Checklist: eyebrow, headline, check rows, CTA. (portrait-friendly) */
function checklist(ctx: Ctx, c: CopyChecklist): DesignElement[] {
  const { w, h, pal: p } = ctx;
  const u = Math.min(w, h);
  const els: DesignElement[] = [];
  els.push(
    E(ctx, "Decor blob", { cx: w * 0.9, cy: h * 0.06, rx: w * 0.24, ry: w * 0.24, fill: p.primary, gradient: [p.primary, p.soft], opacity: 0.12 }),
  );
  const sE = clamp(u * 0.022, 12, 22);
  const sH = clamp(u * 0.062, 26, 72);
  const sI = clamp(u * 0.03, 16, 34);
  const sC = clamp(u * 0.024, 14, 24);
  const gap = u * 0.03;
  const headLines = Math.max(1, Math.ceil(estW(c.headline, sH, true) / (w * 0.84)));
  const checkR = sI * 0.62;
  const items = c.items.slice(0, 4);
  const rowH = Math.max(checkR * 2 + 10, sI * 1.5) + gap * 0.9;
  const pillH = clamp(u * 0.06, 38, 68);
  const totalH = (c.eyebrow ? sE * 1.4 + gap : 0) + sH * 1.12 * headLines + gap + rowH * items.length + (c.cta ? gap + pillH : 0);
  let y = Math.max(h * 0.07, (h - totalH) / 2);
  if (c.eyebrow) {
    els.push(T(ctx, "Eyebrow", { text: c.eyebrow, x: w * 0.09, y, size: sE, fill: p.primary, bold: true, letterSpacing: 3 }));
    y += sE * 1.4 + gap;
  }
  els.push(T(ctx, "Headline", { text: c.headline, x: w * 0.08, y, size: sH, fill: p.ink, bold: true, width: w * 0.84, lineHeight: 1.12 }));
  y += sH * 1.12 * headLines + gap;
  const listX = w * 0.09;
  const textX = listX + checkR * 2 + sI * 0.6;
  items.forEach((item, i) => {
    const cy = y + rowH * i + rowH / 2 - gap * 0.45;
    els.push(E(ctx, `Check circle ${i + 1}`, { cx: listX + checkR, cy, rx: checkR, ry: checkR, fill: p.soft }));
    const iconS = checkR * 1.05;
    els.push(SG(ctx, `Check ${i + 1}`, ICONS.check, listX + checkR - iconS / 2, cy - iconS / 2, iconS, p.primary));
    els.push(T(ctx, `Item ${i + 1}`, { text: item, x: textX, y: cy - sI * 0.62, size: sI, fill: p.ink, width: w - textX - w * 0.08, lineHeight: 1.3 }));
  });
  y += rowH * items.length;
  if (c.cta && y + pillH < h * 0.97) els.push(...ctaPill(ctx, w / 2, y + gap * 0.5, c.cta, sC));
  return els;
}

/** 12 — Before/after: two cards + VS badge + headline + CTA. */
function beforeAfter(ctx: Ctx, c: CopyBeforeAfter): DesignElement[] {
  const { w, h, pal: p } = ctx;
  const u = Math.min(w, h);
  const els: DesignElement[] = [];
  const portrait = h > w * 1.15;
  const sE = clamp(u * 0.022, 12, 22);
  const sH = clamp(u * 0.06, 26, 70);
  const sL = clamp(u * 0.024, 13, 24);
  const sI = clamp(u * 0.026, 14, 28);
  const sC = clamp(u * 0.024, 14, 24);
  const gap = u * 0.032;
  const headLines = Math.max(1, Math.ceil(estW(c.headline, sH, true) / (w * 0.84)));
  const pillH = clamp(u * 0.06, 38, 68);
  const cardGap = w * 0.04;
  const cardW = portrait ? w * 0.82 : (w * 0.86 - cardGap) / 2;
  const cardH = sL * 1.6 + 3 * (sI * 1.45) + u * 0.05;
  const totalH = (c.eyebrow ? sE * 1.4 + gap : 0) + sH * 1.12 * headLines + gap
    + (portrait ? cardH * 2 + cardGap : cardH) + gap + (c.cta ? pillH : 0);
  let y = Math.max(h * 0.06, (h - totalH) / 2);
  if (c.eyebrow) {
    els.push(T(ctx, "Eyebrow", { text: c.eyebrow, x: 0, y, size: sE, fill: p.muted, align: "center", bold: true, width: w, letterSpacing: 3 }));
    y += sE * 1.4 + gap;
  }
  els.push(T(ctx, "Headline", { text: c.headline, x: w * 0.08, y, size: sH, fill: p.ink, align: "center", bold: true, width: w * 0.84, lineHeight: 1.12 }));
  y += sH * 1.12 * headLines + gap;
  const drawCard = (x: number, cy: number, label: string, items: string[], good: boolean) => {
    els.push(R(ctx, `${label} card`, {
      x, y: cy, w: cardW, h: cardH, fill: good ? p.soft : "#f5f5f4", radius: 20, stroke: "#e7e5e4", strokeWidth: 2,
    }));
    els.push(T(ctx, `${label} label`, {
      text: label.toUpperCase(), x: x + u * 0.03, y: cy + u * 0.028, size: sL,
      fill: good ? p.primary : p.muted, bold: true, letterSpacing: 2,
    }));
    items.slice(0, 3).forEach((it, i) => {
      const iy = cy + u * 0.028 + sL * 1.6 + i * sI * 1.45;
      els.push(E(ctx, `${label} dot ${i + 1}`, { cx: x + u * 0.035, cy: iy + sI * 0.45, rx: sI * 0.16, ry: sI * 0.16, fill: good ? p.primary : "#a8a29e" }));
      els.push(T(ctx, `${label} item ${i + 1}`, { text: it, x: x + u * 0.062, y: iy, size: sI, fill: good ? p.ink : p.muted, width: cardW - u * 0.1, lineHeight: 1.3 }));
    });
  };
  if (portrait) {
    const x = (w - cardW) / 2;
    drawCard(x, y, c.beforeLabel || "Before", c.before, false);
    y += cardH + cardGap / 2;
    const badgeR = clamp(u * 0.045, 24, 44);
    els.push(E(ctx, "VS badge", { cx: w / 2, cy: y, rx: badgeR, ry: badgeR, fill: p.primary }));
    els.push(T(ctx, "VS", { text: "VS", x: w / 2 - badgeR, y: y - sL * 0.6, size: sL, fill: "#ffffff", align: "center", bold: true, width: badgeR * 2 }));
    y += cardGap / 2;
    drawCard(x, y, c.afterLabel || "After", c.after, true);
    y += cardH + gap;
  } else {
    const x0 = (w - cardW * 2 - cardGap) / 2;
    drawCard(x0, y, c.beforeLabel || "Before", c.before, false);
    drawCard(x0 + cardW + cardGap, y, c.afterLabel || "After", c.after, true);
    const badgeR = clamp(u * 0.04, 22, 40);
    els.push(E(ctx, "VS badge", { cx: w / 2, cy: y + cardH / 2, rx: badgeR, ry: badgeR, fill: p.primary }));
    els.push(T(ctx, "VS", { text: "VS", x: w / 2 - badgeR, y: y + cardH / 2 - sL * 0.6, size: sL, fill: "#ffffff", align: "center", bold: true, width: badgeR * 2 }));
    y += cardH + gap;
  }
  if (c.cta && y + pillH < h * 0.98) els.push(...ctaPill(ctx, w / 2, y, c.cta, sC));
  return els;
}

/** 13 — Sale burst: giant discount value, concentric burst, urgency, CTA. */
const saleBurst: StdBuild = (ctx, c) => {
  const { w, h, pal: p } = ctx;
  const u = Math.min(w, h);
  const els: DesignElement[] = [];
  const cx = w / 2;
  const sV = clamp(u * 0.13, 64, 168);
  const sE = clamp(u * 0.026, 14, 28);
  const sS = clamp(u * 0.028, 14, 32);
  const sC = clamp(u * 0.026, 15, 28);
  const sP = clamp(u * 0.018, 11, 18);
  const gap = u * 0.03;
  const valLines = Math.max(1, Math.ceil(estW(c.headline, sV, true) / (w * 0.9)));
  const subLines = c.sub ? Math.max(1, Math.ceil(estW(c.sub, sS) / (w * 0.7))) : 0;
  const pillH = clamp(u * 0.064, 42, 74);
  const totalH = sE * 1.4 + gap + sV * 1.05 * valLines + gap + (c.sub ? sS * 1.35 * subLines + gap : 0) + (c.cta ? pillH + gap * 0.6 : 0) + (c.smallPrint ? sP * 1.3 : 0);
  const cy = h / 2;
  const burstR = Math.min(w, totalH) * 0.62;
  els.push(E(ctx, "Decor burst outer", { cx, cy, rx: burstR, ry: burstR, fill: p.primary, opacity: 0.12 }));
  els.push(E(ctx, "Decor burst mid", { cx, cy, rx: burstR * 0.72, ry: burstR * 0.72, fill: p.primary, opacity: 0.12 }));
  els.push(E(ctx, "Decor burst inner", { cx, cy, rx: burstR * 0.46, ry: burstR * 0.46, fill: p.soft, opacity: 0.9 }));
  let y = cy - totalH / 2;
  if (c.eyebrow) {
    els.push(T(ctx, "Eyebrow", { text: c.eyebrow, x: 0, y, size: sE, fill: p.primary, align: "center", bold: true, width: w, letterSpacing: 4 }));
    y += sE * 1.4 + gap;
  }
  els.push(T(ctx, "Headline", { text: c.headline, x: w * 0.05, y, size: sV, fill: p.primary, align: "center", bold: true, width: w * 0.9, lineHeight: 1.05 }));
  y += sV * 1.05 * valLines + gap;
  if (c.sub) {
    els.push(T(ctx, "Subtext", { text: c.sub, x: w * 0.15, y, size: sS, fill: p.ink, align: "center", bold: true, width: w * 0.7, lineHeight: 1.3 }));
    y += sS * 1.35 * subLines + gap;
  }
  if (c.cta) {
    els.push(...ctaPill(ctx, cx, y, c.cta, sC));
    y += pillH + gap * 0.6;
  }
  if (c.smallPrint) {
    els.push(T(ctx, "Fine print", { text: c.smallPrint, x: 0, y, size: sP, fill: p.muted, align: "center", width: w }));
  }
  return els;
};

// ── Registry ─────────────────────────────────────────────────────────────

export const LAYOUTS: Record<string, LayoutDef> = {
  heroCentered: { id: "heroCentered", label: "Hero centered", shape: "standard", dark: false, build: (ctx, c) => heroCentered(ctx, c as CopyStd) },
  splitLeft: { id: "splitLeft", label: "Split", shape: "standard", dark: false, build: (ctx, c) => splitLeft(ctx, c as CopyStd) },
  badgeTop: { id: "badgeTop", label: "Badge top", shape: "standard", dark: false, build: (ctx, c) => badgeTop(ctx, c as CopyStd) },
  announcementBar: { id: "announcementBar", label: "Announcement bar", shape: "standard", dark: false, build: (ctx, c) => announcementBar(ctx, c as CopyStd) },
  darkBold: { id: "darkBold", label: "Dark bold", shape: "standard", dark: true, build: (ctx, c) => darkBold(ctx, c as CopyStd) },
  minimalFrame: { id: "minimalFrame", label: "Minimal frame", shape: "standard", dark: false, build: (ctx, c) => minimalFrame(ctx, c as CopyStd) },
  productSpotlight: { id: "productSpotlight", label: "Product spotlight", shape: "standard", dark: false, build: (ctx, c) => productSpotlight(ctx, c as CopyStd) },
  quoteCard: { id: "quoteCard", label: "Quote card", shape: "quote", dark: false, build: (ctx, c) => quoteCard(ctx, c as CopyQuote) },
  testimonial: { id: "testimonial", label: "Testimonial", shape: "testimonial", dark: false, build: (ctx, c) => testimonial(ctx, c as CopyTestimonial) },
  statRow: { id: "statRow", label: "Stat row", shape: "stat", dark: false, build: (ctx, c) => statRow(ctx, c as CopyStat) },
  checklist: { id: "checklist", label: "Checklist", shape: "checklist", dark: false, build: (ctx, c) => checklist(ctx, c as CopyChecklist) },
  beforeAfter: { id: "beforeAfter", label: "Before / after", shape: "beforeafter", dark: false, build: (ctx, c) => beforeAfter(ctx, c as CopyBeforeAfter) },
  saleBurst: { id: "saleBurst", label: "Sale burst", shape: "standard", dark: false, build: (ctx, c) => saleBurst(ctx, c as CopyStd) },
};
