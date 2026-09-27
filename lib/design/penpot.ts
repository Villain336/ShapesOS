// Marketr — Phase 12 "Reconsider trio": Penpot design-token bridge.
//
// DELIBERATE NON-MERGE (documented in docs/phase12/reconsider-trio.md):
// Penpot's editor is never merged into Marketr's Konva Canvas —
// Clojure/ClojureScript + Rust/WASM codebase, 4-service runtime, and the
// wrong editor KIND (product-UI design tool vs. marketing-asset Canvas).
// This module is the only touchpoint that genuinely fits: import design
// tokens (colors, typography) and library styles from a Penpot FILE into
// the Marketr brand kit, following the Phase 11c Brandfetch autofill
// pattern (lib/design/brandfetch.ts).
//
// Two import paths, both real:
//   1. "api"   — live read of a Penpot file via the backend RPC API
//                (GET /api/rpc/command/get-file, access-token auth).
//                Honest caveat: Penpot's RPC API is an INTERNAL contract,
//                not a stable public API. Penpot's official MCP server
//                (@penpot/mcp) is NOT usable headlessly — it drives the
//                plugin API through a companion browser plugin over
//                WebSocket, so a server route cannot call it. The RPC path
//                is therefore marked BETA and degrades loudly.
//   2. "paste" — paste the Tokens-tab export (Tokens tab → Tools → Export)
//                or any DTCG-style JSON. Works with zero Penpot setup.
//
// Credentials: PENPOT_BASE_URL + PENPOT_ACCESS_TOKEN live on the host
// environment, are read server-side only, and never reach the browser.
// No credentials → the API path refuses loudly; the paste path always works.

import {
  brandColorsToKit,
  brandFontsToKit,
  type BrandKitImport,
} from "./brandfetch";

export const PENPOT_TIMEOUT_MS = 20_000;

/** Honest unconfigured-credentials message. Names the env vars; never their values. */
export const PENPOT_NOT_CONFIGURED_MESSAGE =
  "Penpot API import needs PENPOT_BASE_URL and PENPOT_ACCESS_TOKEN in Settings → Providers. " +
  "Meanwhile the paste path (Tokens tab → Tools → Export in Penpot) works with no setup.";

/** Shown in the UI next to the API import — the RPC contract is internal, not stable. */
export const PENPOT_BETA_NOTE =
  "Beta: reads Penpot's internal RPC API (get-file). Endpoint shapes can change " +
  "between Penpot releases; if it fails after a Penpot upgrade, use the paste path.";

/** Server-side only: the base URL never leaves the server. */
export function getPenpotBaseUrl(): string {
  return (process.env.PENPOT_BASE_URL ?? "").replace(/\/+$/, "").trim();
}

/** Server-side only: the access token never leaves the server. */
export function getPenpotAccessToken(): string {
  return (process.env.PENPOT_ACCESS_TOKEN ?? "").trim();
}

/** Status shape mirrors lib/design/brandfetch brandfetchStatus() for the Settings UI. */
export function penpotStatus() {
  const configured = getPenpotBaseUrl().length > 0 && getPenpotAccessToken().length > 0;
  return { name: "penpot", isLive: configured, configured, betaNote: PENPOT_BETA_NOTE };
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** 400-class local failure (missing credentials, bad input). Routes map it to JSON. */
export class PenpotInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "PenpotInputError";
  }
}

/** Thrown when PENPOT_BASE_URL / PENPOT_ACCESS_TOKEN are missing (API path only). */
export class PenpotNotConfiguredError extends Error {
  readonly status = 400;
  readonly code = "penpot_not_configured";
  constructor() {
    super(PENPOT_NOT_CONFIGURED_MESSAGE);
    this.name = "PenpotNotConfiguredError";
  }
}

/**
 * Thrown by Penpot RPC calls for transport/upstream failures.
 * status 0 = network failure or timeout, else the upstream HTTP status.
 */
export class PenpotApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PenpotApiError";
    this.status = status;
  }
}

// ── Kit-ready import shape ───────────────────────────────────────────────────

export interface PenpotImport extends BrandKitImport {
  /** Which of the two import paths produced this. */
  source: "penpot" | "penpot-paste";
  /** File name from Penpot when known. */
  fileName?: string | null;
}

// ── Small helpers ────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/** Normalize to #RRGGBB uppercase; accepts #rgb, #rrggbb, with/without #. */
function normalizeHex(raw: unknown): string | null {
  const s = str(raw)?.trim();
  if (!s) return null;
  let h = s.startsWith("#") ? s.slice(1) : s;
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return `#${h.toUpperCase()}`;
}

