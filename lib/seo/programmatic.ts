// Marketr — programmatic SEO engine (milestone 17).
//
// Pure functions only: no database, no network. Template variable
// substitution ({{var}} with {{var|fallback}} fallbacks), slug building,
// CSV parsing, Tiptap helpers, content hashing, and quality-gate evaluation.
//
// Template sources of truth:
//   - urlPattern e.g. "/services/{{city}}/{{service}}" (single-brace
//     {city} is also accepted and normalized)
//   - titleTemplate / descriptionTemplate (plain text with {{vars}})
//   - contentBlocks (Tiptap JSON doc; leaf text may contain {{vars}})

import { createHash } from "node:crypto";

export const MAX_DATASET_ROWS = 10_000;
export const GENERATE_CHUNK_SIZE = 500;
export const PREVIEW_DEFAULT_LIMIT = 5;
export const MAX_SLUG_SEGMENT_LENGTH = 96;

/** Quality flags stored on ProgrammaticPage.qualityFlags (string[]). */
export const QUALITY_FLAGS = {
  missingVariable: "missing_variable",
  thinContent: "thin_content",
  duplicateContent: "duplicate_content",
  slugCollision: "slug_collision",
} as const;

export interface TemplateVariable {
  name: string;
  fallback?: string;
}

/**
 * Accept the single-brace form {var} in URL patterns (spec example) and
 * normalize it to {{var}}. Leaves existing {{var}} untouched.
 */
export function normalizeUrlPattern(pattern: string): string {
  return pattern.replace(/(?<!\{)\{([A-Za-z_][A-Za-z0-9_]*)\}(?!\})/g, "{{$1}}");
}

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)(?:\|([^}]*))?\s*\}\}/g;

/** Extract {{variables}} (with optional |fallback) from any number of texts. */
export function extractVariables(...texts: string[]): TemplateVariable[] {
  const seen = new Map<string, TemplateVariable>();
  for (const text of texts) {
    if (!text) continue;
    VAR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = VAR_RE.exec(text)) !== null) {
      const name = m[1];
      const fallback = m[2] !== undefined ? m[2] : undefined;
      const existing = seen.get(name);
      if (!existing) {
        seen.set(name, fallback !== undefined ? { name, fallback } : { name });
      } else if (existing.fallback === undefined && fallback !== undefined) {
        existing.fallback = fallback;
      }
    }
  }
  return [...seen.values()];
}

/** Variables that have no fallback — the row MUST provide them. */
export function requiredVariables(vars: TemplateVariable[]): string[] {
  return vars.filter((v) => v.fallback === undefined).map((v) => v.name);
}

/** Lowercase, strip diacritics, non-alphanumerics → hyphens. */
export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_SEGMENT_LENGTH)
    .replace(/-+$/g, "");
  return slug || "page";
}

export interface SubstitutionResult {
  text: string;
  /** Required variables (no fallback) that the row did not provide. */
  missing: string[];
}

/**
 * Substitute {{var}} / {{var|fallback}} against row values. Missing values
 * with no fallback render as "" and are reported in `missing`.
 */
export function substitute(
  text: string,
  values: Record<string, string | null | undefined>,
): SubstitutionResult {
  const missing: string[] = [];
  const out = text.replace(VAR_RE, (_full, name: string, fallback: string | undefined) => {
    const raw = values[name];
    const value = raw == null ? "" : String(raw).trim();
    if (value) return value;
    if (fallback !== undefined) return fallback;
    if (!missing.includes(name)) missing.push(name);
    return "";
  });
  return { text: out, missing };
}

/**
 * Build the substituted URL path for a row. Each path segment is slugified
 * (so "New York" → "new-york"), duplicate slashes collapsed, leading slash
 * enforced. Returns the path, the template-scoped slug key, and missing vars.
 */
export function buildPageUrl(
  urlPattern: string,
  values: Record<string, string | null | undefined>,
): { url: string; slug: string; missing: string[] } {
  const normalized = normalizeUrlPattern(urlPattern);
  const { text, missing } = substitute(normalized, values);
  // Slugify every segment. An empty segment (e.g. from a missing variable)
  // becomes "page" — it is never silently dropped, so a missing variable
  // can never shorten a URL into a collision with a real page.
  const rawSegments = text.split("/").filter((s, i) => !(i === 0 && s === ""));
  const segments = rawSegments.map((s) => slugify(s.trim()));
  const url = "/" + segments.join("/");
  // Slug key = full path (template-scoped uniqueness). Empty → "page".
  const slug = segments.length > 0 ? segments.join("/") : "page";
  return { url, missing, slug };
}

