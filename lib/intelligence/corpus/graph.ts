// Marketr — Knowledge Brain: graph-data shaping.
//
// Builds the node/edge model for the corpus brain from the workspace-
// agnostic corpus manifest (data/corpus/manifest.json) plus the code
// registry (allowlist.ts: pillar/teaches per source, SYNTHESIS_PLAYBOOKS
// for shared-playbook edges).
//
// DATA-DRIVEN CONTRACT: a new source added to the manifest (or registry)
// appears as a node with zero code changes. Pillar defaults to
// "marketing"; "teaches" falls back to the playbook extract or a generic
// line. Edges derive from manifest fields (author, shared files) only.

import type { CorpusManifest, CorpusSourceRecord } from "./types";
import { SEED_SOURCES, SYNTHESIS_PLAYBOOKS } from "./allowlist";

export type BrainPillar = "marketing" | "growth" | "design";
export type BrainNodeKind = "source" | "proposed" | "removal-flagged" | "catalog";

export interface BrainNode {
  id: string;
  title: string;
  author: string;
  pillar: BrainPillar;
  /** Display tier: "1" | "2" | "1S" (learn-only sources ship as 1S synthesis). */
  tier: "1" | "2" | "1S";
  license: string;
  licenseBasis: string;
  chunks: number;
  status: "active" | "pending";
  mode: "verbatim" | "synthesis-1s";
  teaches: string;
  /** Learn-only origin titles this node was distilled from (1S nodes). */
  synthesizedFrom: string[];
  kind: BrainNodeKind;
  removalReason?: string;
  /** v8 acquisition status for cataloged sources (absent for pre-v8 nodes). */
  catalogStatus?: import("./types").CatalogStatus;
  // ── Provenance (audit center; all real manifest/eval/usage data) ──
  /** Corpus version this source was last (re)ingested under. Null for proposed. */
  manifestVersion: number | null;
  /** ISO date the source material was retrieved/synthesized. Null for proposed. */
  retrievedDate: string | null;
  /** Eval questions where this source was the top hit (0 when eval never ran). */
  evalHits: number;
  /** Real agent retrieval hits via retrieveExpertContext (0 = never retrieved). */
  retrievalHits: number;
}

export interface BrainEdge {
  from: string;
  to: string;
  kind: "shared-playbook" | "same-author" | "proposed-link";
}

export interface BrainGraph {
  version: number;
  updatedAt: string;
  stats: {
    sources: number;
    chunks: number;
    pillars: Record<BrainPillar, number>;
    /** Chunk counts per pillar (audit strip). */
    pillarChunks: Record<BrainPillar, number>;
    proposed: number;
    flagged: number;
    /** v8+ catalog-only sources (metadata only, zero chunks). */
    cataloged: number;
    /** Corpus eval summary (null until scripts/eval-corpus.mts has run). */
    eval: { precision: number; questions: number; correct: number; runAt: string } | null;
    /** Total real agent retrieval hits across all sources. */
    retrievalHitsTotal: number;
  };
  nodes: BrainNode[];
  edges: BrainEdge[];
}

export interface ProposedSource {
  id: string;
  title: string;
  pillar: BrainPillar;
  kind: "url" | "upload" | "text";
  url?: string;
  fileName?: string;
  teaches?: string;
  status: "proposed";
  createdAt: string;
  createdBy: string;
  note?: string;
}

const PILLARS: BrainPillar[] = ["marketing", "growth", "design"];

function pillarOf(record: CorpusSourceRecord): BrainPillar {
  // v8+ records carry their pillar directly on the manifest.
  if (record.pillar && PILLARS.includes(record.pillar)) return record.pillar;
  const def = SEED_SOURCES.find((d) => d.id === record.id);
  if (def?.pillar && PILLARS.includes(def.pillar)) return def.pillar;
  return "marketing";
}

function teachesOf(record: CorpusSourceRecord): string {
  if (
    record.catalogStatus === "rights-review-pending" ||
    record.catalogStatus === "acquisition-pending"
  )
    return "Cataloged source — not yet ingested. It will teach ShapesOS once rights are cleared and the corpus build runs.";
  const def = SEED_SOURCES.find((d) => d.id === record.id);
  if (def?.teaches) return def.teaches;
  if (record.mode === "synthesis-1s")
    return "Marketr-original synthesis of expert practice from this source.";
  return "Licensed reference material for the expert corpus.";
}