function dedupe(values: (string | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

// ── DTCG / token-set walking ─────────────────────────────────────────────────
//
// Penpot's Tokens-tab export is DTCG-shaped:
//   { sets: { "primitive/color": { "brand/primary": { $value: "#...", $type: "color" } } },
//     themes: [...], $metadata: {...} }
// The RPC get-file payload ALSO carries token data, but its exact nesting is
// version-dependent, so extraction is best-effort across candidate locations.

export interface ExtractedPenpotTokens {
  /** { hex, typeHint } — typeHint is the token-set path, used for slot guessing. */
  colors: Array<{ hex: string; typeHint: string | null }>;
  /** { name, typeHint } — typeHint is the token-set path. */
  fonts: Array<{ name: string; typeHint: string | null }>;
  /** Best-effort human label for the import (file name, set names). */
  label: string | null;
}

const COLOR_TYPES = new Set(["color"]);
const FONT_TYPES = new Set(["fontfamily", "font-family", "typography"]);

function looksLikeHex(v: unknown): v is string {
  return typeof v === "string" && /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v.trim());
}

/**
 * Walk a DTCG-shaped token tree, collecting color + font tokens.
 * `path` is the slash-joined token path (e.g. "primitive/color/brand/primary")
 * used as the type hint for brand-kit slot guessing.
 */
export function walkTokenTree(
  node: unknown,
  path: string,
  out: ExtractedPenpotTokens,
): void {
  // Bare string leaf (untyped token shorthand).
  if (typeof node === "string") {
    if (looksLikeHex(node)) {
      const hex = normalizeHex(node);
      if (hex) out.colors.push({ hex, typeHint: path });
    }
    return;
  }
  const r = rec(node);
  if (!r) return;
  const value = r.$value ?? r.value;
  const type = str(r.$type ?? r.type)?.toLowerCase() ?? null;

  if (value !== undefined && (type || looksLikeHex(value))) {
    // A leaf token.
    if (type && COLOR_TYPES.has(type)) {
      const hex = normalizeHex(value);
      if (hex) out.colors.push({ hex, typeHint: path });
      return;
    }
    if (type && FONT_TYPES.has(type)) {
      const name = str(value)?.trim() ?? (rec(value) ? str(rec(value)?.fontFamily)?.trim() : null);
      if (name) out.fonts.push({ name, typeHint: path });
      return;
    }
    // Untyped leaf: hex-looking values are colors, anything else is ignored.
    if (looksLikeHex(value)) {
      const hex = normalizeHex(value);
      if (hex) out.colors.push({ hex, typeHint: path });
    }
    return;
  }

  // Not a leaf — descend. Skip metadata-ish keys.
  for (const [k, v] of Object.entries(r)) {
    if (k === "$metadata" || k === "$extensions") continue;
    walkTokenTree(v, path ? `${path}/${k}` : k, out);
  }
}

/**
 * Best-effort extraction from a Penpot get-file RPC payload.
 * Candidate locations (Penpot 2.x, version-dependent):
 *   - data.tokens / tokens: the design-token catalog (DTCG-shaped `sets`)
 *   - data.colors: library colors { id: { color: "#...", name } }
 *   - data.typographies: library typographies { id: { "font-family"|fontFamily, "font-size", "font-weight", name } }
 */
export function extractPenpotTokens(file: unknown): ExtractedPenpotTokens {
  const out: ExtractedPenpotTokens = { colors: [], fonts: [], label: null };
  const fr = rec(file);
  if (!fr) return out;
  out.label = str(fr.name) ?? null;

  const data = rec(fr.data) ?? fr;

  // 1) Token catalog — try the known shapes.
  const tokensRoot = rec(data.tokens) ?? rec(fr.tokens) ?? null;
  if (tokensRoot) {
    const sets = rec(tokensRoot.sets);
    if (sets) {
      for (const [setName, setTokens] of Object.entries(sets)) {
        walkTokenTree(setTokens, setName, out);
      }
    } else {
      walkTokenTree(tokensRoot, "", out);
    }
  }

  // 2) Library colors: { id: { color: "#...", name } }.
  const libColors = rec(data.colors) ?? rec(fr.colors);
  if (libColors) {
    for (const [, entry] of Object.entries(libColors)) {
      const e = rec(entry);
      if (!e) continue;
      const hex = normalizeHex(e.color);
      if (hex) out.colors.push({ hex, typeHint: str(e.name)?.toLowerCase() ?? null });
    }
  }

  // 3) Library typographies: { id: { "font-family"|fontFamily, name } }.
  const libTypos = rec(data.typographies) ?? rec(fr.typographies);
  if (libTypos) {
    for (const [, entry] of Object.entries(libTypos)) {
      const e = rec(entry);
      if (!e) continue;
      const family = str(e["font-family"]) ?? str(e.fontFamily);
      const name = (family ?? str(e.name) ?? "").trim();
      if (name) out.fonts.push({ name, typeHint: str(e.name)?.toLowerCase() ?? null });
    }
  }

  return out;
}

/**
 * Parse a pasted tokens export (Penpot Tokens tab → Tools → Export, or any
 * DTCG-style JSON). Throws PenpotInputError for invalid/empty input — never
 * invents tokens.
 */
export function parsePastedTokensJson(text: string): ExtractedPenpotTokens {
  const input = (text ?? "").trim();
  if (!input) throw new PenpotInputError("Paste the tokens JSON first.");
  if (input.length > 500_000) throw new PenpotInputError("That paste is too large (max 500 KB).");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new PenpotInputError("That isn't valid JSON. Export from Penpot via Tokens tab → Tools → Export.");
  }
  const out: ExtractedPenpotTokens = { colors: [], fonts: [], label: "Penpot tokens (paste)" };
  const r = rec(parsed);
  if (!r) throw new PenpotInputError("Expected a JSON object of token sets.");
  const sets = rec(r.sets);
  if (sets) {
    for (const [setName, setTokens] of Object.entries(sets)) {
      walkTokenTree(setTokens, setName, out);
    }
  } else {
    walkTokenTree(r, "", out);
  }
  if (out.colors.length === 0 && out.fonts.length === 0) {
    throw new PenpotInputError(
      "No colors or fonts found in that JSON. Export from Penpot's Tokens tab (Tools → Export) as a single JSON file.",
    );
  }
  return out;
}

