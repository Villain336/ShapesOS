// Marketr — Phase 10 M9: Expert knowledge base ("think like expert marketers").
//
// A vetted, versioned corpus of marketing expertise that the Chief Strategy
// Agent, missions, and playbooks retrieve from — so Marketr reasons with
// expert patterns, not just data. Retrieval is always source-attributed.
//
// Clean-sourcing tiers are BINDING (docs/specs/SPEC-PHASE10.md §M9, enforced in tests):
//   Tier 1 — official platform materials. Only CC-BY-4.0 (Google Search
//     Central) may be ingested verbatim. Every other academy is learn-only.
//   Tier 2 — openly-licensed / public-domain. Shippable with attribution.
//   Tier 3 — paywalled courses/books. NEVER touches the shipped corpus.
//   🚫 Never: ripped/pirated PDFs (the Anthropic $1.5B settlement pattern).
//
// Storage: file-based, versioned, OUTSIDE the database. The database got no
// new tables for the corpus (schema frozen — see task + AGENTS.md). Chunks
// live as JSONL under data/corpus/ (manifest committed; chunk files
// committed while small, gitignored if large — see store.ts). The corpus is
// workspace-AGNOStic: a product asset, not tenant data. Per-workspace
// retrieval usage is logged through the mission audit log (the Chief
// Strategy Agent's dispatch observations carry the expert_corpus citations).

/** Shippable license kinds. NC/ND licenses are deliberately absent. */
export type CorpusLicenseKind =
  | "CC-BY-4.0"
  | "CC-BY-3.0"
  | "CC-BY-SA-4.0"
  | "CC-BY-SA-2.5"
  | "CC0-1.0"
  | "MIT"
  | "ISC"
  | "BSD-3"
  | "Apache-2.0"
  | "OFL-1.1"
  | "OGL-3.0"
  | "W3C-Document"
  | "public-domain";

/** Provenance carried on EVERY chunk. License metadata is mandatory — a
 *  chunk without it fails ingest (enforced by assertProvenanceComplete and
 *  by test). BY/BY-SA licenses require the license URL.
 *
 *  Tier "1S" chunks are Marketr-ORIGINAL synthesis playbooks distilled from
 *  learn-only sources (docs/specs/SPEC-PHASE10.md §M9, Tico 2026-09-26): genuinely
 *  original words, sources cited, no copying, no close paraphrase. A 1S
 *  chunk MUST carry synthesizedFrom (source titles), synthesisDate, and
 *  original: true — enforced by the chunker. 1S text is authored by
 *  Marketr and licensed CC-BY-4.0. */
export interface ChunkProvenance {
  /** Stable registry id, e.g. "google-search-central". */
  sourceId: string;
  sourceTitle: string;
  author: string;
  license: CorpusLicenseKind;
  licenseUrl: string;
  /** Where the material was fetched from ("" for 1S originals). */
  sourceUrl: string;
  /** Clean-sourcing tier: 1, 2, or "1S" (Marketr-original synthesis). */
  tier: 1 | 2 | "1S";
  /** True when the chunk lives in the separately-licensed BY-SA asset. */
  segregatedAsset: boolean;
  /** ISO date the source material was retrieved (or synthesized). */
  retrievedDate: string;
  /** 1S only: the learn-only source titles this chunk was distilled from. */
  synthesizedFrom?: string[];
  /** 1S only: ISO date the synthesis was written. */
  synthesisDate?: string;
  /** 1S only: must be true — marks Marketr-original expression. */
  original?: boolean;
  /** 1S only: how the synthesis was grounded — "parametric" (model knowledge +
   *  catalog metadata) or "catalog-only" (catalog description only, no parametric
   *  specifics). Honest depth labeling for the v9 synthesis wave (2026-09-27). */
  synthesisDepth?: string;
  /** 1S only: true when the underlying source carries a non-commercial license
   *  class (ideas distilled, original expression; NC flag preserved for honesty). */
  ncFlaggedSource?: boolean;
}

export interface CorpusChunk {
  /** Stable id: `${sourceId}#${chunkIndex}`. */
  id: string;
  text: string;
  provenance: ChunkProvenance;
  /** Heading path at chunk time, e.g. ["SEO Starter Guide", "Crawl"] — aids
   *  attribution context; preserved by the chunker. */
  headingPath: string[];
  chunkIndex: number;
  /** Character offset of the chunk within the cleaned source document. */
  charOffset: number;
  /** 384-d L2-normalized MiniLM embedding. Null only for legacy/manual
   *  chunks; retrieval skips chunks without embeddings. */
  embedding: number[] | null;
}

/** The exact public retrieval shape (see index.ts — do not widen). */
export interface ExpertHit {
  text: string;
  sourceTitle: string;
  author: string;
  license: CorpusLicenseKind;
}

export type SourceStatus = "active" | "pending";

/** Acquisition status for cataloged (v8+) sources. "ingested" = chunks in
 *  the corpus; the other three = metadata-only, zero chunks, never ingested. */
export type CatalogStatus =
  | "ingested"
  | "rights-review-pending"
  | "acquisition-pending"
  | "segregated";

export interface CorpusSourceRecord {
  id: string;
  title: string;
  author: string;
  tier: 1 | 2 | "learn-only";
  license: CorpusLicenseKind | "learn-only" | "unverified";
  licenseUrl: string;
  sourceUrl: string;
  status: SourceStatus;
  /** How the source ships: verbatim ingest vs Marketr-original 1S synthesis. */
  mode: "verbatim" | "synthesis-1s";
  /** Required when status === "pending": why this source isn't ingested. */
  pendingReason?: string;
  /** Chunks ingested for this source (0 when pending). */
  chunks: number;
  /** Corpus version at which the source was last (re)ingested. */
  version: number;
  retrievedDate: string;
  /** True for BY-SA material: lives in data/corpus/by-sa/, separately licensed. */
  segregatedAsset: boolean;
  // ── v8 catalog fields (optional; present on sources from the 2026-09-26
  // source-library intake) ──
  /** Corpus pillar for brain placement (v8+; older records resolve via the
   *  allowlist registry fallback in graph.ts). */
  pillar?: "marketing" | "growth" | "design";
  /** v8 acquisition status. Absent = pre-v8 record (ingested or learn-only). */
  catalogStatus?: CatalogStatus;
  /** The catalog's own license class label, e.g. "OPEN (verify)". */
  catalogLicenseClass?: string;
  /** Exact license-basis text from the catalog (verbatim, for cataloged sources). */
  catalogLicenseBasis?: string;
  /** Canonical access URL from the source catalog. */
  catalogUrl?: string;
  /** ISO date the source's chunks were actually ingested (ingested only). */
  ingestedAt?: string;
}

/** Versioned manifest. corpusVersion increments ONLY when sources change
 *  (a source added/removed/re-fetched) — never on reads or evals. */
export interface CorpusManifest {
  corpusVersion: number;
  updatedAt: string;
  /** Chunk counts by asset dir. */
  assets: { main: number; "by-sa": number };
  sources: CorpusSourceRecord[];
  /** Latest eval precision (scripts/eval-corpus.mts), null until run. */
  evalPrecision: number | null;
  evalRunAt: string | null;
}
