// Marketr — Phase 11 "Canvas": Colormind palette generation.
//
// STATUS (2026-09-27, license verification): FAIL CLOSED — DO NOT ENABLE.
// Colormind's own API docs (http://colormind.io/api-access/, fetched
// 2026-09-27) state: "The API is free for personal and non-commercial use.
// If you're looking to use it in a commercial application, get in touch by
// email: jack@colormind.io". Marketr ships a commercial tier, so calling the
// live API without a written commercial agreement would violate the
// operator's stated terms. The integration is implemented but hard-disabled:
// the UI shows the feature as unavailable with this honest note, and the
// server route returns 503 without ever hitting colormind.io.
//
// What to do to ship it later: reach a written commercial agreement with the
// Colormind operator, then flip COLORMIND_ENABLED to true and wire
// meter("colormind_palette", ...) per tenant in the route before the fetch.
//
// This module keeps the request-shaping and response-parsing logic pure and
// unit-tested so the day it is legally cleared the only delta is the flag.

/** Hard kill-switch. Keep false until a written commercial agreement exists. */
export const COLORMIND_ENABLED = false;

/** Honest user-facing reason shown wherever the feature is surfaced. */
export const COLORMIND_DISABLED_REASON =
  "Palette generation is off: Colormind's free API is licensed for personal, non-commercial use only — " +
  "commercial use requires a written agreement with its operator (jack@colormind.io). " +
  "Until that agreement is in place, this button stays off. Your brand colors below still work as usual.";

export const COLORMIND_API_BASE = "http://colormind.io/api/";
export const COLORMIND_LIST_URL = "http://colormind.io/list/";

/** Status shape consumed by the Brand panel (mirrors other provider statuses). */
export function colormindStatus() {
  return {
    name: "colormind" as const,
    enabled: COLORMIND_ENABLED,
    reason: COLORMIND_ENABLED ? null : COLORMIND_DISABLED_REASON,
  };
}

/** One palette slot: an RGB triple, or "N" for "let Colormind fill this in". */
export type PaletteSlot = [number, number, number] | "N";

export interface ColormindRequest {
  model: string;
  input: [PaletteSlot, PaletteSlot, PaletteSlot, PaletteSlot, PaletteSlot];
}

export class ColormindRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ColormindRequestError";
  }
}

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

/**
 * Normalize one hex color ("#7c3aed" or "7c3aed") to an [r, g, b] triple.
 * Throws ColormindRequestError on anything that isn't a 6-digit hex color.
 */
export function hexToRgb(hex: string): [number, number, number] {
  const m = HEX_RE.exec(hex.trim());
  if (!m) throw new ColormindRequestError(`Not a valid hex color: "${hex}".`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Format an [r, g, b] triple as a lowercase "#rrggbb" hex string. */
export function rgbToHex(rgb: readonly [number, number, number]): string {
  const [r, g, b] = rgb;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (
    "#" +
    [clamp(r), clamp(g), clamp(b)]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Build the Colormind API payload: lock the brand color in slot 1, leave the
 * other four slots as "N" so the model harmonizes around it.
 *
 * The task's brief shape is POST {input: [5 colors or "N" placeholders],
 * model?} — slots accept a hex string (converted here to the API's RGB
 * triple) or exactly "N". Slots beyond the first are not supported yet.
 */
export function buildPaletteRequest(brandColor: string, model = "default"): ColormindRequest {
  if (!brandColor || typeof brandColor !== "string" || !brandColor.trim()) {
    throw new ColormindRequestError("A brand color is required to seed the palette.");
  }
  if (!model.trim()) throw new ColormindRequestError("Model name must not be blank.");
  return {
    model: model.trim(),
    input: [hexToRgb(brandColor), "N", "N", "N", "N"],
  };
}

function isRgbTriple(v: unknown): v is [number, number, number] {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 255)
  );
}

/**
 * Parse a Colormind API response ({result: [[r,g,b] x 5]}) into hex colors.
 * Throws ColormindRequestError when the shape is wrong — the caller maps it
 * to a 502 so a weird upstream payload never silently becomes a palette.
 */
export function parsePaletteResponse(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) {
    throw new ColormindRequestError("Colormind returned an empty or malformed response.");
  }
  const result = (raw as Record<string, unknown>).result;
  if (!Array.isArray(result) || result.length !== 5 || !result.every(isRgbTriple)) {
    throw new ColormindRequestError("Colormind response did not contain a 5-color palette.");
  }
  return result.map((rgb) => rgbToHex(rgb as [number, number, number]));
}

/**
 * The live call. Never invoked while COLORMIND_ENABLED is false — the route
 * refuses before reaching this. Kept here (not in the route) so the flag,
 * shaping, parsing, and fetch stay in one testable module. `fetchImpl` is
 * injectable for tests.
 */
export async function fetchColormindPalette(
  brandColor: string,
  model: string | undefined,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<string[]> {
  if (!COLORMIND_ENABLED) {
    throw new ColormindRequestError("Colormind integration is disabled (commercial terms not cleared).");
  }
  const body = buildPaletteRequest(brandColor, model ?? "default");
  let res: Response;
  try {
    res = await fetchImpl(COLORMIND_API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ColormindRequestError("Could not reach Colormind.");
  }
  if (!res.ok) {
    throw new ColormindRequestError(`Colormind request failed with HTTP ${res.status}.`);
  }
  return parsePaletteResponse(await res.json());
}