/** Map dataset columns to template variables. Auto-maps by name match. */
export function resolveRowValues(
  variables: string[],
  columns: string[],
  row: Record<string, string | null | undefined>,
  columnMapping?: Record<string, string>,
): Record<string, string> {
  const lowerCols = new Map(columns.map((c) => [c.toLowerCase(), c]));
  const values: Record<string, string> = {};
  for (const v of variables) {
    const mapped = columnMapping?.[v];
    const col =
      mapped ??
      lowerCols.get(v.toLowerCase()) ??
      lowerCols.get(v.toLowerCase().replace(/_/g, " ")) ??
      lowerCols.get(v.toLowerCase().replace(/_/g, ""));
    const raw = col != null ? row[col] : undefined;
    values[v] = raw == null ? "" : String(raw);
  }
  return values;
}

// ---------------------------------------------------------------------------
// CSV parsing (server-side, dependency-free)
// ---------------------------------------------------------------------------

export interface ParsedCsv {
  columns: string[];
  rows: Record<string, string>[];
}

/**
 * RFC-4180-ish CSV parser: quoted fields, escaped quotes (""), commas and
 * newlines inside quotes, CRLF/LF. Returns header + row objects.
 */
export function parseCsv(text: string): ParsedCsv {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  // Strip BOM.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
    } else if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
    } else if (ch === "\r" || ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  // Trailing field/row.
  if (field !== "" || row.length > 0 || inQuotes) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully-empty rows (trailing newline).
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) return { columns: [], rows: [] };
  const columns = nonEmpty[0].map((c) => c.trim());
  const out: Record<string, string>[] = [];
  for (const r of nonEmpty.slice(1)) {
    const obj: Record<string, string> = {};
    columns.forEach((c, idx) => {
      obj[c] = (r[idx] ?? "").trim();
    });
    out.push(obj);
  }
  return { columns, rows: out };
}

// ---------------------------------------------------------------------------
// Tiptap helpers
// ---------------------------------------------------------------------------

interface TiptapNode {
  type?: string;
  text?: string;
  content?: TiptapNode[];
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
}

function isTiptapNode(v: unknown): v is TiptapNode {
  return typeof v === "object" && v !== null;
}

function nodeText(node: TiptapNode): string {
  if (typeof node.text === "string") return node.text;
  const parts: string[] = [];
  for (const child of node.content ?? []) {
    if (!isTiptapNode(child)) continue;
    if (child.type === "hardBreak") {
      parts.push("\n");
    } else {
      parts.push(nodeText(child));
    }
    // Block-level separation.
    if (
      ["paragraph", "heading", "bulletList", "orderedList", "blockquote"].includes(
        child.type ?? "",
      )
    ) {
      parts.push("\n");
    }
  }
  return parts.join("");
}

