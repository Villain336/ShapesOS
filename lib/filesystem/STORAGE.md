# Running on several instances: storage, shared state, streams

Deploy PR, WS=state (2026-10-05). In production ShapesOS runs 2+ web replicas
(the Next standalone `runner` image) and 1+ worker (`worker` image) on Render
now and on ECS later. Nothing is shared between them except Postgres and the
object store: no shared disk (Render disks block several instances; the worker
cannot see a web replica's disk) and no shared memory. This file is the
inventory behind that change: every place that wrote local disk, kept
correctness-relevant state in process memory, or held a long-lived stream, and
what was done about it.

Classes for disk writers:

- **(a)** persistent data another instance, the worker or a later request
  reads → goes through the shared blob layer (or the existing UUID
  WorkspaceFile store).
- **(b)** scratch used and removed within one request or job on the same
  process → stays under `os.tmpdir()`.
- **(c)** dev-only / self-host-only → left as is, refused or labelled on
  `DEPLOYMENT_MODE=hosted`.

## The blob layer (lib/filesystem/storage.ts)

One backend switch, `MARKETR_STORAGE=local|s3`, and one hand-rolled S3 client
(SigV4 tested against the AWS documentation vectors) serve two APIs:

- the **UUID API** (`getStorageAdapter().put/get/delete/exists`) for
  WorkspaceFile bytes, unchanged;
- the **namespaced blob API** (`blobPut/blobGet/blobHead/blobDelete/blobList`,
  `blobDeletePrefix`) with refs `blob:<namespace>/<path>` stored in database
  rows instead of filesystem paths. Paths are validated on every call
  (`[A-Za-z0-9._~-]` segments, no `..`, no leading `/`, at most 1024
  characters; arbitrary names are encoded reversibly with
  `encodeBlobSegment`). Namespaces are a closed list. Workspace data is keyed
  `<workspaceId>/…`.

With `s3` a namespace lives at `blobs/<namespace>/<path>` in the bucket. With
`local` it maps onto the directory (and env override) the feature always used,
so a single-box install keeps every file it has. Rows written before the
deploy PR hold a filesystem path: `readStoredRef()` still serves it while the
file exists on this disk (fail-closed outside the namespace directory) and
logs once. AWS credentials: static `MARKETR_S3_*` keys, else `AWS_*` env keys
or the ECS task role (no IMDS, no SSO profiles).

| Namespace | Local directory (MARKETR_STORAGE=local) | Key |
|---|---|---|
| run-recordings | `.run-artifacts` | `<ws>/<run>/{video.webm,trace.zip,step-*.png}` |
| reports | `REPORT_STORAGE_DIR` / `.data/reports` | `<ws>/<report>.pdf`, `<ws>/intelligence-<id>.pdf` |
| logos | `<reports>/logos` | `<ws>/<kit>.<ext>`, `<ws>/wl-<ws>.<ext>` (legacy rows: flat file name) |
| report-engine | `.data/reports/report-engine` | `<ws>/report-<stamp>.pdf` |
| eddm-briefs, io-briefs, launch-packets, audio-briefs | their `*_STORAGE_DIR` / `.data/<name>` | `<ws>/<id>.pdf` (legacy: `<id>.pdf`) |
| sitemaps | `SITEMAP_STORAGE_DIR` / `.data/sitemaps` | `<project>.xml` |
| sites | `SITE_STORAGE_DIR` / `.data/sites` | `<site>/working/<encoded path>` |
| fix-snapshots | `FIX_SNAPSHOT_DIR` / `.data/fix-snapshots` | `<fixRun>.json` |
| scheduler-runs | `.data/scheduler-runs` | `<ws>/artifacts/runs/<run>/<file>` |
| corpus | `CORPUS_DIR` / `data/corpus` | the corpus layout (manifest last) |
| system | `MARKETR_BLOB_DIR` / `.data/blobs/system` | smoke tests and probes |

## Disk writers

| Writer | Class | What changed |
|---|---|---|
| `lib/agents/runs/recorder.ts`, `lifecycle.ts`, `browser-tools.ts` (screenshots) | (b) → (a) | Playwright writes to a scratch dir under `os.tmpdir()`; on stop `publishRecordingArtifacts()` (artifacts.ts) uploads video, trace and screenshots, stores blob refs on the recording row and removes the scratch dir. A failed upload is noted on the run timeline. |
| `lib/agents/runs/artifacts.ts`, `retention.ts`, `app/api/agent-runs/[runId]/recording/[asset]`, `app/api/agent-runs/storage` | readers | `locateRecording()`: blob refs must be in the namespace AND under the run's workspace prefix; legacy paths must stay in the artifact root. Range reads go to the store; open-ended ranges are answered in 4 MiB chunks; suffix ranges fixed. |
| `lib/pdf/generate.ts` (+ `/api/reports/[id]/download`, `lib/portal/data.ts`) | (a) | `reports` namespace; `Report.pdfPath` is a blob ref. |
| `lib/authority/intelligence/pdf.tsx` (+ its PDF route) | (a) | `reports` namespace; the route streams the bytes it just rendered. |
| `lib/reports/render-service.ts` (+ `report-gate.ts`) | (b) + (a) | WeasyPrint job file and output in a per-render `mkdtemp` dir (removed in `finally`); the PDF goes to `report-engine`. |
| `lib/mail/eddm-brief.tsx`, `lib/media/io-briefs.tsx`, `lib/media/launch-packet.tsx`, `lib/media/audio.tsx` (+ their PDF routes) | (a) | Workspace-scoped keys; readers fall back to the legacy key. The launch-packet list no longer returns a server path. |
| brand-kit / white-label logo routes, `lib/knowledge/contextdev/brandsync.ts`, `lib/brand-logo.ts`, PDF logo embedding | (a) | `storeLogo()` / `loadBrandKitLogoFile()` / `deleteLogo()` in brand-logo.ts; synced logos capped at 5 MB. |
| `lib/seo/programmatic-service.ts` `regenerateSitemap` | (a) | `sitemaps` namespace (the API route renders live anyway). |
| `lib/audit/runner.ts` fix snapshots | (a) | `fix-snapshots`; a revert works on any replica. |
| `lib/scheduler/outputStore.ts` `FallbackOutputStore` | (a) | `scheduler-runs` (only when the filesystem service cannot load). |
| `lib/connectors/local.ts` site working copy (+ `source.ts`, `lib/sites/files.ts`, every IDE / builder / fix-agent / deploy route, `zip.ts`, SEO publishers) | (a) | `WorkingCopyProvider`; `siteWorkingCopy()` returns `LocalDirProvider` on a single box and `BlobDirProvider` with `s3` (parity-tested); site deletion removes only `<site>/working`. |
| `lib/voice/voiceover.ts`, `scripts/seed-phase13d-shots.mts` | (a) | Used `new LocalDiskAdapter()` directly; now `getStorageAdapter()`. |
| `lib/intelligence/corpus/*` | (a) / (c) | Platform asset: an operator publishes the ingested snapshot (`scripts/corpus-publish.mts`, manifest last); every instance refreshes a per-instance read cache (`sync.ts ensureCorpusFresh`, at most once a minute). Proposals, removal flags and the rebuild job (which spawns the ingest script, impossible in the runner image) are refused on shared or hosted installs (class c). Retrieval counters moved to Postgres. |
| `lib/filesystem/service.ts` and its users (images, studio creatives / QR, documents, legal, funding, CAD, social, `/api/files`, project files) | (a) | Already on the UUID store. |
| `app/api/clipper/_pipeline.ts` | (a) + (b) | Outputs on the UUID store; ffmpeg intermediates in `mkdtemp`, removed. |
| `app/api/flywheel/ctv/creative/validate`, `lib/datasetbuilder/build.ts`, `lib/intelligence/corpus/ingest.ts` (PDF → text) | (b) | Temp files, removed in `finally`. |
| `lib/design/render-server.ts` | (b) | Font / fontconfig cache under `os.tmpdir()`, rebuilt per process. |
| `lib/datasetbuilder/activate.ts` BriefNow file drop | (c) | `BRIEFNOW_ADAPTERS_ROOT` ignored on hosted (warned once); the MCP pull is the live path. |
| `lib/sandbox/docker.ts` checkpoints (`SANDBOX_SNAPSHOT_DIR`) | (c) | Docker sandboxes are single-host: refused on hosted (use e2b / daytona). |
| `lib/filesystem/compat.ts` (`.data/attachments`) | legacy read | Read-only path for pre-registry attachments on a single box. |
| `lib/intelligence/difficulty/authority.ts` (CC graph), `gate.ts`, `lib/reports/templates/registry.ts`, `lib/ops/parity.ts`, `lib/observability/health.ts` | read-only | Optional local datasets or files shipped with the code. |

## Per-process state

| Module | State | Decision |
|---|---|---|
| `lib/studio/service.ts` | Porkbun purchase confirmation tokens | **Postgres** `single_use_tokens` (`lib/api/single-use-tokens.ts`): hash only, consumed by one `DELETE … RETURNING` under FORCE RLS — accepted once on any replica. |
| `lib/reviews/rate-limit.ts`, `lib/physical/bundles.ts`, `lib/design/pixabay.ts`, `lib/funding/viewer-verify.ts` | fixed-window limiters / resend throttle | **Postgres** via the Phase 6 counter store (`sharedWindowHit` in `lib/api/rate-limit-store.ts`; fails open to the per-process window). |
| `lib/gdpr/limit.ts` | one export at a time | **Postgres** lease (30 min) on the same store. |
| `lib/substrate/graph/connectors/hmac.ts` | webhook replay nonces | **Postgres** atomic claim (`sharedReplayStore`); the in-process store stays injectable. |
| `app/api/hooks/workflows/[id]` | used the in-memory limiter | now `checkRateLimitAsync` (shared). |
| `lib/agents/runs/watch.ts` | live-watch frame bus | + **Postgres relay** (UNLOGGED `agent_run_watch_frames`, latest frame only, only while watched). |
| `lib/agents/runs/browser-tools.ts` | last page per task | cache in front of the run timeline (`lastBrowserPageForTask`). |
| `lib/intelligence/corpus/activity.ts` | retrieval counters (JSON file) | **Postgres** `corpus_retrieval_usage` (global, atomic upsert). |
| `lib/api/rate-limit.ts`, `lib/auth/rate-limit.ts` | API limiter, login lockout | already shared (Phase 6). |
| `lib/agents/runs/abort.ts` | AbortControllers | kept: a speed-up; Stop is recorded in the DB and seen by the owning process at its next step. |
| `lib/agents/runs/recorder.ts` | recording semaphore | kept: a per-host CPU guard. |
| `lib/sandbox/index.ts` `inflight`, `lib/sandbox/tools.ts` checkpoints | creation dedupe, auto-checkpoint throttle | kept: a run executes in one process at a time (lease). |
| `lib/llm/workspace-keys.ts` (10 s), `lib/connectors/m21/index.ts` (5 min), `lib/connector/intro-paths.ts`, Pixabay response / asset caches, `lib/time/zoned.ts`, `lib/cron/jobs.ts`, `lib/design/fonts.ts`, `lib/env/secrets.ts` | caches, log de-duplication | kept: safe to miss; bounded staleness. |
| `lib/connectors/m21/live/airtable.ts`, `lib/intelligence/providers/linkverify.ts` | per-host request pacing to a third party | kept: politeness only; Airtable 429s are handled. |
| `lib/llm/failover.ts` | last failover per workload | kept: per-instance ops view. |
| `lib/esign/pipeline.ts` | in-process hook registry | kept: no subscribers. |
| `app/api/intelligence/geo/run` | in-flight runs | kept; the run is registered with `after()` and `trackBackgroundWork()` so a deploy waits for it within the grace. |
| `lib/messaging/provider.ts` fake, `lib/connectors/mock-webflow.ts`, outreach `defaultClaims`, the memory stores (`lib/media/store.ts`, `lib/flywheel/*`, …) | fakes, mocks, DB-less fallbacks | kept: production uses the Prisma stores / real providers. |
| `lib/cron/runner.ts`, `lib/agents/queue/worker.ts` | process singletons | kept: cron leadership is an advisory lock; jobs are leased in Postgres. |

## Long-lived streams (lib/http/sse.ts, lib/runtime/shutdown.ts)

Every stream: `retry:`, a `: ping` every 15 s (Cloudflare ~100 s, CloudFront
30 s, ALB 300 s idle), and a drain on SIGTERM. Next's standalone server reads
`KEEP_ALIVE_TIMEOUT` (set to 310000 in the runner image, above the ALB's
300 s).

| Route | Resume | Client |
|---|---|---|
| `GET /api/agent-runs/[runId]/watch` (frames) | snapshot-style: status + newest frame on connect; frames from this process or the Postgres relay | `LiveWatch` via `lib/ui/live-stream.ts` (reconnect, backoff) |
| `GET …/watch?view=delegation` | snapshot-style: the full view on connect | `DelegationPlanLive` via `lib/ui/live-stream.ts` |
| `GET /api/twin/sites/[id]/live` | snapshot-style: a fresh `snapshot` on connect | `useTwinLive` (handles `reconnect`; polling fallback) |
| `POST /api/agents/chat` | `id: <agentRunId>:<seq>`; cooperative drain: an inline turn hands off to the worker at its next step boundary, then `event: reconnect` | `ChatContext` via `streamChatFrames` |
| `GET /api/agents/chat/stream` (new) | resumes from `Last-Event-ID` / `?after=` with the same message ids | same |

Shutdown (one path for web and worker): readiness answers 503 `draining`,
streams reconnect elsewhere, the cron runner stops, worker jobs are handed
back to the queue at once without charging the attempt
(`releaseAgentJob`), inline chat turns hand off, and the process exits within
`SHUTDOWN_GRACE_MS` (default 25 s).

Downloads streamed by other routes (exports, CAD packages) are ordinary HTTP
responses: Next's own SIGTERM handler waits for them to finish while the
server closes, bounded by the same grace period.

## Two-instance smoke (scripts/smoke/multi-instance.mts)

Runs the BUILT app as two replicas (A, B) plus the worker, each with its own
scratch `TMPDIR` / `MARKETR_BLOB_DIR`, against one Postgres and one
S3-compatible bucket (the in-process signature-checking fake,
`lib/filesystem/fake-s3.ts`, unless `SMOKE_REAL_S3=1`). Checks: B accepts A's
session; a file uploaded on A downloads on B byte for byte; a site working copy
written on A is read on B and lives under `blobs/sites/`; a chat stream on A
gets `event: reconnect` on SIGTERM and resumes on B with `Last-Event-ID`, every
delta exactly once; A and the worker exit within `SHUTDOWN_GRACE_MS`.

```
npm run build   # once; the smoke never runs next dev
DATABASE_URL=<schema owner> SMOKE_APP_DATABASE_URL=<app role> \
  npx tsx scripts/smoke/multi-instance.mts      # exit 0 pass, 1 fail, 2 prerequisites
```

Its checks are unit-tested against stub replicas
(`scripts/smoke/__tests__/multi-instance-lib.test.ts`), including the failure
modes they must catch (replay from the start, no `reconnect`, an unshared bucket).
