// Marketr — Dataset Builder slice 4: Activate.
// One-click publish of compiled dataset versions into the tenant's
// BriefNow connector (real business-data adapters) and into the OS
// RAG/Feed layer (grounded answers that always cite sources).
//
// Invariants:
// - Publish requires at least one compiled version (NO_VERSION_TO_PUBLISH).
// - Every published entry carries the full Source → Document → Chunk chain
//   (LINEAGE_BROKEN when any pointer dangles — nothing ships ungrounded).
// - Publishing the same version to the same target twice is idempotent.
// - The grounded ask engine never invents content: when no chunk matches,
//   it says so and cites nothing instead of hallucinating.

import { promises as fs } from "node:fs";
import path from "node:path";

import { DATASET_TYPE_LABELS } from "./classify";
import {
  DatasetBuilderError,
  PUBLISH_TARGETS,
  type BriefNowAdapterEntry,
  type BriefNowAdapterPackage,
  type DatasetBuilderStore,
  type DatasetChunkRecord,
  type DatasetPublishInput,
  type DatasetPublishRecord,
  type DatasetRecord,
  type DatasetType,
  type PublishTarget,
} from "./types";

/** Writes the BriefNow adapter package to the connector's adapters area. */
export interface AdapterWriter {
  write(relativePath: string, pkg: BriefNowAdapterPackage): Promise<string>;
}

/**
 * Filesystem adapter writer (optional file drop). Phase 4b: the live
 * BriefNow path is the MCP pull (`get_dataset_adapter`, built from the DB
 * on every call); a file is also written only when BRIEFNOW_ADAPTERS_ROOT
 * names a directory a co-located connector reads. Tests inject a fake
 * writer — never the filesystem.
 */