function tierOf(record: CorpusSourceRecord): BrainNode["tier"] {
  if (record.mode === "synthesis-1s") return "1S";
  // Catalog-only learn-only sources can only ever enter via 1S synthesis.
  if (record.tier === "learn-only" && record.catalogStatus && record.catalogStatus !== "ingested")
    return "1S";
  return record.tier === 1 ? "1" : "2";
}

function licenseBasisOf(record: CorpusSourceRecord): string {
  // Catalog-only records are honest about not being ingested.
  if (record.catalogStatus === "rights-review-pending")
    return `Cataloged — rights review pending (${record.catalogLicenseClass ?? "license unverified"}). Zero chunks; nothing ingested.`;
  if (record.catalogStatus === "acquisition-pending")
    return `Cataloged acquisition target (${record.catalogLicenseClass ?? "license gated"}). Metadata only; never ingested without clearance.`;
  if (record.mode === "synthesis-1s")
    return "Marketr-original synthesis (CC-BY-4.0); source is learn-only, never ingested verbatim.";
  if (record.license === "public-domain") return "U.S. public domain — shippable verbatim.";
  if (record.license === "CC0-1.0") return "CC0 public domain dedication — shippable verbatim.";
  if (record.license === "CC-BY-4.0" || record.license === "CC-BY-3.0")
    return `${record.license} — shippable verbatim with attribution.`;
  if (record.license === "CC-BY-SA-4.0" || record.license === "CC-BY-SA-2.5")
    return `${record.license} — shippable verbatim into the segregated BY-SA asset only.`;
  if (record.license === "MIT") return "MIT licensed — shippable verbatim with attribution.";
  if (record.license === "ISC") return "ISC licensed — shippable verbatim with attribution.";
  if (record.license === "BSD-3") return "BSD 3-clause — shippable verbatim with attribution.";
  if (record.license === "Apache-2.0") return "Apache 2.0 — shippable verbatim with attribution.";
  if (record.license === "OFL-1.1") return "SIL Open Font License 1.1 — shippable with attribution.";
  if (record.license === "OGL-3.0")
    return "Open Government Licence v3.0 — shippable verbatim with attribution.";
  if (record.license === "W3C-Document")
    return "W3C Document License — shippable verbatim with attribution.";
  return "License recorded in the corpus manifest.";
}

/** Sources (registry ids) sharing one comparative-survey playbook file. */
function sharedPlaybookGroups(): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const d of SEED_SOURCES) {
    const file = d.playbook?.file;
    if (!file) continue;
    const arr = byFile.get(file) ?? [];
    arr.push(d.id);
    byFile.set(file, arr);
  }
  const out = new Map<string, string[]>();
  for (const [file, ids] of byFile) {
    if (ids.length > 1) out.set(file, ids);
  }
  return out;
}

/**
 * Build the brain graph. Pure function of (manifest, proposed, removalIds,
 * audit) — unit-testable without the filesystem. The audit argument is
 * optional: eval summaries, retrieval usage, and per-source eval hits all
 * come from real runtime data loaded by the caller (see activity.ts).
 */