/** Plain text of a Tiptap doc (whitespace-collapsed). */
export function tiptapText(doc: unknown): string {
  if (!isTiptapNode(doc)) return "";
  return nodeText(doc).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Word count of a Tiptap doc. */
export function tiptapWordCount(doc: unknown): number {
  const text = tiptapText(doc);
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(node: TiptapNode): string {
  if (typeof node.text === "string") {
    let html = escapeHtml(node.text);
    for (const mark of node.marks ?? []) {
      if (mark.type === "bold") html = `<strong>${html}</strong>`;
      else if (mark.type === "italic") html = `<em>${html}</em>`;
      else if (mark.type === "underline") html = `<u>${html}</u>`;
      else if (mark.type === "strike") html = `<s>${html}</s>`;
      else if (mark.type === "code") html = `<code>${html}</code>`;
      else if (mark.type === "link") {
        const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "#";
        html = `<a href="${escapeHtml(href)}">${html}</a>`;
      }
    }
    return html;
  }
  return (node.content ?? []).map(renderInline).join("");
}

function renderBlock(node: TiptapNode): string {
  const inner = (node.content ?? []).map(renderInline).join("");
  switch (node.type) {
    case "heading": {
      const level = node.attrs?.level === 2 ? 2 : node.attrs?.level === 3 ? 3 : 1;
      return `<h${level}>${inner}</h${level}>`;
    }
    case "bulletList":
      return `<ul>${(node.content ?? []).map((li) => `<li>${(li.content ?? []).map(renderBlock).join("")}</li>`).join("")}</ul>`;
    case "orderedList":
      return `<ol>${(node.content ?? []).map((li) => `<li>${(li.content ?? []).map(renderBlock).join("")}</li>`).join("")}</ol>`;
    case "blockquote":
      return `<blockquote>${inner}</blockquote>`;
    case "codeBlock":
      return `<pre><code>${inner}</code></pre>`;
    case "horizontalRule":
      return `<hr/>`;
    case "hardBreak":
      return `<br/>`;
    case "paragraph":
    default:
      return inner ? `<p>${inner}</p>` : "";
  }
}

/**
 * Minimal Tiptap JSON → HTML renderer (server-safe, no DOM needed).
 * Covers paragraph/heading/lists/quote/code + common inline marks.
 */
export function tiptapToHtml(doc: unknown): string {
  if (!isTiptapNode(doc) || !Array.isArray(doc.content)) return "";
  return doc.content.map(renderBlock).filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Simple block editor interchange
// ---------------------------------------------------------------------------

export interface SimpleBlock {
  type: "paragraph" | "h1" | "h2" | "h3" | "bullet";
  text: string;
}

const SIMPLE_TYPE_TO_TIPTAP: Record<SimpleBlock["type"], { type: string; attrs?: Record<string, unknown> }> = {
  paragraph: { type: "paragraph" },
  h1: { type: "heading", attrs: { level: 1 } },
  h2: { type: "heading", attrs: { level: 2 } },
  h3: { type: "heading", attrs: { level: 3 } },
  bullet: { type: "paragraph" }, // wrapped in bulletList below
};

/** Convert the template editor's simple blocks into a Tiptap doc. */
export function simpleBlocksToTiptap(blocks: SimpleBlock[]): object {
  const content: TiptapNode[] = [];
  for (const b of blocks) {
    if (b.type === "bullet") {
      content.push({
        type: "bulletList",
        content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: b.text }] }] }],
      });
    } else {
      const mapped = SIMPLE_TYPE_TO_TIPTAP[b.type];
      content.push({
        ...mapped,
        content: [{ type: "text", text: b.text }],
      });
    }
  }
  return { type: "doc", content };
}

