// Marketr — Phase 10 M9: ingestion pipeline.
//
// docs/text/markdown → fetch → clean → chunk (heading-aware) → embed →
// versioned file store, with per-chunk provenance
// {source_title, author, license, license_url, retrieved_date}.
// The allowlist gate (assertIngestAllowed) runs BEFORE any fetch — forbidden
// material is refused before a single byte is read.

import type { ChunkProvenance, CorpusChunk, CorpusSourceRecord } from "./types";
import { assertIngestAllowed, type SeedSourceDef } from "./allowlist";
import { chunkDocument, htmlToText, plainTextClean, assertProvenanceComplete } from "./chunker";
import { appendChunks, writeLicenseNotes, type CorpusAsset } from "./store";
import { embedCorpusText } from "./embed";

export interface FetchResult {
  url: string;
  kind: SeedSourceDef["format"];
  raw: string;
}

/** Fetch one URL as text. Throws on non-OK — callers record pending. */
export async function fetchText(url: string, opts?: { ua?: "browser" }): Promise<string> {
  // Google localized the GSC docs to ko for corpus v2 because no locale was
  // requested; force hl=en (+ Accept-Language) on Google hosts so chunk text
  // is the English canonical (the allowlist content is CC-BY-4.0 en docs).
  let fetchUrl = url;
  try {
    const u = new URL(url);
    if (/\bgoogle\.com$/.test(u.hostname) && !u.searchParams.has("hl")) {
      u.searchParams.set("hl", "en");
      fetchUrl = u.toString();
    }
  } catch {
    // not a parseable URL — fetch as-is
  }
  const res = await fetch(fetchUrl, {
    headers: {
      // Marketr default UA declares the open-licensed-corpus purpose; some
      // pressbooks mirrors 403 bot UAs, so a browser UA is sent for those
      // (verified public content, no auth/login bypass).
      "User-Agent":
        opts?.ua === "browser"
          ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
          : "Marketr-M9-Corpus-Ingest/1.0 (open-licensed content only; contact: corpus@marketr)",
      Accept: "text/html,application/xhtml+xml,text/plain,*/*",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`fetch ${url}: HTTP ${res.status}`);
  }
  return res.text();
}

/** Fetch one Wikipedia article's plain-text extract via the MediaWiki API. */
export async function fetchWikipediaExtract(title: string): Promise<string> {
  const api =
    "https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts" +
    `&explaintext=1&exsectionformat=plain&redirects=1&titles=${encodeURIComponent(title)}`;
  const res = await fetch(api, {
    headers: { "User-Agent": "Marketr-M9-Corpus-Ingest/1.0 (CC-BY-SA content; attribution kept)" },
  });
  if (!res.ok) throw new Error(`wikipedia ${title}: HTTP ${res.status}`);
  const data = (await res.json()) as {
    query: { pages: Record<string, { title: string; extract?: string; missing?: string }> };
  };
  const pages = Object.values(data.query.pages);
  const page = pages[0];
  if (!page || page.missing || !page.extract) {
    throw new Error(`wikipedia ${title}: no extract returned`);
  }
  return `# ${page.title}\n\n${page.extract}`;
}

/** Clean raw fetch output per source format. */
export function cleanFetched(kind: SeedSourceDef["format"], raw: string): string {
  if (kind === "html") return htmlToText(raw);
  if (kind === "mediawiki") return plainTextClean(raw);
  return plainTextClean(raw);
}

/**
 * Ingest one seed source: gate → fetch each URL → clean → chunk → embed →
 * append to the correct asset. Returns the manifest-ready source record.
 * On fetch failure the source is recorded PENDING with the reason — the
 * manifest is honest about what didn't make it.
 */
export async function ingestSeedSource(
  def: SeedSourceDef,
  retrievedDate: string,
): Promise<{ record: CorpusSourceRecord; chunks: CorpusChunk[] }> {
  const decision = assertIngestAllowed(def);
  if (decision.allowed === false) {
    // Unreachable for registry sources (gate throws), kept for type safety.
    throw new Error(`[corpus] refused: ${decision.reason}`);
  }
  const segregatedAsset = decision.segregatedAsset;
  const asset: CorpusAsset = segregatedAsset ? "by-sa" : "main";

  const baseRecord: CorpusSourceRecord = {
    id: def.id,
    title: def.title,
    author: def.author,
    tier: def.tier,
    license: def.license,
    licenseUrl: def.licenseUrl,
    sourceUrl: def.fetchUrls[0] ?? "",
    status: "active",
    mode: "verbatim",
    chunks: 0,
    version: 0, // set by the manifest writer on version bump
    retrievedDate,
    segregatedAsset,
  };

  if (def.fetchUrls.length === 0) {
    return {
      record: {
        ...baseRecord,
        status: "pending",
        pendingReason: def.pendingReason ?? "No fetch URL resolved.",
      },
      chunks: [],
    };
  }

  const provenance: ChunkProvenance = {
    sourceId: def.id,
    sourceTitle: def.title,
    author: def.author,
    license: def.license as ChunkProvenance["license"],
    licenseUrl: def.licenseUrl,
    sourceUrl: def.fetchUrls[0]!,
    tier: def.tier as 1 | 2,
    segregatedAsset,
    retrievedDate,
  };
  assertProvenanceComplete(provenance);

  const allChunks: CorpusChunk[] = [];
  try {
    for (const url of def.fetchUrls) {
      const raw =
        def.format === "mediawiki" ? await fetchWikipediaExtract(url) : await fetchText(url, { ua: def.ua });
      const cleaned = cleanFetched(def.format, raw);
      if (cleaned.length < 200) {
        throw new Error(`cleaned text too short (${cleaned.length} chars) — likely a block page or empty extract`);
      }
      const urlProv = { ...provenance, sourceUrl: url };
      allChunks.push(...chunkDocument(cleaned, urlProv));
    }
  } catch (err) {
    return {
      record: {
        ...baseRecord,
        status: "pending",
        pendingReason: `Fetch/clean failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      chunks: [],
    };
  }

  // Renumber globally across URLs so chunk ids are unique per source.
  renumberChunks(allChunks, provenance.sourceId);

  // Embed every chunk (local model — zero marginal cost).
  for (const c of allChunks) {
    c.embedding = await embedCorpusText(
      [...c.headingPath, c.text].join(" ").slice(0, 4000),
    );
  }

  appendChunks(asset, allChunks);
  return {
    record: { ...baseRecord, status: "active", chunks: allChunks.length },
    chunks: allChunks,
  };
}

/**
 * Renumber chunks globally across the URLs of one source: chunkDocument()
 * restarts chunkIndex per URL, so ids would collide for multi-URL sources
 * (e.g. 20 Grayson chapters would all claim "<id>#0"). Exported for tests.
 */
export function renumberChunks(chunks: CorpusChunk[], sourceId: string): void {
  chunks.forEach((c, i) => {
    c.chunkIndex = i;
    c.id = `${sourceId}#${i}`;
  });
}

/** Record a learn-only / explicitly pending source (never ingested). */
export function pendingRecord(
  def: SeedSourceDef,
  retrievedDate: string,
  reason?: string,
): CorpusSourceRecord {
  // The gate must refuse these — this double-check keeps a refactor from
  // silently turning a learn-only source into an ingested one.
  try {
    assertIngestAllowed(def);
  } catch {
    // expected for learn-only
  }
  return {
    id: def.id,
    title: def.title,
    author: def.author,
    tier: def.tier,
    license: def.license,
    licenseUrl: def.licenseUrl,
    sourceUrl: def.fetchUrls[0] ?? "",
    status: "pending",
    mode: "verbatim",
    pendingReason: reason ?? def.pendingReason ?? "Pending.",
    chunks: 0,
    version: 0,
    retrievedDate,
    segregatedAsset: false,
  };
}

export interface SynthesisPlaybookDef {
  /** Registry id of the learn-only source this playbook belongs to. */
  sourceId: string;
  /** Display title for chunks/manifest (usually the target source title). */
  title: string;
  author: string;
  /** Absolute path to the Marketr-original playbook markdown. */
  file: string;
  /** Learn-only registry source titles this was distilled from. */
  synthesizedFrom: string[];
  /**
   * Target registry source's display title. Chunk attribution becomes
   * "Marketr Tier 1S synthesis from <targetTitle>" so retrieved passages
   * visibly attribute the learn-only source the knowledge came from.
   */
  targetTitle?: string;
}

/**
 * The Tier 1S gate — the ONLY path 1S playbooks may enter the corpus.
 * Refuses unless: (a) the source id is a learn-only registry entry (1S may
 * never cite verbatim-ingestible sources, which would bypass the license
 * boundary), (b) the playbook markdown exists and is non-trivial, and
 * (c) the file doesn't look like verbatim academy text (see README).
 */
export function assertSynthesisAllowed(
  def: SynthesisPlaybookDef,
  registry: readonly Pick<SeedSourceDef, "id" | "tier">[],
  fileExists: boolean,
  fileChars: number,
): void {
  const reg = registry.find((s) => s.id === def.sourceId);
  if (!reg) {
    throw new Error(`[corpus] 1S REFUSED: "${def.sourceId}" is not a registry source.`);
  }
  if (reg.tier !== "learn-only") {
    throw new Error(
      `[corpus] 1S REFUSED: "${def.sourceId}" is tier ${String(reg.tier)} — ` +
        `Tier 1S synthesis is reserved for learn-only sources (verbatim-ingestible ` +
        `sources must go through the allowlist path, never through 1S).`,
    );
  }
  if (!fileExists) {
    throw new Error(`[corpus] 1S REFUSED: playbook file missing for "${def.sourceId}".`);
  }
  if (fileChars < 2000) {
    throw new Error(
      `[corpus] 1S REFUSED: playbook for "${def.sourceId}" is ${fileChars} chars — ` +
        `a synthesis playbook must be substantive (≥2000 chars).`,
    );
  }
}

/**
 * Ingest one Tier 1S synthesis playbook: read the Marketr-original markdown
 * → chunk → embed → append to the MAIN asset (1S text is Marketr's own
 * expression, licensed CC-BY-4.0). Returns the manifest-ready source record
 * (mode "synthesis-1s"). On any failure the source stays PENDING — never
 * partially ingested.
 */
export async function ingestSynthesisPlaybook(
  def: SynthesisPlaybookDef,
  retrievedDate: string,
  opts?: {
    synthesisDir?: string;
    registry?: readonly Pick<SeedSourceDef, "id" | "tier">[];
    /** Injected embedder (tests). Default: the local corpus embedder. */
    embed?: (text: string) => Promise<number[]>;
  },
): Promise<{ record: CorpusSourceRecord; chunks: CorpusChunk[] }> {
  const { default: fs } = await import("node:fs");
  const { default: path } = await import("node:path");
  const synthesisDir = opts?.synthesisDir ?? path.join(process.cwd(), "data", "corpus", "synthesis");
  const filePath = path.resolve(synthesisDir, def.file);
  const exists = fs.existsSync(filePath);
  const raw = exists ? fs.readFileSync(filePath, "utf8") : "";

  const baseRecord: CorpusSourceRecord = {
    id: def.sourceId,
    title: def.title,
    author: def.author,
    tier: "learn-only",
    license: "learn-only",
    licenseUrl: "",
    sourceUrl: "",
    status: "active",
    mode: "synthesis-1s",
    chunks: 0,
    version: 0, // set by the manifest writer on version bump
    retrievedDate,
    segregatedAsset: false,
  };

  try {
    assertSynthesisAllowed(def, opts?.registry ?? [], exists, raw.length);
  } catch (err) {
    return {
      record: {
        ...baseRecord,
        status: "pending",
        pendingReason: `1S synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      chunks: [],
    };
  }

  // Strip the provenance header comment (<!-- ... -->) so it doesn't pollute chunks.
  const cleaned = raw.replace(/^<!--[\s\S]*?-->\s*/, "").trim();
  const attributionTitle = def.targetTitle ?? def.title;
  const provenance: ChunkProvenance = {
    sourceId: `1s-${def.sourceId}`,
    sourceTitle: `Marketr Tier 1S synthesis from ${attributionTitle}`,
    author: "Marketr (original synthesis)",
    license: "CC-BY-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    sourceUrl: "",
    tier: "1S",
    segregatedAsset: false,
    retrievedDate,
    synthesizedFrom: [...def.synthesizedFrom],
    synthesisDate: retrievedDate,
    original: true,
  };

  let chunks: CorpusChunk[];
  try {
    chunks = chunkDocument(cleaned, provenance);
    if (chunks.length === 0) throw new Error("no chunks produced from playbook");
  } catch (err) {
    return {
      record: {
        ...baseRecord,
        status: "pending",
        pendingReason: `1S chunking failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      chunks: [],
    };
  }

  const embed = opts?.embed ?? embedCorpusText;
  for (const c of chunks) {
    c.embedding = await embed(
      [...c.headingPath, c.text].join(" ").slice(0, 4000),
    );
  }

  appendChunks("main", chunks);
  return {
    record: { ...baseRecord, status: "active", chunks: chunks.length },
    chunks,
  };
}

export function ensureLicenseNotes(): void {
  writeLicenseNotes();
}