// ── Kit mapping ──────────────────────────────────────────────────────────────
//
// Fold extracted tokens into brand-kit slots, reusing the Brandfetch slot
// folders so Penpot imports land in the same shape as Brandfetch imports.
// The type hint (token path / library name) drives the slot guess.

function slotHintFromPath(hint: string | null): string | null {
  if (!hint) return null;
  const h = hint.toLowerCase();
  if (/primary/.test(h)) return "primary";
  if (/secondary/.test(h)) return "secondary";
  if (/accent/.test(h)) return "accent";
  if (/text|ink|foreground/.test(h)) return "text";
  if (/muted|subtle|border|surface|background/.test(h)) return "muted";
  return null;
}

function fontSlotFromPath(hint: string | null): string | null {
  if (!hint) return null;
  const h = hint.toLowerCase();
  if (/head|title|display/.test(h)) return "heading";
  if (/body|paragraph|text/.test(h)) return "body";
  return null;
}

export function penpotTokensToKit(extracted: ExtractedPenpotTokens): {
  colors: string[];
  fonts: string[];
  kitColors: Record<string, string>;
  kitFonts: Record<string, string>;
} {
  const colors = dedupe(extracted.colors.map((c) => c.hex));
  const fonts = dedupe(extracted.fonts.map((f) => f.name));
  const rawColors = extracted.colors.map((c) => ({ hex: c.hex, type: slotHintFromPath(c.typeHint) }));
  const rawFonts = extracted.fonts.map((f) => ({ name: f.name, type: fontSlotFromPath(f.typeHint) }));
  return {
    colors,
    fonts,
    kitColors: brandColorsToKit(rawColors, colors),
    kitFonts: brandFontsToKit(rawFonts, fonts),
  };
}

/**
 * Build the BrandKitImport-compatible brand record for a Penpot import.
 * No logo/URL — Penpot imports carry tokens only, labeled honestly.
 */
export function penpotImportRecord(
  extracted: ExtractedPenpotTokens,
  opts: { source: "penpot" | "penpot-paste"; hostLabel: string; fileName?: string | null },
): PenpotImport {
  const { colors, fonts, kitColors, kitFonts } = penpotTokensToKit(extracted);
  const name = opts.fileName ?? extracted.label ?? "Penpot tokens";
  return {
    brand: {
      name,
      domain: opts.hostLabel,
      description: `Design tokens imported from Penpot (${opts.source === "penpot" ? "live file read" : "pasted export"}).`,
      logoUrl: null,
      colors,
      fonts,
    },
    kitColors,
    kitFonts,
    source: opts.source,
    fileName: opts.fileName ?? extracted.label,
  };
}

