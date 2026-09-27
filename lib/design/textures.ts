// Marketr — Phase 11 "Canvas": pattern textures for fills/backgrounds
// (integration #10).
//
// License verdict (2026-09-27, open item #3): FAIL CLOSED on
// Transparent Textures. The site carries no license text at all (a full-page
// fetch finds zero mentions of "license") and each pattern is credited to an
// individual author ("Made by …") with no stated rights grant — an
// independent audit notes "no formal license page; patterns licensed by
// their original authors." That does not clearly permit commercial use, so
// the curated set ships from **ambientCG**, whose docs
// (https://docs.ambientcg.com/license, fetched 2026-09-27) state plainly:
// "All ambientCG assets are provided under the Creative Commons CC0 1.0
// Universal License… even for commercial purposes, all without asking
// permission." Per the brief, the set is downloaded and bundled locally
// (public/textures/) — same-origin tiles keep Konva exports CORS-clean,
// unlike hotlinking a third-party host.
//
// Usage contract: a texture is APPLIED by writing it into the element/page
// `custom` bag via withTextureProvenance() (provenance travels with the
// design, per the asset-provider contract in the survey §13). Rendering reads
// custom.texture through textureFillProps(); thumbnails come from the local
// path. Nothing here is fetched from the network at runtime.

import { useEffect, useState } from "react";

export interface TextureEntry {
  /** Stable id, e.g. "plaster-07". */
  id: string;
  /** Human name shown in the Patterns section. */
  name: string;
  /** Always "ambientCG" for this curated set. */
  source: "ambientCG";
  /** Asset page, e.g. https://ambientcg.com/a/Plaster001 — the provenance URL. */
  sourceUrl: string;
  /** ambientCG asset id, e.g. "Plaster001". */
  assetId: string;
  /** Full license string carried into the design's custom bag. */
  license: string;
  /** Local bundled tile (same origin; CORS-clean for canvas export). */
  path: string;
  /** Suggested base fill under the tile when applied to a shape. */
  baseFill: string;
}

export const TEXTURE_LICENSE = "CC0 1.0 Universal";
export const TEXTURE_LICENSE_URL = "https://creativecommons.org/publicdomain/zero/1.0/";
export const TEXTURE_SOURCE_URL = "https://ambientcg.com";

/**
 * Curated set (10): subtle, tileable, marketing-safe surfaces. All CC0 from
 * ambientCG; each file lives in public/textures/ as a 512px tile.
 */
export const TEXTURES: TextureEntry[] = [
  {
    id: "paper-001",
    name: "Paper",
    source: "ambientCG",
    sourceUrl: "https://ambientcg.com/a/Paper001",
    assetId: "Paper001",
    license: "CC0 1.0 Universal (ambientCG)",
    path: "/textures/paper-001.jpg",
    baseFill: "#f5f2ea",
  },
  {
    id: "plaster-001",
    name: "Plaster",
    source: "ambientCG",
    sourceUrl: "https://ambientcg.com/a/Plaster001",
    assetId: "Plaster001",
    license: "CC0 1.0 Universal (ambientCG)",
    path: "/textures/plaster-001.jpg",
    baseFill: "#e8e4dc",
  },
  {
    id: "fabric-061",
    name: "Fabric",
    source: "ambientCG",
    sourceUrl: "https://ambientcg.com/a/Fabric061",
    assetId: "Fabric061",
    license: "CC0 1.0 Universal (ambientCG)",
    path: "/textures/fabric-061.jpg",
    baseFill: "#d9d4c8",
  },
  {
    id: "concrete-034",
    name: "Concrete",
    source: "ambientCG",
    sourceUrl: "https://ambientcg.com/a/Concrete034",
    assetId: "Concrete034",
    license: "CC0 1.0 Universal (ambientCG)",
    path: "/textures/concrete-034.jpg",
    baseFill: "#cfcfcf",
  },
  {
    id: "wood-092",
    name: "Wood",
    source: "ambientCG",
    sourceUrl: "https://ambientcg.com/a/Wood092",
    assetId: "Wood092",
    license: "CC0 1.0 Universal (ambientCG)",
    path: "/textures/wood-092.jpg",
    baseFill: "#8a6b4f",
  },
  {
    id: "marble-012",
    name: "Marble",
    source: "ambientCG",
    sourceUrl: "https://ambientcg.com/a/Marble012",
    assetId: "Marble012",
    license: "CC0 1.0 Universal (ambientCG)",
    path: "/textures/marble-012.jpg",
    baseFill: "#ececec",
  },
  {
    id: "metal-063",
    name: "Brushed metal",
    source: "ambientCG",
    sourceUrl: "https://ambientcg.com/a/Metal063",
    assetId: "Metal063",
    license: "CC0 1.0 Universal (ambientCG)",
    path: "/textures/metal-063.jpg",
    baseFill: "#9a9a9a",
  },
  {
    id: "cardboard-002",
    name: "Cardboard",
    source: "ambientCG",
    sourceUrl: "https://ambientcg.com/a/Cardboard002",
    assetId: "Cardboard002",
    license: "CC0 1.0 Universal (ambientCG)",
    path: "/textures/cardboard-002.jpg",
    baseFill: "#c9a878",
  },
  {
    id: "onyx-015",
    name: "Onyx",
    source: "ambientCG",
    sourceUrl: "https://ambientcg.com/a/Onyx015",
    assetId: "Onyx015",
    license: "CC0 1.0 Universal (ambientCG)",
    path: "/textures/onyx-015.jpg",
    baseFill: "#2e2c2a",
  },
  {
    id: "steel-009",
    name: "Corrugated steel",
    source: "ambientCG",
    sourceUrl: "https://ambientcg.com/a/CorrugatedSteel009",
    assetId: "CorrugatedSteel009",
    license: "CC0 1.0 Universal (ambientCG)",
    path: "/textures/steel-009.jpg",
    baseFill: "#8f959b",
  },
];

