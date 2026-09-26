// Marketr — Phase 10 M9: heading-aware chunking with provenance preservation.
//
// docs/text/markdown → cleaned text → heading-aware chunks. Every chunk
// carries the FULL provenance record copied from its source (never a
// reference that can drift). assertProvenanceComplete() fails loudly when
// any license field is missing — a chunk without license metadata must
// never reach the store.

import type { ChunkProvenance, CorpusChunk, CorpusLicenseKind } from "./types";

/** Target chunk size ~1,200 chars; sections merge up to this ceiling. */
export const CHUNK_TARGET_CHARS = 1200;
/** Sections below this are merged into a neighbor rather than standing alone. */
export const CHUNK_MIN_CHARS = 200;

interface Section {
  headingPath: string[];
  text: string;
}

/**
 * Split cleaned text into heading-aware sections. Markdown headings (#…)
 * start new sections; plain-text documents fall back to paragraph runs and
 * ALL-CAPS/Title-case line heuristics for book-style chapter breaks.
 */
export function splitSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let current: Section = { headingPath: [], text: "" };

  const push = () => {
    const t = current.text.trim();
    if (t.length > 0) sections.push({ headingPath: [...current.headingPath], text: t });
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const md = /^(#{1,6})\s+(.+)$/.exec(line);
    if (md) {
      push();
      const level = md[1]!.length;
      const title = md[2]!.trim();
      const path = current.headingPath.slice(0, level - 1);
      path.push(title);
      current = { headingPath: path, text: "" };
      continue;
    }
    // Book-style chapter breaks: short ALL-CAPS or "Chapter N" lines.
    if (
      line.length > 0 &&
      line.length < 80 &&
      (/^CHAPTER\s+[IVX0-9]+/i.test(line) ||
        (/^[A-Z][A-Z\s'’.,&-]{4,}$/.test(line) && !/[.!?]$/.test(line)))
    ) {
      push();
      current = { headingPath: [line], text: "" };
      continue;
    }
    current.text += rawLine + "\n";
  }
  push();
  return sections;
}

export function assertProvenanceComplete(p: ChunkProvenance): void {
  const missing: string[] = [];
  if (!p.sourceId) missing.push("sourceId");
  if (!p.sourceTitle) missing.push("sourceTitle");
  if (!p.author) missing.push("author");
  if (!p.license) missing.push("license");
  if (!p.licenseUrl) missing.push("licenseUrl");
  if (!p.sourceUrl && p.tier !== "1S") missing.push("sourceUrl");
  if (p.tier !== 1 && p.tier !== 2 && p.tier !== "1S") missing.push("tier");
  if (!p.retrievedDate) missing.push("retrievedDate");
  // Tier 1S (Marketr-original synthesis): the three 1S markers are
  // mandatory — a synthesis chunk must prove its originality pedigree.
  if (p.tier === "1S") {
    if (!p.synthesizedFrom || p.synthesizedFrom.length === 0) missing.push("synthesizedFrom");
    if (!p.synthesisDate) missing.push("synthesisDate");
    if (p.original !== true) missing.push("original:true");
  }
  if (missing.length > 0) {
    throw new Error(
      `[corpus] provenance incomplete for source "${p.sourceId || "(unknown)"}": missing ${missing.join(", ")}. ` +
        "License metadata is mandatory on every chunk — ingest aborted.",
    );
  }
}

/**
 * Chunk one cleaned source document. Returns chunks with provenance copied
 * onto every chunk (asserted complete). charOffset tracks position in the
 * cleaned document; chunk ids are `${sourceId}#${index}`.
 */
export function chunkDocument(
  cleanedText: string,
  provenance: ChunkProvenance,
  opts?: { targetChars?: number; minChars?: number },
): CorpusChunk[] {
  assertProvenanceComplete(provenance);
  const target = opts?.targetChars ?? CHUNK_TARGET_CHARS;
  const min = opts?.minChars ?? CHUNK_MIN_CHARS;

  const sections = splitSections(cleanedText);
  // Merge tiny sections into the following section (keeps heading context).
  const merged: Section[] = [];
  for (const s of sections) {
    const prev = merged[merged.length - 1];
    if (prev && prev.text.length < min && s.text.length + prev.text.length <= target) {
      prev.text = prev.text + "\n\n" + s.text;
      if (prev.headingPath.length === 0) prev.headingPath = s.headingPath;
    } else {
      merged.push(s);
    }
  }

  const chunks: CorpusChunk[] = [];
  let offset = 0;
  for (const s of merged) {
    // Split oversized sections on paragraph boundaries.
    const parts: string[] = [];
    if (s.text.length <= target) {
      parts.push(s.text);
    } else {
      let buf = "";
      for (const para of s.text.split(/\n{2,}/)) {
        if ((buf + "\n\n" + para).trim().length > target && buf.length >= min) {
          parts.push(buf.trim());
          buf = para;
        } else {
          buf = buf ? buf + "\n\n" + para : para;
        }
      }
      if (buf.trim()) parts.push(buf.trim());
    }
    for (const part of parts) {
      const t = part.trim();
      if (t.length < min) {
        // Last runt: glue to the previous chunk if one exists.
        const last = chunks[chunks.length - 1];
        if (last && (last.text + "\n\n" + t).length <= target * 1.5) {
          last.text = last.text + "\n\n" + t;
          continue;
        }
        if (t.length === 0) continue;
      }
      chunks.push({
        id: `${provenance.sourceId}#${chunks.length}`,
        text: t,
        provenance: { ...provenance },
        headingPath: [...s.headingPath],
        chunkIndex: chunks.length,
        charOffset: offset,
        embedding: null,
      });
      offset += t.length;
    }
  }
  return chunks;
}

/** Strip HTML to readable text (GSC docs, pressbooks, SBA, FTC HTML pages). */
export function htmlToText(html: string): string {
  // Google devsite pages wrap the article in
  // <devsite-content><article class="devsite-article">…</article></devsite-content>.
  // The header, side nav (book-nav), in-page TOC, feedback widgets and footers
  // are <devsite-*> CUSTOM elements that the generic <nav>/<header> stripping
  // below misses. In corpus v2 that leaked ko-locale nav chrome (the language
  // selector, "Skip to main content", devsite-toc) into ~30 GSC chunks —
  // extracting the article itself drops ALL chrome in one step.
  const devsiteArticle = html.match(
    /<article\b[^>]*class="[^"]*\bdevsite-article\b[^"]*"[^>]*>([\s\S]*?)<\/article>/i,
  );
  let t = (devsiteArticle ? devsiteArticle[0] : html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // Drop any surviving devsite custom elements (devsite-heading-link,
  // devsite-toc, devsite-thumb-rating…) — their inner text is link chrome.
  t = t.replace(/<devsite-[a-z-]+(?:\s[^>]*)?>[\s\S]*?<\/devsite-[a-z-]+>/gi, " ");
  // Google devsite's in-article breadcrumb trail ("Home › Search Central ›
  // Documentation …") is CLASS-based, so the custom-element strip above
  // misses it — it landed in google-search-central#0 as nav boilerplate.
  t = t.replace(
    /<li[^>]*class="[^"]*\bdevsite-breadcrumb-item\b[^"]*"[^>]*>[\s\S]*?<\/li>/gi,
    " ",
  );
  // Preserve heading semantics for the chunker.
  t = t
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n")
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n\n#### $1\n\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/p>|<br\s*\/?>/gi, "\n\n");
  t = t.replace(/<[^>]+>/g, " ");
  return t
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&rsquo;/g, "’")
    .replace(/&lsquo;/g, "‘")
    .replace(/&rdquo;/g, "”")
    .replace(/&ldquo;/g, "“")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Clean plain text (Gutenberg / raw README): normalize whitespace, strip
 *  Gutenberg header/footer boilerplate. */
export function plainTextClean(raw: string): string {
  let t = raw.replace(/\r\n/g, "\n");
  // Strip Project Gutenberg header.
  const startMarkers = [
    "*** START OF THIS PROJECT GUTENBERG EBOOK",
    "*** START OF THE PROJECT GUTENBERG EBOOK",
  ];
  for (const m of startMarkers) {
    const i = t.indexOf(m);
    if (i >= 0) {
      const nl = t.indexOf("\n", i);
      t = t.slice(nl + 1);
      break;
    }
  }
  // Strip Project Gutenberg footer.
  const endIdx = t.search(/\*\*\* END OF (THIS|THE) PROJECT GUTENBERG EBOOK/);
  if (endIdx >= 0) t = t.slice(0, endIdx);
  // De-hyphenate line-wrapped books; collapse whitespace.
  t = t.replace(/([a-z])-\n([a-z])/g, "$1$2");
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

export type { CorpusLicenseKind };