export function createFsAdapterWriter(root: string): AdapterWriter {
  const base = root;
  return {
    async write(relativePath: string, pkg: BriefNowAdapterPackage) {
      const target = path.resolve(base, relativePath);
      if (!target.startsWith(path.resolve(base))) {
        throw new DatasetBuilderError(
          "ADAPTER_WRITE_FAILED",
          "adapter path escapes the adapters root",
        );
      }
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, JSON.stringify(pkg, null, 2), "utf8");
      } catch (e) {
        throw new DatasetBuilderError(
          "ADAPTER_WRITE_FAILED",
          `could not write adapter package: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }
      return target;
    },
  };
}

/** Fully-resolved publishable entry: chunk + document + source + model. */
export interface ResolvedPublishEntry {
  chunk: DatasetChunkRecord;
  documentId: string;
  documentName: string;
  sourceId: string;
  sourceName: string;
  engine: string;
  engineVersion: string;
  confidence: number;
  compiledAt: string;
}

/**
 * Resolves every lineage row of a version to live chunk/document/source/
 * classification records. Throws LINEAGE_BROKEN when any pointer dangles —
 * a publish can never carry an entry it cannot trace back to a source.
 */
export async function resolveVersionEntries(
  store: DatasetBuilderStore,
  workspaceId: string,
  versionId: string,
): Promise<ResolvedPublishEntry[]> {
  const rows = await store.listDatasetVersionChunks(versionId);
  const entries: ResolvedPublishEntry[] = [];
  for (const row of rows) {
    if (row.workspaceId !== workspaceId) continue;
    const chunk = await store.getChunkById(row.chunkId);
    const classification = await store.getClassificationById(
      row.classificationId,
    );
    if (!chunk || !classification) {
      throw new DatasetBuilderError(
        "LINEAGE_BROKEN",
        `version chunk "${row.id}" points at a missing chunk or classification — refusing to publish`,
      );
    }
    const document = await store.getDocument(chunk.documentId);
    const source = document
      ? await store.getSource(document.sourceId)
      : null;
    if (!document || !source) {
      throw new DatasetBuilderError(
        "LINEAGE_BROKEN",
        `chunk "${chunk.id}" traces to a missing document or source — refusing to publish`,
      );
    }
    entries.push({
      chunk,
      documentId: document.id,
      documentName: document.name,
      sourceId: source.id,
      sourceName: source.name,
      engine: classification.engine,
      engineVersion: classification.engineVersion,
      confidence: classification.confidence,
      compiledAt: row.compiledAt.toISOString(),
    });
  }
  // Deterministic order: document name, then chunk position.
  entries.sort((a, b) =>
    a.documentName < b.documentName
      ? -1
      : a.documentName > b.documentName
        ? 1
        : a.chunk.position - b.chunk.position,
  );
  return entries;
}

export function buildBriefNowAdapterPackage(
  dataset: DatasetRecord,
  version: number,
  entries: ResolvedPublishEntry[],
  /** Publish time (defaults to now); injectable so the package is deterministic. */
  now: Date = new Date(),
): BriefNowAdapterPackage {
  const adapterEntries: BriefNowAdapterEntry[] = entries.map((e) => ({
    chunkId: e.chunk.id,
    documentId: e.documentId,
    documentName: e.documentName,
    sourceId: e.sourceId,
    sourceName: e.sourceName,
    datasetType: dataset.type,
    datasetVersion: version,
    text: e.chunk.text,
    classification: {
      engine: e.engine,
      engineVersion: e.engineVersion,
      confidence: e.confidence,
    },
    compiledAt: e.compiledAt,
  }));
  return {
    contract: "briefnow-dataset-adapter/v1",
    workspaceId: dataset.workspaceId,
    datasetType: dataset.type,
    datasetVersion: version,
    chunkCount: adapterEntries.length,
    publishedAt: now.toISOString(),
    entries: adapterEntries,
  };
}

/** The live pull reference for a BriefNow publish (ShapesOS MCP tool). */
export function briefNowPullRef(type: DatasetType, version: number): string {
  return `mcp://get_dataset_adapter?type=${type}&version=${version}`;
}

let warnedHostedDrop = false;

/**
 * File-drop root for co-located BriefNow runtimes; null = MCP pull only.
 * Deploy PR (class c — self-host only): the drop writes to THIS server's
 * disk for a connector on the same box. A hosted install (several instances,
 * no shared disk) never writes it — the MCP pull (get_dataset_adapter, built
 * from the database) is the live path everywhere.
 */
export function briefNowAdaptersRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = (env.BRIEFNOW_ADAPTERS_ROOT ?? "").trim();
  if (!root) return null;
  if ((env.DEPLOYMENT_MODE ?? "").trim().toLowerCase() === "hosted") {
    if (!warnedHostedDrop) {
      warnedHostedDrop = true;
      console.warn("[datasetbuilder] BRIEFNOW_ADAPTERS_ROOT is ignored on DEPLOYMENT_MODE=hosted; BriefNow pulls adapters over MCP.");
    }
    return null;
  }
  return path.resolve(root);
}

export function ragSnapshotRef(
  workspaceId: string,
  type: DatasetType,
  version: number,
): string {
  return `rag://${workspaceId}/${type}/v${version}`;
}

export interface PublishOptions {
  workspaceId: string;
  datasetId: string;
  target: PublishTarget;
  /**
   * Compiled version to make live (rollback / roll-forward). Omitted = the
   * latest compiled version.
   */
  version?: number;
  /**
   * BriefNow file drop. Omitted = a filesystem writer when
   * BRIEFNOW_ADAPTERS_ROOT is set, otherwise no file (MCP pull only).
   * null = never write a file.
   */
  adapterWriter?: AdapterWriter | null;
}

export interface PublishResult {
  record: DatasetPublishRecord;
  /** Present for briefnow: the shipped adapter package. */
  adapterPackage?: BriefNowAdapterPackage;
  /** True when this version was already the live one (nothing changed). */
  alreadyLive: boolean;
  /** True when the published version is older than the latest compile. */
  rollback: boolean;
  latestVersion: number;
}

/**
 * Publishes the latest compiled version of a dataset to one target.
 * Requires editor intent from the API layer; this function is the pure
 * publish mechanics + invariants.
 */
export async function publishDataset(
  store: DatasetBuilderStore,
  options: PublishOptions,
): Promise<PublishResult> {
  const { workspaceId, datasetId, target } = options;
  if (!PUBLISH_TARGETS.includes(target)) {
    throw new DatasetBuilderError(
      "INVALID_PUBLISH_TARGET",
      `publish target must be one of ${PUBLISH_TARGETS.join(", ")}`,
    );
  }
  const dataset = await store.getDataset(datasetId);
  if (!dataset || dataset.workspaceId !== workspaceId) {
    throw new DatasetBuilderError(
      "UNKNOWN_DATASET",
      `cannot publish: dataset "${datasetId}" does not exist`,
    );
  }
  const latest = await store.getLatestDatasetVersion(datasetId);
  if (!latest) {
    throw new DatasetBuilderError(
      "NO_VERSION_TO_PUBLISH",
      `compile the "${DATASET_TYPE_LABELS[dataset.type]}" dataset before publishing`,
    );
  }
  let chosen = latest;
  if (options.version !== undefined && options.version !== latest.version) {
    const found = (await store.listDatasetVersions(datasetId)).find(
      (v) => v.version === options.version,
    );
    if (!found || found.workspaceId !== workspaceId) {
      throw new DatasetBuilderError(
        "UNKNOWN_DATASET_VERSION",
        `the ${DATASET_TYPE_LABELS[dataset.type]} dataset has no compiled version ${options.version}`,
      );
    }
    chosen = found;
  }
  const rollback = chosen.version < latest.version;

  // Idempotent: publishing the version that is already live changes nothing.
  const live = await store.getLatestPublishRecord(datasetId, target);
  if (live && live.version === chosen.version) {
    return { record: live, alreadyLive: true, rollback, latestVersion: latest.version };
  }

  const entries = await resolveVersionEntries(store, workspaceId, chosen.id);

  const input: DatasetPublishInput = {
    workspaceId,
    datasetId,
    target,
    version: chosen.version,
    versionId: chosen.id,
    chunkCount: entries.length,
    artifactRef: "",
    makeLive: true,
  };

  let adapterPackage: BriefNowAdapterPackage | undefined;
  if (target === "briefnow") {
    adapterPackage = buildBriefNowAdapterPackage(dataset, chosen.version, entries);
    const root = briefNowAdaptersRoot();
    const writer =
      options.adapterWriter === undefined
        ? root
          ? createFsAdapterWriter(root)
          : null
        : options.adapterWriter;
    input.artifactRef = writer
      ? await writer.write(path.join(workspaceId, `${dataset.type}.v${chosen.version}.json`), adapterPackage)
      : briefNowPullRef(dataset.type, chosen.version);
  } else {
    input.artifactRef = ragSnapshotRef(workspaceId, dataset.type, chosen.version);
  }

  const record = await store.createPublishRecord(input);
  return { record, adapterPackage, alreadyLive: false, rollback, latestVersion: latest.version };
}

/**
 * The live BriefNow adapter package for one dataset type, rebuilt from the
 * database on every call (the MCP `get_dataset_adapter` pull). Entries are
 * paged so a large dataset never becomes one giant response. Null when the
 * type was never published to BriefNow.
 */
export async function getLiveBriefNowPackage(
  store: DatasetBuilderStore,
  workspaceId: string,
  type: DatasetType,
  page: { offset?: number; limit?: number } = {},
): Promise<{
  package: BriefNowAdapterPackage;
  page: { offset: number; limit: number; total: number; nextOffset: number | null };
} | null> {
  const dataset = await store.getDatasetByType(workspaceId, type);
  if (!dataset || dataset.workspaceId !== workspaceId) return null;
  const live = await store.getLatestPublishRecord(dataset.id, "briefnow");
  if (!live) return null;
  const entries = await resolveVersionEntries(store, workspaceId, live.versionId);
  const full = buildBriefNowAdapterPackage(dataset, live.version, entries);
  const offset = Math.max(0, Math.floor(page.offset ?? 0));
  const limit = Math.min(Math.max(Math.floor(page.limit ?? 100), 1), 200);
  const slice = full.entries.slice(offset, offset + limit);
  return {
    package: { ...full, publishedAt: live.publishedAt.toISOString(), entries: slice },
    page: {
      offset,
      limit,
      total: full.entries.length,
      nextOffset: offset + limit < full.entries.length ? offset + limit : null,
    },
  };
}

export interface PublishTargetStatus {
  target: PublishTarget;
  label: string;
  published: boolean;
  version: number | null;
  publishedAt: string | null;
  chunkCount: number | null;
  artifactRef: string | null;
  /** True when a newer compiled version exists than what is live. */
  stale: boolean;
  latestVersion: number | null;
}

export const PUBLISH_TARGET_LABELS: Record<PublishTarget, string> = {
  briefnow: "BriefNow connector",
  rag: "RAG + Feed",
};

export async function getPublishStatus(
  store: DatasetBuilderStore,
  workspaceId: string,
  datasetId: string,
): Promise<{ dataset: DatasetRecord; targets: PublishTargetStatus[] }> {
  const dataset = await store.getDataset(datasetId);
  if (!dataset || dataset.workspaceId !== workspaceId) {
    throw new DatasetBuilderError(
      "UNKNOWN_DATASET",
      `dataset "${datasetId}" does not exist`,
    );
  }
  const latest = await store.getLatestDatasetVersion(datasetId);
  const targets: PublishTargetStatus[] = [];
  for (const target of PUBLISH_TARGETS) {
    const record = await store.getLatestPublishRecord(datasetId, target);
    targets.push({
      target,
      label: PUBLISH_TARGET_LABELS[target],
      published: record !== null,
      version: record?.version ?? null,
      publishedAt: record?.publishedAt.toISOString() ?? null,
      chunkCount: record?.chunkCount ?? null,
      artifactRef: record?.artifactRef ?? null,
      stale:
        record !== null &&
        latest !== null &&
        latest.version > record.version,
      latestVersion: latest?.version ?? null,
    });
  }
  return { dataset, targets };
}

// ---- Grounded ask -----------------------------------------------------------

/** Tokenizer mirrors the BriefNow connector's scoring: deterministic, no deps. */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "with", "from", "that",
  "this", "these", "those", "you", "your", "our", "their", "his", "her",
  "its", "what", "when", "where", "which", "who", "why", "how", "does",
  "did", "can", "could", "would", "should", "has", "have", "had", "not",
  "but", "about", "into", "over", "under", "than", "then", "there",
  "here", "all", "any", "each", "few", "more", "most", "other", "some",
  "such", "only", "own", "same", "too", "very",
]);

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length > 2 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

