// Marketr — Phase 16 slice 9: branded report engine — brand-kit → CSS.
//
// The whole point of the proof (~/workspace/biz-os/report-engine-proof): every
// brand decision lives in a `:root` block, so a tenant's brand kit restyles the
// report by overriding that block alone. This module builds that override
// block from the stored BrandKit (or the dynamic-theming default violet when
// no brand is set — Tico's locked theming law, 2026-09-27).

/** Colors as stored on BrandKit.colors (hex strings, milestone 12). */
export interface BrandKitColors {
  primary?: string;
  secondary?: string;
  accent?: string;
  text?: string;
  muted?: string;
}

export interface BrandKitFonts {
  heading?: string;
  body?: string;
}

export interface ReportBrandKitInput {
  name?: string | null;
  logoPath?: string | null;
  colors?: BrandKitColors | null;
  fonts?: BrandKitFonts | null;
}

/** Dynamic-theming default: inspiring violet (Tico-locked). */
export const DEFAULT_REPORT_BRAND = {
  primary: "#7c3aed",
  primaryDeep: "#2e1065",
  primaryMid: "#6d28d9",
  tint: "#ede9fe",
  tintSoft: "#f5f3ff",
  ink: "#1c1917",
  muted: "#78716c",
  rule: "#ddd6fe",
  fontBody: '"Noto Sans", "DejaVu Sans", sans-serif',
  fontDisplay: '"Noto Serif", "DejaVu Serif", serif',
} as const;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Tint derivation: append a low alpha to the hex (light wash of primary). */
function tintOf(hex: string): string {
  return `${hex}1f`;
}

function pickColor(value: string | undefined, fallback: string): string {
  return value && HEX.test(value.trim()) ? value.trim() : fallback;
}

function pickFont(value: string | undefined, fallback: string): string {
  const v = value?.trim();
  // No quotes in font-family names from the kit (injection safety for CSS).
  if (!v || /["';{}]/.test(v)) return fallback;
  return `"${v}", ${fallback}`;
}

/**
 * Build the `:root` override block that the render service injects AFTER the
 * template's own stylesheet, so the tenant brand kit wins every token.
 * Returns "" when the input is the default anyway (no-op).
 */
export function buildBrandOverrideCss(kit: ReportBrandKitInput | null | undefined): string {
  const colors = kit?.colors ?? {};
  const fonts = kit?.fonts ?? {};
  const primary = pickColor(colors.primary, DEFAULT_REPORT_BRAND.primary);
  const primaryDeep = pickColor(colors.secondary, DEFAULT_REPORT_BRAND.primaryDeep);
  const primaryMid = primaryDeep === DEFAULT_REPORT_BRAND.primaryDeep ? DEFAULT_REPORT_BRAND.primaryMid : primaryDeep;
  const ink = pickColor(colors.text, DEFAULT_REPORT_BRAND.ink);
  const muted = pickColor(colors.muted, DEFAULT_REPORT_BRAND.muted);

  const wordmark = (kit?.name ?? "").trim().toUpperCase().replace(/["'\\;{}]/g, "").slice(0, 40);

  const lines = [
    ":root {",
    `  --brand-primary: ${primary};`,
    `  --brand-primary-deep: ${primaryDeep};`,
    `  --brand-primary-mid: ${primaryMid};`,
    `  --brand-tint: ${tintOf(primary)};`,
    `  --brand-tint-soft: ${pickColor(colors.accent, DEFAULT_REPORT_BRAND.tintSoft)};`,
    `  --brand-ink: ${ink};`,
    `  --brand-muted: ${muted};`,
    `  --brand-rule: ${DEFAULT_REPORT_BRAND.rule};`,
    `  --brand-font-body: ${pickFont(fonts.body, DEFAULT_REPORT_BRAND.fontBody)};`,
    `  --brand-font-display: ${pickFont(fonts.heading, DEFAULT_REPORT_BRAND.fontDisplay)};`,
    wordmark ? `  --brand-wordmark: "${wordmark}";` : `  --brand-wordmark: "MARKETR";`,
    `  --brand-tagline: "REPORT";`,
    "}",
  ];
  return lines.join("\n");
}

/**
 * Resolve a stored Prisma BrandKit row (JSON colors/fonts) into the
 * ReportBrandKitInput this module needs. Unknown shapes fall back to nulls.
 */
export function brandKitRowToInput(row: {
  name?: string | null;
  logoPath?: string | null;
  colors?: unknown;
  fonts?: unknown;
}): ReportBrandKitInput {
  const colors = (row.colors ?? {}) as BrandKitColors;
  const fonts = (row.fonts ?? {}) as BrandKitFonts;
  return {
    name: row.name ?? null,
    logoPath: row.logoPath ?? null,
    colors: {
      primary: typeof colors.primary === "string" ? colors.primary : undefined,
      secondary: typeof colors.secondary === "string" ? colors.secondary : undefined,
      accent: typeof colors.accent === "string" ? colors.accent : undefined,
      text: typeof colors.text === "string" ? colors.text : undefined,
      muted: typeof colors.muted === "string" ? colors.muted : undefined,
    },
    fonts: {
      heading: typeof fonts.heading === "string" ? fonts.heading : undefined,
      body: typeof fonts.body === "string" ? fonts.body : undefined,
    },
  };
}
