// Marketr — Phase 11 "Canvas": design document structural validator.
// Never throws: every structural violation (and any internal surprise) is
// returned as { ok: false, error }.
//
// H1: svg element bodies are untrusted markup. The returned `doc` carries
// every body run through the strict allowlist sanitizer (svg-sanitize.ts);
// callers persist/render `validated.doc`, never the raw input.

import { sanitizeSvgFragment } from "./svg-sanitize";
import {
  DESIGN_SCHEMA_VERSION,
  type DesignDocument,
  type ElementType,
} from "./types";

/** Hard cap on serialized document size (5 MB). */
export const MAX_DESIGN_DOCUMENT_BYTES = 5 * 1024 * 1024;

const ELEMENT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "image",
  "rect",
  "ellipse",
  "line",
  "svg",
  "chart",
  "qr",
] satisfies ElementType[]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isPositiveNumber(v: unknown): v is number {
  return isFiniteNumber(v) && v > 0;
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function validateElement(el: unknown, index: number, pageIndex: number): string | null {
  const where = `pages[${pageIndex}].elements[${index}]`;
  if (!isRecord(el)) return `${where}: must be an object`;
  if (!isNonEmptyString(el.id)) return `${where}.id: must be a non-empty string`;
  if (typeof el.type !== "string" || !ELEMENT_TYPES.has(el.type))
    return `${where}.type: must be one of ${[...ELEMENT_TYPES].join("|")}`;
  for (const k of ["x", "y", "rotation", "opacity"]) {
    if (!isFiniteNumber(el[k])) return `${where}.${k}: must be a finite number`;
  }
  if (!isBoolean(el.visible)) return `${where}.visible: must be a boolean`;
  if (!isBoolean(el.locked)) return `${where}.locked: must be a boolean`;

  switch (el.type as ElementType) {
    case "text":
      if (typeof el.text !== "string") return `${where}.text: must be a string`;
      if (typeof el.fontFamily !== "string") return `${where}.fontFamily: must be a string`;
      if (!isPositiveNumber(el.fontSize)) return `${where}.fontSize: must be a positive number`;
      if (el.fragments !== undefined) {
        if (!Array.isArray(el.fragments))
          return `${where}.fragments: must be an array`;
        for (let f = 0; f < el.fragments.length; f++) {
          const fr = el.fragments[f];
          if (!isRecord(fr) || typeof fr.text !== "string")
            return `${where}.fragments[${f}].text: must be a string`;
          if (fr.fontSize !== undefined && !isPositiveNumber(fr.fontSize))
            return `${where}.fragments[${f}].fontSize: must be a positive number`;
        }
      }
      if (el.textPath !== undefined && typeof el.textPath !== "string")
        return `${where}.textPath: must be a string`;
      break;
    case "image":
      if (typeof el.src !== "string") return `${where}.src: must be a string`;
      if (!isPositiveNumber(el.width)) return `${where}.width: must be a positive number`;
      if (!isPositiveNumber(el.height)) return `${where}.height: must be a positive number`;
      break;
    case "rect":
    case "ellipse":
      if (typeof el.fill !== "string") return `${where}.fill: must be a string`;
      break;
    case "line":
      if (!Array.isArray(el.points) || !el.points.every(isFiniteNumber))
        return `${where}.points: must be an array of finite numbers`;
      break;
    case "svg":
      if (typeof el.path !== "string") return `${where}.path: must be a string`;
      for (const k of ["iconRef", "body", "viewBox"] as const) {
        const v = (el as unknown as Record<string, unknown>)[k];
        if (v !== undefined && typeof v !== "string")
          return `${where}.${k}: must be a string when present`;
      }
      break;
    case "chart":
      if (!["bar", "line", "pie"].includes(el.chartType as string))
        return `${where}.chartType: must be bar|line|pie`;
      if (!Array.isArray(el.labels) || !el.labels.every((l) => typeof l === "string"))
        return `${where}.labels: must be an array of strings`;
      if (!Array.isArray(el.values) || !el.values.every(isFiniteNumber))
        return `${where}.values: must be an array of finite numbers`;
      if (el.labels.length !== el.values.length)
        return `${where}: labels and values must have the same length`;
      if (el.labels.length === 0 || el.labels.length > 24)
        return `${where}: must have 1..24 data points`;
      if (!Array.isArray(el.colors) || !el.colors.every((c) => typeof c === "string"))
        return `${where}.colors: must be an array of strings`;
      break;
    case "qr":
      if (typeof el.payload !== "string" || el.payload.length === 0)
        return `${where}.payload: must be a non-empty string`;
      if (el.payload.length > 2048)
        return `${where}.payload: must be at most 2048 chars`;
      if (!isPositiveNumber(el.size)) return `${where}.size: must be a positive number`;
      break;
  }
  return null;
}

function validatePage(page: unknown, index: number): string | null {
  const where = `pages[${index}]`;
  if (!isRecord(page)) return `${where}: must be an object`;
  if (!isNonEmptyString(page.id)) return `${where}.id: must be a non-empty string`;
  if (!isPositiveNumber(page.width)) return `${where}.width: must be a positive number`;
  if (!isPositiveNumber(page.height)) return `${where}.height: must be a positive number`;
  if (typeof page.background !== "string") return `${where}.background: must be a string`;
  if (!Array.isArray(page.elements)) return `${where}.elements: must be an array`;
  for (let i = 0; i < page.elements.length; i++) {
    const err = validateElement(page.elements[i], i, index);
    if (err) return err;
  }
  return null;
}

/** Copy of `doc` with every svg element `body` allowlist-sanitized (H1). */
function withSanitizedSvgBodies(doc: Record<string, unknown>): Record<string, unknown> {
  const pages = (doc.pages as unknown[]).map((page) => {
    const p = page as Record<string, unknown>;
    const elements = (p.elements as unknown[]).map((el) => {
      const e = el as Record<string, unknown>;
      if (e.type !== "svg" || typeof e.body !== "string") return el;
      return { ...e, body: sanitizeSvgFragment(e.body) };
    });
    return { ...p, elements };
  });
  return { ...doc, pages };
}

export function validateDesignDocument(
  doc: unknown,
): { ok: true; doc: DesignDocument } | { ok: false; error: string } {
  try {
    if (!isRecord(doc)) return { ok: false, error: "document: must be an object" };
    if (doc.schemaVersion !== DESIGN_SCHEMA_VERSION)
      return {
        ok: false,
        error: `document.schemaVersion: must be ${DESIGN_SCHEMA_VERSION}`,
      };
    if (!Array.isArray(doc.pages) || doc.pages.length === 0)
      return { ok: false, error: "document.pages: must be a non-empty array" };
    for (let i = 0; i < doc.pages.length; i++) {
      const err = validatePage(doc.pages[i], i);
      if (err) return { ok: false, error: err };
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(doc);
    } catch {
      return { ok: false, error: "document: not JSON-serializable" };
    }
    if (serialized.length > MAX_DESIGN_DOCUMENT_BYTES)
      return {
        ok: false,
        error: `document: serialized size exceeds ${MAX_DESIGN_DOCUMENT_BYTES} bytes`,
      };
    return { ok: true, doc: withSanitizedSvgBodies(doc) as unknown as DesignDocument };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? `document: ${e.message}` : "document: validation failed",
    };
  }
}