export interface GroundedCitation {
  chunkId: string;
  documentId: string;
  documentName: string;
  sourceId: string;
  sourceName: string;
  excerpt: string;
  engine: string;
  engineVersion: string;
  datasetVersion: number;
}

export interface GroundedAnswer {
  /** False when nothing matched — the answer says so instead of inventing. */
  grounded: boolean;
  answer: string;
  citations: GroundedCitation[];
  confidence: "high" | "medium" | "low";
  datasetType: DatasetType;
  datasetLabel: string;
  datasetVersion: number;
}

const MAX_QUESTION_LENGTH = 2000;

/** Deterministic token-overlap scoring (price-intent boost on pricing). */
function scoreEntries(
  entries: ResolvedPublishEntry[],
  question: string,
  type: DatasetType,
): { entry: ResolvedPublishEntry; score: number }[] {
  const qTokens = tokens(question);
  const priceIntent = [...qTokens].some((t) =>
    ["much", "cost", "price", "pricing", "charge", "expensive", "cheap"].includes(t),
  );
  const scored = entries.map((e) => {
    const cTokens = tokens(e.chunk.text);
    let score = 0;
    for (const t of qTokens) {
      if (cTokens.has(t)) score += 1;
    }
    if (priceIntent && type === "pricing") score += 3;
    return { entry: e, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0);
}

export function excerpt(text: string, maxLength = 220): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > maxLength
    ? `${clean.slice(0, maxLength).trimEnd()}…`
    : clean;
}

/**
 * Answers a question strictly from the dataset's live RAG snapshot:
 * the latest version published to "rag", falling back to the latest
 * compiled version when nothing was published yet. Every citation traces
 * to Source → Document → Chunk; when nothing scores above zero the answer
 * refuses to guess (grounded: false, zero citations).
 */
export async function askDataset(
  store: DatasetBuilderStore,
  workspaceId: string,
  datasetId: string,
  question: string,
  maxCitations = 3,
): Promise<GroundedAnswer> {
  const trimmed = question.trim();
  if (!trimmed || trimmed.length > MAX_QUESTION_LENGTH) {
    throw new DatasetBuilderError(
      "VALIDATION_FAILED",
      "question must be non-empty and under 2000 characters",
    );
  }
  const dataset = await store.getDataset(datasetId);
  if (!dataset || dataset.workspaceId !== workspaceId) {
    throw new DatasetBuilderError(
      "UNKNOWN_DATASET",
      `dataset "${datasetId}" does not exist`,
    );
  }
  const published = await store.getLatestPublishRecord(datasetId, "rag");
  const versionId = published?.versionId
    ?? (await store.getLatestDatasetVersion(datasetId))?.id;
  if (!versionId) {
    throw new DatasetBuilderError(
      "NO_VERSION_TO_PUBLISH",
      `compile the "${DATASET_TYPE_LABELS[dataset.type]}" dataset before asking it questions`,
    );
  }
  const entries = await resolveVersionEntries(store, workspaceId, versionId);
  const datasetVersion =
    published?.version ?? (await store.getLatestDatasetVersion(datasetId))?.version ?? 0;
  const label = DATASET_TYPE_LABELS[dataset.type];

  const hits = scoreEntries(entries, trimmed, dataset.type);

  if (hits.length === 0) {
    return {
      grounded: false,
      answer: `I couldn't find an answer in your ${label} dataset (v${datasetVersion}). Try rephrasing, or add documents covering this topic.`,
      citations: [],
      confidence: "low",
      datasetType: dataset.type,
      datasetLabel: label,
      datasetVersion,
    };
  }

  const top = hits.slice(0, Math.max(1, maxCitations));
  return {
    grounded: true,
    answer: top[0].entry.chunk.text.trim(),
    citations: top.map(({ entry }) => ({
      chunkId: entry.chunk.id,
      documentId: entry.documentId,
      documentName: entry.documentName,
      sourceId: entry.sourceId,
      sourceName: entry.sourceName,
      excerpt: excerpt(entry.chunk.text),
      engine: entry.engine,
      engineVersion: entry.engineVersion,
      datasetVersion,
    })),
    confidence: hits[0].score >= 3 ? "high" : "medium",
    datasetType: dataset.type,
    datasetLabel: label,
    datasetVersion,
  };
}

// ---- OS grounding (Phase 4b) -------------------------------------------------

export interface BusinessDataCitation extends GroundedCitation {
  datasetType: DatasetType;
  datasetLabel: string;
}

export interface BusinessDataAnswer {
  grounded: boolean;
  answer: string;
  citations: BusinessDataCitation[];
  confidence: "high" | "medium" | "low";
  /** Datasets that are live on the RAG target (what was searched). */
  searched: { type: DatasetType; label: string; version: number }[];
}

/**
 * Answers from every dataset the workspace has ACTIVATED into the OS layer
 * (published to "rag") — the grounding the chat agent and the MCP
 * `ask_business_data` tool use. Compiled-but-unpublished datasets are not
 * searched: activation is the tenant's explicit choice. Refuses to guess
 * when nothing matches (grounded: false, zero citations).
 */
export async function askPublishedDatasets(
  store: DatasetBuilderStore,
  workspaceId: string,
  question: string,
  maxCitations = 3,
): Promise<BusinessDataAnswer> {
  const trimmed = question.trim();
  if (!trimmed || trimmed.length > MAX_QUESTION_LENGTH) {
    throw new DatasetBuilderError(
      "VALIDATION_FAILED",
      "question must be non-empty and under 2000 characters",
    );
  }
  const searched: BusinessDataAnswer["searched"] = [];
  const hits: { entry: ResolvedPublishEntry; score: number; type: DatasetType; version: number }[] = [];
  for (const dataset of await store.listDatasets(workspaceId)) {
    if (dataset.workspaceId !== workspaceId) continue;
    const live = await store.getLatestPublishRecord(dataset.id, "rag");
    if (!live) continue;
    searched.push({ type: dataset.type, label: DATASET_TYPE_LABELS[dataset.type], version: live.version });
    const entries = await resolveVersionEntries(store, workspaceId, live.versionId);
    for (const h of scoreEntries(entries, trimmed, dataset.type)) {
      hits.push({ ...h, type: dataset.type, version: live.version });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  if (hits.length === 0) {
    return {
      grounded: false,
      answer:
        searched.length === 0
          ? "No datasets are live in the OS yet. Publish a dataset to RAG + Feed in Datasets → Activate first."
          : "I couldn't find an answer in your published datasets. Try rephrasing, or add documents covering this topic.",
      citations: [],
      confidence: "low",
      searched,
    };
  }
  const top = hits.slice(0, Math.max(1, Math.min(maxCitations, 10)));
  return {
    grounded: true,
    answer: top[0]!.entry.chunk.text.trim(),
    citations: top.map(({ entry, type, version }) => ({
      chunkId: entry.chunk.id,
      documentId: entry.documentId,
      documentName: entry.documentName,
      sourceId: entry.sourceId,
      sourceName: entry.sourceName,
      excerpt: excerpt(entry.chunk.text),
      engine: entry.engine,
      engineVersion: entry.engineVersion,
      datasetVersion: version,
      datasetType: type,
      datasetLabel: DATASET_TYPE_LABELS[type],
    })),
    confidence: hits[0]!.score >= 3 ? "high" : "medium",
    searched,
  };
}
