// Marketr — Phase 11 "Canvas": server-side document → PNG renderer.
//
// The strategic compounding asset: POST a DesignDocument JSON, get PNG bytes.
// This turns every template into an automation primitive (n8n nodes,
// GrowthOS batch loops, "regenerate the winners nightly").
//
// Pipeline: DesignDocument → lib/design/export-svg.ts (the same serializer
// the client SVG export uses, built on the shared chart-math models so
// canvas, SVG export, and server output agree) → sharp (librsvg) → PNG.
//
// Reliability notes:
//  - Fonts: the SVG references font-family names. System fontconfig supplies
//    metric-compatible substitutes for the curated set (Liberation Sans/Serif
//    for Arial/Times New Roman/Helvetica, Noto for the rest). Inter — the
//    editor default — is registered at runtime from the embedded OFL woff2
//    files in ./render/inter-fonts.ts via a private fontconfig config, so
//    the render works identically on machines without Inter installed.
//    Unknown families fall back to the system sans, same as any SVG viewer.
//  - Images: remote http(s) URLs are fetched server-side (timeout + size
//    caps + SSRF guard) and embedded as data URLs. A single failing image
//    becomes a light-gray placeholder — it never fails the whole render.
//    data: URLs pass through (the document itself is size-capped by the
//    validator, so this can't be a memory bomb).
//  - Never throws on bad input: invalid documents are rejected with
//    { ok: false, error }; rasterization surprises are logged server-side
//    and surfaced as a light "Render failed" message.

import { promises as dns } from "node:dns";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

import { exportPageToSvg } from "./export-svg";
import { validateDesignDocument } from "./validate";
import { INTER_WOFF2 } from "./render/inter-fonts";
import type { DesignDocument, DesignPage, ImageElement } from "./types";

/** Rendered scale is clamped to this multiple of the page size (abuse cap). */
export const MAX_RENDER_SCALE = 3;
/** Per-image fetch timeout. */
export const IMAGE_FETCH_TIMEOUT_MS = 8_000;
/** Per-image byte cap (fetch + data URL passthrough). */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Max remote images resolved per render (extras become placeholders). */
export const MAX_REMOTE_IMAGES = 25;

export interface RenderWarning {
  elementId: string;
  message: string;
}

export interface RenderSuccess {
  ok: true;
  png: Buffer;
  /** Raster dimensions (page size × scale). */
  width: number;
  height: number;
  pageId: string;
  warnings: RenderWarning[];
}

export type RenderResult = RenderSuccess | { ok: false; error: string };

export interface RenderOptions {
  /** 1..MAX_RENDER_SCALE. Defaults to 1. Out-of-range values are clamped. */
  scale?: number;
  /** Page id to render; defaults to the first page. */
  pageId?: string;
}

// ── Fonts ────────────────────────────────────────────────────────────────

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

let fontsReady = false;

/**
 * Register the embedded Inter woff2 files with fontconfig so librsvg
 * (via Pango) resolves "Inter" — the editor's default font — on machines
 * where it isn't installed system-wide. Writes to os.tmpdir() once per
 * process; includes the system fonts.conf so nothing else changes. No-op
 * on failure (system fonts still work).
 *
 * Note: FONTCONFIG_FILE is read by fontconfig on first use in the process,
 * so this must run before the first sharp SVG render. This module is the
 * only SVG rasterizer in the server, and renderDocumentToPng() calls this
 * before any sharp call.
 */
function ensureRenderFonts(): void {
  if (fontsReady) return;
  fontsReady = true;
  try {
    const fontDir = join(tmpdir(), "marketr-render-fonts");
    if (!existsSync(fontDir)) mkdirSync(fontDir, { recursive: true });
    for (const [name, b64] of Object.entries(INTER_WOFF2)) {
      const p = join(fontDir, name);
      if (!existsSync(p)) writeFileSync(p, Buffer.from(b64, "base64"));
    }
    const confDir = join(tmpdir(), "marketr-render-fontconfig");
    const cacheDir = join(confDir, "cache");
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    const confPath = join(confDir, "fonts.conf");
    writeFileSync(
      confPath,
      `<?xml version="1.0"?>\n` +
        `<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n` +
        `<fontconfig>\n` +
        `  <dir>${escapeXmlAttr(fontDir)}</dir>\n` +
        `  <cachedir>${escapeXmlAttr(cacheDir)}</cachedir>\n` +
        `  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>\n` +
        `</fontconfig>\n`,
    );
    if (!process.env.FONTCONFIG_FILE) process.env.FONTCONFIG_FILE = confPath;
  } catch {
    // Fall through: renders use whatever the system fontconfig resolves.
  }
}

// ── Image resolution ─────────────────────────────────────────────────────

/** True for IPv4/IPv6 addresses that must never be fetched server-side. */
export function isBlockedIp(ip: string): boolean {
  if (ip.includes(":")) return true; // block all IPv6 (loopback, link-local, ULA)
  const parts = ip.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  )
    return true;
  const [a, b] = parts;
  return (
    a === 0 || // "this network"
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 169 && b === 254) || // link-local incl. cloud metadata
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a >= 224 // multicast + reserved
  );
}

