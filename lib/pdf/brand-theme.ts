// Marketr — BrandKit → pdfcn theme mapping (milestone 12).
//
// White-labeling is "which brand kit + which template": a BrandKit's colors
// and fonts override the pdfcn `professional` theme preset, and the result
// feeds PdfcnThemeProvider when rendering a report.

import { professionalTheme } from "@/components/pdf/theme-professional";
import type { PdfcnTheme } from "@/components/pdf/theme-types";

export interface BrandColors {
  primary?: string;
  secondary?: string;
  accent?: string;
  text?: string;
  muted?: string;
}

export interface BrandFonts {
  heading?: string;
  body?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function brandColorsOf(colors: unknown): BrandColors {
  const c = asRecord(colors);
  return {
    primary: asString(c.primary),
    secondary: asString(c.secondary),
    accent: asString(c.accent),
    text: asString(c.text),
    muted: asString(c.muted),
  };
}

export function brandFontsOf(fonts: unknown): BrandFonts {
  const f = asRecord(fonts);
  return { heading: asString(f.heading), body: asString(f.body) };
}

/**
 * Build a pdfcn theme from a brand kit's colors/fonts, layered over the
 * professional preset. Unknown/missing tokens fall back to the preset.
 */
export function brandKitTheme(input: {
  colors?: unknown;
  fonts?: unknown;
}): PdfcnTheme {
  const colors = brandColorsOf(input.colors);
  const fonts = brandFontsOf(input.fonts);

  return {
    ...professionalTheme,
    colors: {
      ...professionalTheme.colors,
      ...(colors.primary ? { primary: colors.primary } : {}),
      ...(colors.accent ? { accent: colors.accent } : {}),
      ...(colors.text ? { foreground: colors.text } : {}),
      ...(colors.muted ? { muted: colors.muted } : {}),
      ...(colors.secondary ? { secondary: colors.secondary } : {}),
    },
    typography: {
      ...professionalTheme.typography,
      body: {
        ...professionalTheme.typography.body,
        ...(fonts.body ? { fontFamily: fonts.body } : {}),
      },
      heading: {
        ...professionalTheme.typography.heading,
        ...(fonts.heading ? { fontFamily: fonts.heading } : {}),
      },
    },
  };
}

/** Default Marketr brand kit values (used by the seed + fallback kit). */
export const DEFAULT_BRAND_COLORS: Required<BrandColors> = {
  primary: "#18181b",
  secondary: "#3f3f46",
  accent: "#f97316",
  text: "#18181b",
  muted: "#71717a",
};

export const DEFAULT_BRAND_FONTS: Required<BrandFonts> = {
  heading: "Helvetica-Bold",
  body: "Helvetica",
};
