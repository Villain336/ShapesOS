# Dataset Builder — Slice 1: Ingest

Launch-pillar on-ramp: "transfer your business into the AI world."
Spec: `docs/BUSINESS-OS-FEATURE-SPECS.md` §1 (shared decisions in §0).

## What slice 1 does

Connects four source kinds and turns each into **chunked, source-pointed
text**: file upload (PDF / DOCX / CSV / MD), Google Drive (via the Nango
Cloud adapter), website crawl, and copy-paste with an explicit user label.

## The invariant

**Zero orphaned chunks.** Every `Chunk` carries a non-nullable pointer to
its `Document`, and every `Document` to its `Source`. Enforced three ways:

1. **Database** — `prisma/migrations/20261001150000_dataset_builder_slice1/`:
   `dataset_chunks.document_id NOT NULL` → `dataset_documents` FK
   `ON DELETE CASCADE`; `dataset_documents.source_id NOT NULL` →
   `dataset_sources` FK `ON DELETE CASCADE`.
2. **Store** — `createChunk` throws `ORPHAN_CHUNK_REJECTED` when the
   document id is missing or unknown; `createDocument` throws
   `UNKNOWN_SOURCE` for unknown sources. The in-memory store used by
   tests mirrors the production FK semantics exactly.
3. **Pipeline** — chunk inputs are built only from a live document id
   (`chunkInputsForDocument` refuses an empty pointer), and a document
   flips to `ready` only after all its chunks are written.

`verifyNoOrphanedChunks()` (register.ts) is the runtime audit: it must
always return `[]`. Anything else is a data-integrity incident.

## Layout

| File | Contents |
|---|---|
| `types.ts` | Domain types, `DatasetBuilderStore` contract, `DatasetBuilderError` codes |
| `chunking.ts` | Overlapping character chunker + document-pointer stamping |
| `extract.ts` | PDF / DOCX / CSV / MD text extraction (no new deps; DOCX via adm-zip) |
| `nango.ts` | Nango Cloud Drive adapter interface + fail-closed live adapter + mock |
| `engines.ts` | Extraction-engine interface: NeMo Data Designer stub, frontier stub, mock |
| `ingest.ts` | The four pipelines: `ingestUpload`, `ingestDriveFile`, `ingestWeb`, `ingestPaste` |
| `register.ts` | `getSourceRegister` (source → documents → chunk counts), `verifyNoOrphanedChunks` |
| `classify.ts` | Dataset types, `ClassificationEngine` interface, `RulesClassificationEngine` (deterministic default), `FrontierClassificationEngine` stub (fail-closed) |
| `structure.ts` | `structureChunk` / `structureDocument` / `structureWorkspace`, `decideReview`, `getTypeBreakdown`, `listReviewQueue` |
| `build.ts` | Versioned compiler (`compileDataset` / `compileDatasets`), `getVersionLineage`, JSONL + Parquet exporters, `verifyNoOrphanedVersionChunks` |
| `health.ts` | `getDatasetHealth`: coverage, freshness, staleness/drift/uncompiled alerts |
| `store.ts` | In-memory store (tests, tooling) |
| `__tests__/` | `npx tsx --test` per file — no DB, no network, no credentials |

## Slice 2: Structure (built)

Auto-classify chunks into the six dataset types (`faq`, `product_catalog`,
`policy`, `process_sop`, `company_fact`, `pricing`). Every classification
carries a confidence score + engine lineage (`engine`, `engineVersion`).

The trust-ladder rule: confidence ≥ 0.6 auto-applies; below it the chunk is
**never force-fit** — it gets `pending_review` status plus exactly one
`ReviewItem`. A human then approves (suggested type applies), reassigns (the
human's type applies), or rejects (the chunk stays unclassified — never
mislabeled). Decisions are final (`REVIEW_ALREADY_DECIDED` on re-decide).

- Upsert is per `(chunkId, engine)`: re-running an engine replaces its own
  classification, never duplicates it.
- `classificationId` is unique on review items: the queue can never lose or
  double-count a pending decision.