export interface ImageResolveDeps {
  fetchImpl?: typeof fetch;
  /** Test seam: host → addresses (defaults to real DNS). */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

async function resolveHostSafe(
  hostname: string,
  resolveHost?: ImageResolveDeps["resolveHost"],
): Promise<void> {
  const addrs = resolveHost
    ? await resolveHost(hostname).catch(() => {
        throw new Error("unresolvable host");
      })
    : await dns
        .lookup(hostname, { all: true })
        .then((all) => all.map((a) => a.address))
        .catch(() => {
          throw new Error("unresolvable host");
        });
  if (addrs.length === 0 || addrs.some(isBlockedIp)) {
    throw new Error("blocked host");
  }
}

let placeholderCache: string | null = null;

/** 1×1 light-gray PNG data URL — the "image failed" marker. */
async function placeholderDataUrl(): Promise<string> {
  if (!placeholderCache) {
    const buf = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "#e7e5e4" },
    })
      .png()
      .toBuffer();
    placeholderCache = `data:image/png;base64,${buf.toString("base64")}`;
  }
  return placeholderCache;
}

function isHttpUrl(src: string): boolean {
  return src.startsWith("http://") || src.startsWith("https://");
}

function isDataUrl(src: string): boolean {
  return src.startsWith("data:");
}

async function fetchImageDataUrl(
  url: string,
  deps: ImageResolveDeps,
): Promise<string> {
  const parsed = new URL(url);
  await resolveHostSafe(parsed.hostname, deps.resolveHost);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  // Re-check after redirects (response.url is the final URL).
  await resolveHostSafe(new URL(res.url || url).hostname, deps.resolveHost);
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!contentType.startsWith("image/")) throw new Error("not an image");
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no body");
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("too large");
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return `data:${contentType};base64,${buf.toString("base64")}`;
}

export interface ImageSourcesResult {
  /** element id → data URL (or original data: src) for export-svg's imageSources */
  sources: Record<string, string>;
  warnings: RenderWarning[];
}

/**
 * Resolve a page's image elements to data URLs. Remote URLs are fetched
 * with timeout + size caps + SSRF guard; any single failure becomes a
 * gray placeholder with a warning — never a render failure.
 */
export async function resolveImageSources(
  page: DesignPage,
  deps: ImageResolveDeps = {},
): Promise<ImageSourcesResult> {
  const sources: Record<string, string> = {};
  const warnings: RenderWarning[] = [];
  const placeholder = await placeholderDataUrl();
  let remoteCount = 0;
  for (const el of page.elements) {
    if (el.type !== "image") continue;
    const img = el as ImageElement;
    const src = img.src;
    if (isDataUrl(src)) {
      if (src.length > MAX_IMAGE_BYTES * 1.4) {
        sources[img.id] = placeholder;
        warnings.push({ elementId: img.id, message: "image data too large; placeholder used" });
      } else {
        sources[img.id] = src;
      }
      continue;
    }
    if (!isHttpUrl(src)) {
      sources[img.id] = placeholder;
      warnings.push({ elementId: img.id, message: "unsupported image src; placeholder used" });
      continue;
    }
    remoteCount += 1;
    if (remoteCount > MAX_REMOTE_IMAGES) {
      sources[img.id] = placeholder;
      warnings.push({ elementId: img.id, message: "too many remote images; placeholder used" });
      continue;
    }
    try {
      sources[img.id] = await fetchImageDataUrl(src, deps);
    } catch (e) {
      const reason = e instanceof Error ? e.message : "fetch failed";
      sources[img.id] = placeholder;
      warnings.push({ elementId: img.id, message: `image unavailable (${reason}); placeholder used` });
    }
  }
  return { sources, warnings };
}

// ── Render ───────────────────────────────────────────────────────────────

function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_RENDER_SCALE, Math.max(1, scale));
}

/**
 * Validate → SVG (shared serializer) → PNG via sharp.
 * Never throws on bad input; rasterization surprises return ok:false with
 * a light message (details go to the server log).
 */
export async function renderDocumentToPng(
  doc: unknown,
  opts: RenderOptions = {},
  deps: ImageResolveDeps = {},
): Promise<RenderResult> {
  const validated = validateDesignDocument(doc);
  if (!validated.ok) return { ok: false, error: validated.error };
  const page = opts.pageId
    ? validated.doc.pages.find((p) => p.id === opts.pageId)
    : validated.doc.pages[0];
  if (!page) {
    return {
      ok: false,
      error: opts.pageId ? `page not found: ${opts.pageId}` : "document has no pages",
    };
  }
  const scale = clampScale(opts.scale ?? 1);
  ensureRenderFonts();
  const { sources, warnings } = await resolveImageSources(page, deps);
  const exported = exportPageToSvg(validated.doc as unknown as DesignDocument, page.id, {
    imageSources: sources,
  });
  if (!exported.ok) return { ok: false, error: exported.error };
  try {
    const png = await sharp(Buffer.from(exported.svg, "utf8"), {
      density: Math.round(72 * scale),
    })
      .png()
      .toBuffer();
    const meta = await sharp(png).metadata();
    return {
      ok: true,
      png,
      width: meta.width ?? Math.round(page.width * scale),
      height: meta.height ?? Math.round(page.height * scale),
      pageId: page.id,
      warnings,
    };
  } catch (e) {
    console.error(
      "[render] rasterization failed:",
      e instanceof Error ? e.message : e,
    );
    return { ok: false, error: "Render failed" };
  }
}