export function getTexture(id: string): TextureEntry | null {
  return TEXTURES.find((t) => t.id === id) ?? null;
}

/** Provenance object written into the element/page `custom` bag on apply. */
export function textureProvenance(t: TextureEntry): Record<string, unknown> {
  return {
    provider: "ambientcg",
    kind: "texture",
    textureId: t.id,
    name: t.name,
    assetId: t.assetId,
    sourceUrl: t.sourceUrl,
    license: t.license,
    licenseUrl: TEXTURE_LICENSE_URL,
    appliedAt: new Date().toISOString(),
  };
}

/**
 * Merge texture provenance into an existing `custom` bag without clobbering
 * other keys. Passing null clears the texture (custom.texture removed).
 */
export function withTextureProvenance(
  custom: Record<string, unknown> | undefined,
  texture: TextureEntry | null,
): Record<string, unknown> {
  const next = { ...(custom ?? {}) };
  if (texture) next.texture = textureProvenance(texture);
  else delete next.texture;
  return next;
}

/** True when the element's custom bag carries a texture application. */
export function hasTexture(custom: Record<string, unknown> | undefined): boolean {
  return textureEntryFor(custom) !== null;
}

/**
 * Resolve the manifest entry for a texture application stored in a
 * `custom` bag. Returns null for anything that isn't a well-formed
 * texture provenance (never throws — the renderer calls this per frame).
 */
export function textureEntryFor(custom: Record<string, unknown> | undefined): TextureEntry | null {
  if (!custom || typeof custom !== "object") return null;
  const t = (custom as Record<string, unknown>).texture;
  if (!t || typeof t !== "object") return null;
  const id = (t as Record<string, unknown>).textureId;
  if (typeof id !== "string" || !id) return null;
  return getTexture(id);
}

/**
 * Client hook: loads the bundled tile image for a texture application in a
 * `custom` bag (element or page). Same-origin tile → no CORS taint on
 * canvas export. Returns null on the server or when no texture is applied.
 */
export function useTextureTile(custom: Record<string, unknown> | undefined): HTMLImageElement | null {
  const entry = textureEntryFor(custom);
  const path = entry ? entry.path : null;
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!path) {
      setImg(null);
      return;
    }
    let live = true;
    const image = new Image();
    image.onload = () => {
      if (live) setImg(image);
    };
    image.onerror = () => {
      if (live) setImg(null);
    };
    image.src = path;
    return () => {
      live = false;
      setImg(null);
    };
  }, [path]);
  return img;
}

/**
 * Konva fill props for a texture applied to a shape: the tile repeats across
 * the node. Renderers (DesignCanvas) pass the loaded image. Returns {} when
 * there is no texture, so it can be spread unconditionally.
 */
export function textureFillProps(img: HTMLImageElement | null): Record<string, unknown> {
  if (!img) return {};
  return { fillPatternImage: img, fillPatternRepeat: "repeat" as const };
}