// ── RPC client ───────────────────────────────────────────────────────────────

type FileId = string;

/**
 * Validate a Penpot file id. Accepts UUIDs and Penpot's url-safe ids;
 * rejects empty/oversized/garbage input. Throws PenpotInputError (400).
 */
export function normalizeFileId(raw: string): FileId {
  const id = (raw ?? "").trim();
  if (!id) throw new PenpotInputError("Enter a Penpot file ID.");
  if (id.length > 128) throw new PenpotInputError("That file ID is too long.");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new PenpotInputError("That file ID doesn't look like a Penpot file ID (letters, digits, - and _ only).");
  }
  return id;
}

function hostLabelOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Low-level get-file RPC read. Returns the decoded payload (throws
 * PenpotApiError on transport/upstream failures, PenpotNotConfiguredError
 * when credentials are missing).
 *
 * BETA: Penpot's RPC API is internal, not a stable public contract. The
 * response is requested with `Accept: application/json`; older Penpot
 * versions may return Transit-encoded data, which this client does not
 * decode — extraction then finds nothing and the import fails honestly.
 */
export async function getPenpotFile(
  baseUrl: string,
  apiKey: string,
  fileId: FileId,
  fetchImpl: FetchImpl = fetch,
): Promise<unknown> {
  if (!baseUrl || !apiKey) throw new PenpotNotConfiguredError();
  const url = `${baseUrl}/api/rpc/command/get-file?id=${encodeURIComponent(fileId)}`;
  let res: Response;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PENPOT_TIMEOUT_MS);
    try {
      res = await fetchImpl(url, {
        headers: {
          Authorization: `Token ${apiKey}`,
          Accept: "application/json",
        },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    throw new PenpotApiError(0, "Could not reach the Penpot instance. Check the URL and try again.");
  }
  if (res.status === 401 || res.status === 403) {
    throw new PenpotApiError(
      res.status,
      `Penpot rejected the access token (HTTP ${res.status}). Check PENPOT_ACCESS_TOKEN in Settings → Providers.`,
    );
  }
  if (res.status === 404) {
    throw new PenpotApiError(404, "Penpot has no file with that ID (HTTP 404). Check the file ID.");
  }
  if (!res.ok) {
    throw new PenpotApiError(res.status, `Penpot request failed with HTTP ${res.status}.`);
  }
  try {
    return await res.json();
  } catch {
    throw new PenpotApiError(
      res.status,
      "Penpot returned an unreadable response. This instance may return Transit-encoded data — use the paste path instead.",
    );
  }
}

/**
 * Server-side Penpot token import (the "api" path).
 * `fetchImpl` is injectable for tests; production passes the global fetch.
 * The token travels only in the Authorization header and is never logged.
 *
 * Throws PenpotNotConfiguredError / PenpotInputError / PenpotApiError.
 */
export async function importPenpotTokensViaApi(
  fileIdRaw: string,
  fetchImpl: FetchImpl = fetch,
): Promise<PenpotImport> {
  const baseUrl = getPenpotBaseUrl();
  const apiKey = getPenpotAccessToken();
  const fileId = normalizeFileId(fileIdRaw);
  const file = await getPenpotFile(baseUrl, apiKey, fileId, fetchImpl);
  const extracted = extractPenpotTokens(file);
  if (extracted.colors.length === 0 && extracted.fonts.length === 0) {
    throw new PenpotApiError(
      200,
      "No design tokens found in this Penpot file. The file may have no tokens tab, or this Penpot " +
        "version returns data in a shape this import doesn't read yet — paste the Tokens-tab export instead.",
    );
  }
  return penpotImportRecord(extracted, {
    source: "penpot",
    hostLabel: hostLabelOf(baseUrl),
    fileName: extracted.label,
  });
}

/**
 * Server-side Penpot token import (the "paste" path). Works with no Penpot
 * credentials — the JSON comes from the user.
 */
export async function importPenpotTokensViaPaste(tokensJson: string): Promise<PenpotImport> {
  const extracted = parsePastedTokensJson(tokensJson);
  return penpotImportRecord(extracted, { source: "penpot-paste", hostLabel: "manual-paste" });
}
