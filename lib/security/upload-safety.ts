// Marketr — upload safety: MIME allow-list, magic-byte verification, and
// filename/path hardening for every file-upload route (Phase A, fix 5).
//
// Design notes:
// - The client's declared MIME type and the file extension are hints, never
//   trust. The sniffed magic bytes decide.
// - Dependency-free on purpose: no `file-type` package, so these checks work
//   in every runtime and can't be broken by a supply-chain update.
// - Pure functions (no prisma, no @/ imports) so that
//   scripts/verify-upload-safety.mts can import this module directly under
//   node type-stripping.
// - Node-24 type-stripping compatible: erasable syntax only (no enums).

import { resolve, sep } from "node:path";

export type UploadCategory = "default" | "images" | "text" | "archive";

export interface SniffedKind {
  mime: string;
  ext: string;
}

export type UploadCheck =
  | { ok: true; mime: string; ext: string }
  | { ok: false; reason: string };

const OFFICE_EXTS = new Set(["docx", "xlsx", "pptx"]);
const OFFICE_MIMES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

// Extension → canonical MIME, for consistency checks against sniffed bytes.
const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  zip: "application/zip",
  html: "text/html",
  htm: "text/html",
  ...OFFICE_MIMES,
};

const CATEGORY_MIMES: Record<UploadCategory, Set<string>> = {
  default: new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    "application/pdf",
    "text/plain",
    "text/markdown",
    "text/csv",
    ...Object.values(OFFICE_MIMES),
  ]),
  images: new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]),
  text: new Set(["text/plain", "text/markdown", "text/csv"]),
  archive: new Set(["application/zip", "text/html"]),
};

const CATEGORY_LABEL: Record<UploadCategory, string> = {
  default:
    "images (PNG, JPEG, GIF, WebP, SVG), PDFs, text files (TXT, Markdown, CSV), and Office documents (Word, Excel, PowerPoint)",
  images: "images (PNG, JPEG, GIF, WebP, SVG)",
  text: "text files (TXT, Markdown, CSV)",
  archive: "a .zip archive or an .html file",
};

function startsWith(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[i] !== bytes[i]) return false;
  }
  return true;
}

/** True when the buffer looks like text (no NUL bytes, few control chars). */
export function isTextualBuffer(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.length === 0) return false;
  let controls = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0x00) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20) || b === 0x7f) controls++;
  }
  return controls / sample.length < 0.02;
}

/**
 * Sniff the file kind from magic bytes. Returns null when the type cannot
 * be determined. Never trusts the extension or the declared MIME type.
 */