/** Convert a Tiptap doc back to simple blocks for the template editor. */
export function tiptapToSimpleBlocks(doc: unknown): SimpleBlock[] {
  if (!isTiptapNode(doc) || !Array.isArray(doc.content)) return [];
  const out: SimpleBlock[] = [];
  for (const node of doc.content) {
    if (node.type === "bulletList") {
      for (const li of node.content ?? []) {
        const p = li.content?.find((c) => c.type === "paragraph") ?? li.content?.[0];
        if (p) out.push({ type: "bullet", text: tiptapText(p) });
      }
    } else if (node.type === "heading") {
      const level = node.attrs?.level;
      out.push({
        type: level === 2 ? "h2" : level === 3 ? "h3" : "h1",
        text: tiptapText(node),
      });
    } else if (node.type === "paragraph") {
      out.push({ type: "paragraph", text: tiptapText(node) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Content hashing + quality gates
// ---------------------------------------------------------------------------

/** Deterministic sha256 of substituted page content (whitespace-collapsed). */
export function hashPageContent(parts: { title: string; description: string; blocks: unknown }): string {
  const canonical = JSON.stringify({
    title: parts.title.replace(/\s+/g, " ").trim(),
    description: parts.description.replace(/\s+/g, " ").trim(),
    blocks: tiptapText(parts.blocks).replace(/\s+/g, " ").trim(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Share (0–1) of hashes that appear more than once. Null/empty hashes are
 * ignored. 0 when fewer than 2 hashed pages.
 */
export function duplicateRate(hashes: (string | null | undefined)[]): number {
  const counts = new Map<string, number>();
  for (const h of hashes) {
    if (!h) continue;
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  let dup = 0;
  let total = 0;
  for (const c of counts.values()) {
    total += c;
    if (c > 1) dup += c;
  }
  return total < 2 ? 0 : dup / total;
}

export interface TemplateLike {
  urlPattern: string;
  titleTemplate: string;
  descriptionTemplate: string;
  contentBlocks: unknown;
  minWordCount: number;
  duplicateRateCap: number;
}

export interface GeneratedPage {
  url: string;
  slug: string;
  title: string;
  description: string;
  contentBlocks: unknown;
  wordCount: number;
  contentHash: string;
  canonical: string;
  missingVariables: string[];
  /** Flags computable per-page (duplicate_content resolved at batch level). */
  flags: string[];
}

/** All variables a template needs (url + title + description + blocks). */
export function templateVariables(t: Pick<TemplateLike, "urlPattern" | "titleTemplate" | "descriptionTemplate" | "contentBlocks">): TemplateVariable[] {
  return extractVariables(
    normalizeUrlPattern(t.urlPattern),
    t.titleTemplate,
    t.descriptionTemplate,
    tiptapText(t.contentBlocks),
  );
}

/**
 * Generate one page from a template + resolved row values. Duplicate-content
 * and slug-collision flags are resolved by the caller (batch level).
 */
export function generatePage(
  template: TemplateLike,
  rowValues: Record<string, string>,
  siteOrigin: string,
): GeneratedPage {
  const vars = templateVariables(template);
  const { url, slug, missing: urlMissing } = buildPageUrl(template.urlPattern, rowValues);
  const title = substitute(template.titleTemplate, rowValues);
  const description = substitute(template.descriptionTemplate, rowValues);

  // Substitute variables inside the Tiptap blocks (leaf text nodes).
  const substitutedBlocks = substituteTiptapText(template.contentBlocks, rowValues);
  const blocksMissing = substitutedBlocks.missing;
  const blocksText = tiptapText(substitutedBlocks.doc);

  const missingVariables = [...new Set([...urlMissing, ...title.missing, ...description.missing, ...blocksMissing])];
  const wordCount = blocksText.split(/\s+/).filter(Boolean).length
    + title.text.split(/\s+/).filter(Boolean).length
    + description.text.split(/\s+/).filter(Boolean).length;
  const contentHash = hashPageContent({ title: title.text, description: description.text, blocks: substitutedBlocks.doc });

  const flags: string[] = [];
  if (missingVariables.length > 0) flags.push(QUALITY_FLAGS.missingVariable);
  if (wordCount < template.minWordCount) flags.push(QUALITY_FLAGS.thinContent);

  const origin = siteOrigin.replace(/\/+$/, "");
  return {
    url,
    slug,
    title: title.text,
    description: description.text,
    contentBlocks: substitutedBlocks.doc,
    wordCount,
    contentHash,
    canonical: `${origin}${url}`,
    missingVariables,
    flags,
  };
}

/** Deep-substitute {{vars}} in every text leaf of a Tiptap doc. */
export function substituteTiptapText(
  doc: unknown,
  values: Record<string, string | null | undefined>,
): { doc: unknown; missing: string[] } {
  const missing: string[] = [];
  function visit(node: unknown): unknown {
    if (!isTiptapNode(node)) return node;
    const out: TiptapNode = { ...node };
    if (typeof node.text === "string" && VAR_RE.test(node.text)) {
      VAR_RE.lastIndex = 0;
      const r = substitute(node.text, values);
      out.text = r.text;
      for (const m of r.missing) if (!missing.includes(m)) missing.push(m);
    }
    if (Array.isArray(node.content)) out.content = node.content.map(visit) as TiptapNode[];
    return out;
  }
  return { doc: visit(doc), missing };
}

export interface GateEvaluation {
  pass: boolean;
  reasons: string[];
}

/**
 * Server-side quality gates for approve (ready) and publish.
 * `checkDuplicateRate` is true on publish (template-wide cap), false on approve.
 */
export function evaluateGates(opts: {
  flags: string[];
  missingVariables: string[];
  wordCount: number;
  minWordCount: number;
  templateDuplicateRate: number;
  duplicateRateCap: number;
  checkDuplicateRate: boolean;
}): GateEvaluation {
  const reasons: string[] = [];
  if (opts.flags.includes(QUALITY_FLAGS.missingVariable)) {
    reasons.push(
      `Missing required variables: ${opts.missingVariables.join(", ") || "unknown"}`,
    );
  }
  if (opts.flags.includes(QUALITY_FLAGS.thinContent)) {
    reasons.push(`Thin content: ${opts.wordCount} words (minimum ${opts.minWordCount})`);
  }
  if (opts.flags.includes(QUALITY_FLAGS.duplicateContent)) {
    reasons.push("Duplicate of another generated page (identical content hash)");
  }
  if (opts.flags.includes(QUALITY_FLAGS.slugCollision)) {
    reasons.push("URL slug collides with another page from this template");
  }
  if (
    opts.checkDuplicateRate &&
    opts.templateDuplicateRate > opts.duplicateRateCap
  ) {
    reasons.push(
      `Template duplicate rate ${(opts.templateDuplicateRate * 100).toFixed(1)}% exceeds cap ${(opts.duplicateRateCap * 100).toFixed(1)}%`,
    );
  }
  return { pass: reasons.length === 0, reasons };
}