export function buildCorpusGraph(
  manifest: CorpusManifest,
  proposed: ProposedSource[] = [],
  removalIds: Map<string, string> = new Map(),
  audit: {
    eval?: { precision: number; questions: number; correct: number; runAt: string } | null;
    evalHitsBySource?: Map<string, number>;
    retrievalHitsBySource?: Map<string, number>;
  } = {},
): BrainGraph {
  const nodes: BrainNode[] = manifest.sources.map((r) => {
    const playbook = SYNTHESIS_PLAYBOOKS.find((p) => p.sourceId === r.id);
    const flagged = removalIds.get(r.id);
    // v8 catalog-only sources (rights-review-pending / acquisition-pending)
    // render as small rim nodes — visible, honest, zero chunks.
    const isCatalogOnly =
      r.catalogStatus === "rights-review-pending" || r.catalogStatus === "acquisition-pending";
    return {
      id: r.id,
      title: r.title,
      author: r.author,
      pillar: pillarOf(r),
      tier: tierOf(r),
      license: String(r.license),
      licenseBasis: licenseBasisOf(r),
      chunks: r.chunks,
      status: r.status,
      mode: r.mode,
      teaches: teachesOf(r),
      synthesizedFrom: playbook?.synthesizedFrom ?? [],
      kind: isCatalogOnly ? "catalog" : flagged ? "removal-flagged" : "source",
      removalReason: flagged,
      catalogStatus: r.catalogStatus,
      manifestVersion: isCatalogOnly ? null : r.version,
      retrievedDate: isCatalogOnly ? null : r.retrievedDate,
      evalHits: audit.evalHitsBySource?.get(r.id) ?? 0,
      retrievalHits: audit.retrievalHitsBySource?.get(r.id) ?? 0,
    };
  });

  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges: BrainEdge[] = [];

  // Edge kind 1: shared playbook file (e.g. the six enterprise design
  // systems covered by one comparative survey) — satellite → primary.
  for (const [, ids] of sharedPlaybookGroups()) {
    const present = ids.filter((id) => nodeIds.has(id));
    if (present.length > 1) {
      const [primary, ...rest] = present;
      for (const id of rest) edges.push({ from: id, to: primary, kind: "shared-playbook" });
    }
  }

  // Edge kind 2: same non-synthesis author (e.g. Hopkins' two books).
  const byAuthor = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.author === "ShapesOS (original synthesis)") continue;
    const arr = byAuthor.get(n.author) ?? [];
    arr.push(n.id);
    byAuthor.set(n.author, arr);
  }
  for (const [, ids] of byAuthor) {
    if (ids.length > 1) {
      const [first, ...rest] = ids;
      for (const id of rest) edges.push({ from: id, to: first, kind: "same-author" });
    }
  }

  // Proposed sources render as distinct nodes (dotted ring in the UI).
  for (const p of proposed) {
    nodes.push({
      id: `proposed:${p.id}`,
      title: p.title,
      author: "Proposed by user",
      pillar: PILLARS.includes(p.pillar) ? p.pillar : "marketing",
      tier: "1S",
      license: "pending review",
      licenseBasis: "Proposed source — license not yet vetted. Nothing is ingested until the corpus build runs.",
      chunks: 0,
      status: "pending",
      mode: "synthesis-1s",
      teaches: p.teaches ?? "Awaiting ingest — will teach ShapesOS once vetted and built.",
      synthesizedFrom: [],
      kind: "proposed",
      manifestVersion: null,
      retrievedDate: null,
      evalHits: 0,
      retrievalHits: 0,
    });
  }

  const pillarChunks = {
    marketing: nodes.filter((n) => n.pillar === "marketing").reduce((a, n) => a + n.chunks, 0),
    growth: nodes.filter((n) => n.pillar === "growth").reduce((a, n) => a + n.chunks, 0),
    design: nodes.filter((n) => n.pillar === "design").reduce((a, n) => a + n.chunks, 0),
  };
  const stats = {
    sources: nodes.filter(
      (n) => n.kind === "source" || n.kind === "removal-flagged" || n.kind === "catalog",
    ).length,
    chunks: nodes.reduce((a, n) => a + n.chunks, 0),
    pillars: {
      marketing: nodes.filter((n) => n.pillar === "marketing").length,
      growth: nodes.filter((n) => n.pillar === "growth").length,
      design: nodes.filter((n) => n.pillar === "design").length,
    },
    pillarChunks,
    proposed: proposed.length,
    flagged: removalIds.size,
    /** v8+ catalog-only sources (metadata only, zero chunks) — honest count. */
    cataloged: nodes.filter((n) => n.kind === "catalog").length,
    eval: audit.eval ?? null,
    retrievalHitsTotal: nodes.reduce((a, n) => a + n.retrievalHits, 0),
  };

  return { version: manifest.corpusVersion, updatedAt: manifest.updatedAt, stats, nodes, edges };
}
