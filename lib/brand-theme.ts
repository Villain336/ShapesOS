// Marketr — brand theming (Phase 13 Wave A, Tico 2026-09-27 amendment).
//
// The locked static violet primary is now a dynamic brand color: each
// workspace's DEFAULT brand kit (Settings → Brand kits) drives the CSS
// variables --brand-600 / --brand-700 / --brand-50 at runtime, scoped to the
// dashboard theme root (components/BrandTheme.tsx). No-brand → the violet
// defaults in app/globals.css, so nothing visually changes by default.
//
// This module is the ONLY writer of the brand vars. Law: docs/audit/THEMING.md

/** Today's violet-600 — the default primary when no brand color is set. */
export const DEFAULT_BRAND_PRIMARY = "#7c3aed";

/** Window event the brand-kits editor dispatches for live preview. */
export const BRAND_PREVIEW_EVENT = "marketr:brand-preview";

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Accept only #rgb / #rrggbb hex — anything else falls back to default violet. */
export function sanitizeBrandHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return HEX_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * CSS var overrides for a brand primary. The user picks ONE color; the hover
 * (700) and soft tint (50) auto-derive from it via color-mix so nobody ever
 * picks three colors:
 * - 700 = 80% of the primary mixed toward black (hover/active darkening)
 * - 50  = 7.6% of the primary mixed toward white — reproduces violet-50
 *         (#f5f3ff) exactly when the primary is the default violet, so the
 *         default theme is byte-identical to the old lock.
 */
export function brandThemeVars(primary: string): Record<string, string> {
  return {
    "--brand-600": primary,
    "--brand-700": `color-mix(in srgb, ${primary} 80%, black)`,
    "--brand-50": `color-mix(in srgb, ${primary} 7.6%, white)`,
  };
}

/**
 * Apply (or clear, with null/invalid) the brand vars on an element.
 * Tenancy: call this on the per-workspace theme root so a brand color can
 * never leak across workspaces.
 */
export function applyBrandTheme(el: HTMLElement, primary: string | null): void {
  const clean = sanitizeBrandHex(primary);
  if (!clean) {
    el.style.removeProperty("--brand-600");
    el.style.removeProperty("--brand-700");
    el.style.removeProperty("--brand-50");
    return;
  }
  const vars = brandThemeVars(clean);
  for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value);
}

/**
 * Live preview: broadcast a primary color to the dashboard theme root (see
 * components/BrandTheme.tsx). The brand-kits editor calls this on every
 * picker change so the user sees the UI re-tint BEFORE saving. Pass null to
 * clear the preview and revert to the workspace's saved brand.
 */
export function previewBrandTheme(primary: string | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<string | null>(BRAND_PREVIEW_EVENT, { detail: sanitizeBrandHex(primary) }),
  );
}