- The zero-orphaned-chunks invariant extends down: `chunk_id` is NOT NULL
  with `ON DELETE CASCADE`, so classifying a missing chunk throws
  `UNKNOWN_CHUNK`.
- API: `POST /api/datasets/classify` (run), `GET /api/datasets/by-type`
  (breakdown incl. the unclassified bucket), `GET /api/datasets/reviews`
  (pending queue with chunk text + names), `POST /api/datasets/reviews/[id]`
  (decide).
- UI: `/dashboard/datasets` gains **By type** and **Review queue** tabs
  (queue badge counts pending items).

## Extraction limits (documented, v1)

- PDF: unencrypted, FlateDecode content streams, literal `Tj`/`TJ` strings.
  Scanned-image and exotic-encoding PDFs raise `EXTRACTION_FAILED`.
- DOCX: `word/document.xml` paragraph text via `<w:t>` runs.
- CSV: RFC-4180-ish; rows become `col: value | col: value` lines.
- Crawl: HTML main-content heuristic, 2 MB cap, http(s) only.

## Tests

```bash
npx tsx --test lib/datasetbuilder/__tests__/chunking.test.ts
npx tsx --test lib/datasetbuilder/__tests__/extract.test.ts
npx tsx --test lib/datasetbuilder/__tests__/ingest.test.ts
npx tsx --test lib/datasetbuilder/__tests__/integrity.test.ts
npx tsx --test lib/datasetbuilder/__tests__/adapters.test.ts
npx tsx --test lib/datasetbuilder/__tests__/classify.test.ts
npx tsx --test lib/datasetbuilder/__tests__/structure.test.ts
```

(Directory args fail on this repo's tsx version — pass explicit file paths.)

Also:
```bash
npx tsx --test lib/datasetbuilder/__tests__/build.test.ts
npx tsx --test lib/datasetbuilder/__tests__/health.test.ts
```

## Slice 3: Build (built)

Compiles applied classifications into **immutable versioned datasets**,
exportable as JSONL and Parquet, with per-chunk lineage and a dataset
health panel.

- **Compiler** (`build.ts`): `compileDataset(store, workspaceId, type)`
  snapshots every chunk with an `applied` classification of that type into
  a new `DatasetVersion` (monotonic v1, v2, …; `COMPILE_EMPTY` when nothing
  is classified — compiling an empty dataset fails loudly). One chunk
  appears at most once per version even when several engines classified it
  (highest confidence wins). `compileDatasets` compiles every populated
  type, skipping empty ones.
- **Lineage**: every version records which source → which document → which
  chunk (through the slice-1/2 FK chain), which model classified it
  (`engine`/`engineVersion` copied at compile time), which transform
  compiled it (`settings`: compiler name + version), and when
  (`compiledAt`). `getVersionLineage` resolves it all; the zero-orphaned
  data invariant extends down: version-chunk FKs are NOT NULL +
  `ON DELETE CASCADE`, and `verifyNoOrphanedVersionChunks()` audits it.
- **Exports**: `exportDatasetJsonl` (one JSON object per line) and
  `exportDatasetParquet` (real Parquet via `@dsnp/parquetjs` 1.8.9 pinned —
  the 1.9.3 publish ships without `dist/`). Both carry the lineage flat
  (chunk, document, source, engine, compiled version).
- **Health** (`health.ts`): `getDatasetHealth` returns coverage (% of
  chunks classified into datasets), freshness (age of newest data per
  dataset), and alerts: stale ("Your pricing dataset is 120 days old",
  default threshold 90 days), drift ("1 new pricing chunk since v1 —
  recompile to refresh"), and uncompiled ("Compile your first pricing
  dataset from 2 classified chunks").
- API: `POST /api/datasets/compile` (one type or all), `GET /api/datasets`
  (types + latest versions), `GET /api/datasets/[id]/versions` (history +
  lineage summaries), `GET /api/datasets/[id]/export?format=jsonl|parquet`,
  `GET /api/datasets/health`.
- UI: `/dashboard/datasets` gains a **Build** tab — health panel
  (coverage, freshness, staleness alerts), per-type dataset cards with
  Compile / JSONL / Parquet actions, and expandable version history with
  lineage (sources + models).