export function sniffFileKind(buf: Buffer): SniffedKind | null {
  if (buf.length >= 8 && startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", ext: "png" };
  }
  if (buf.length >= 3 && startsWith(buf, [0xff, 0xd8, 0xff])) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (buf.length >= 6 && startsWith(buf, [0x47, 0x49, 0x46, 0x38])) {
    return { mime: "image/gif", ext: "gif" }; // GIF87a / GIF89a
  }
  if (
    buf.length >= 12 &&
    startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && // "RIFF"
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  if (buf.length >= 5 && startsWith(buf, [0x25, 0x50, 0x44, 0x46])) {
    return { mime: "application/pdf", ext: "pdf" }; // "%PDF-"
  }
  if (
    buf.length >= 4 &&
    (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || // local file header
      startsWith(buf, [0x50, 0x4b, 0x05, 0x06]) || // empty archive
      startsWith(buf, [0x50, 0x4b, 0x07, 0x08])) // spanned archive
  ) {
    return { mime: "application/zip", ext: "zip" };
  }
  if (isTextualBuffer(buf)) {
    const head = buf
      .subarray(0, Math.min(buf.length, 2048))
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .trimStart();
    if (/^<svg[\s>]/.test(head) || /^<\?xml[\s\S]{0,600}?<svg[\s>]/.test(head)) {
      return { mime: "image/svg+xml", ext: "svg" };
    }
    if (/^<!doctype html/i.test(head) || /^<html[\s>]/i.test(head)) {
      return { mime: "text/html", ext: "html" };
    }
    return { mime: "text/plain", ext: "txt" };
  }
  return null;
}

// The EICAR standard anti-virus test string (not malware — a detector check).
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/** Built-in tripwire for the EICAR test string; real AV is the scanner hook. */
export function containsEicar(buf: Buffer): boolean {
  return buf.includes(EICAR, 0, "utf8");
}

const SVG_DANGEROUS = [/<script[\s>]/i, /javascript:/i, /\son[a-z]+\s*=/i];

/** SVGs are XML and can carry scripts — reject active content. */
export function svgLooksDangerous(buf: Buffer): boolean {
  const text = buf.subarray(0, Math.min(buf.length, 65536)).toString("utf8");
  return SVG_DANGEROUS.some((re) => re.test(text));
}

// Raster-image polyglots (e.g. GIFAR: valid image header + HTML/JS payload)
// are a classic stored-XSS vector. Real photos never contain these markers.
const POLYGLOT_MARKERS = [/<script[\s>]/i, /<html[\s>]/i, /<iframe[\s>]/i];

export function imageLooksPolyglot(buf: Buffer): boolean {
  const text = buf.subarray(0, Math.min(buf.length, 131072)).toString("latin1");
  return POLYGLOT_MARKERS.some((re) => re.test(text));
}

/** Strip directories, kill unsafe chars, bound the length. */
export function safeFilename(name: string): string {  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || "file";
}

function extOf(filename: string): string | null {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const i = base.lastIndexOf(".");
  if (i <= 0 || i === base.length - 1) return null;
  return base.slice(i + 1).toLowerCase();
}

const EXT_ALIASES: Record<string, string> = { jpeg: "jpg", htm: "html" };

// Sniffed "txt" is generic text — it covers the whole text family.
const TEXT_FAMILY = new Set(["txt", "md", "csv"]);

function extMatches(sniffedExt: string, fileExt: string): boolean {
  const a = EXT_ALIASES[sniffedExt] ?? sniffedExt;
  const b = EXT_ALIASES[fileExt] ?? fileExt;
  if (a === b) return true;
  return a === "txt" && TEXT_FAMILY.has(b);
}

export function formatMaxBytes(maxBytes: number): string {
  const mb = maxBytes / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${(maxBytes / 1024).toFixed(0)} KB`;
}

export interface ValidateUploadOptions {
  filename: string;
  maxBytes: number;
  category: UploadCategory;
}

/**
 * Full upload gate: size → EICAR tripwire → magic-byte sniff → allow-list →
 * extension consistency → format-specific active-content checks.
 * Returns a plain-language reason on rejection (safe to show the user).
 */
export function validateUploadBuffer(
  buf: Buffer,
  opts: ValidateUploadOptions,
): UploadCheck {
  const { filename, maxBytes, category } = opts;

  if (buf.length === 0) {
    return { ok: false, reason: "The file is empty." };
  }
  if (buf.length > maxBytes) {
    return {
      ok: false,
      reason: `This file is too large. The maximum size is ${formatMaxBytes(maxBytes)}.`,
    };
  }
  if (containsEicar(buf)) {
    return { ok: false, reason: "This file failed the malware screening and was rejected." };
  }

  const sniffed = sniffFileKind(buf);
  if (!sniffed) {
    return {
      ok: false,
      reason:
        "We couldn't verify what kind of file this is, so it was rejected. " +
        `You can upload ${CATEGORY_LABEL[category]}.`,
    };
  }

  const fileExt = extOf(filename);

  // Office documents are ZIP containers: sniff says zip, extension must say which.
  if (sniffed.mime === "application/zip" && fileExt && OFFICE_EXTS.has(fileExt)) {
    if (!CATEGORY_MIMES[category].has(OFFICE_MIMES[fileExt])) {
      return {
        ok: false,
        reason: `This file type isn't allowed here. You can upload ${CATEGORY_LABEL[category]}.`,
      };
    }
    return { ok: true, mime: OFFICE_MIMES[fileExt], ext: fileExt };
  }

  if (!CATEGORY_MIMES[category].has(sniffed.mime)) {
    return {
      ok: false,
      reason: `This file type isn't allowed here. You can upload ${CATEGORY_LABEL[category]}.`,
    };
  }

  if (fileExt && EXT_TO_MIME[fileExt] && !extMatches(sniffed.ext, fileExt)) {
    return {
      ok: false,
      reason:
        "The file's name doesn't match its actual contents (for example, a program renamed to look like an image), so it was rejected.",
    };
  }

  if (sniffed.mime === "image/svg+xml" && svgLooksDangerous(buf)) {
    return {
      ok: false,
      reason: "This SVG contains active content (scripts) and was rejected for safety.",
    };
  }

  if (
    (sniffed.mime === "image/png" ||
      sniffed.mime === "image/jpeg" ||
      sniffed.mime === "image/gif" ||
      sniffed.mime === "image/webp") &&
    imageLooksPolyglot(buf)
  ) {
    return {
      ok: false,
      reason: "This image contains embedded web content and was rejected for safety.",
    };
  }

  return { ok: true, mime: sniffed.mime, ext: sniffed.ext };
}

/**
 * Join `name` onto `dir` and verify the result stays inside `dir`.
 * Defense-in-depth for any filename-derived path (throws on traversal).
 */
export function resolveWithinDir(dir: string, name: string): string {
  const abs = resolve(dir, name);
  const root = resolve(dir);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error("Path escapes its directory");
  }
  return abs;
}
