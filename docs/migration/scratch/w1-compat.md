# Workers-Compatibility Audit (Worker 1) — IN PROGRESS
Date: 2026-09-27. Read-only scan of ~/workspace/marketr. All findings verified by direct grep/read of the tree.
Severity: BLOCKER = cannot run on Workers even with nodejs_compat; WORKAROUND = fixable via code change/config;
FINE = works as-is or via nodejs_compat flag. UNVERIFIED = could not verify.

## A. Native modules (.node binaries)

| File | Line | Import | Severity | Remediation |
|---|---|---|---|---|
| lib/design/render-server.ts | 32 | `import sharp from "sharp"` | BLOCKER | Replace with WASM/Workers image pipeline (e.g. Cloudflare Image Resizing, images binding, or @cf-wasm/sharp-like WASM build). Verified native: node_modules/@img/sharp-linux-x64 + sharp-libvips-linux-x64 present; .so/.node bundled. Used for server JSON→PNG render API. |
| lib/media/qr.ts | 19 | `import sharp from "sharp"` | BLOCKER | Same as above — QR composition/resize path. Swap to pure-JS/WASM PNG encode. |
| lib/pdf/renderer.ts | 13 | `import { render } from "takumi-pdf"` | WORKAROUND | takumi-pdf ships a dedicated `workerd` export condition (node_modules/takumi-pdf/bundlers/workerd.mjs imports `../pkg/takumi_pdf_wasm_bg.wasm` + `initSync`). OpenNext adapter must resolve the `workerd` condition and register the .wasm module. Current `serverExternalPackages: ["takumi-pdf"]` in next.config.ts is Node-standalone-only. Also note callers in app/api/*/[…]/pdf routes (8 pdf routes: authority intelligence reports, eddm brief-pdf, audio briefs, dooh launch-packet, io-briefs, reports download, media/pdf routes). |
| lib/substrate/memory/embed.ts | 9 | `import { env, pipeline } from "@xenova/transformers"` | BLOCKER | Server-side @xenova/transformers loads onnxruntime-node: verified native .node at node_modules/onnxruntime-node/bin/napi-v3/linux/x64/onnxruntime_binding.node + companion libonnxruntime.so (next.config.ts outputFileTracingIncludes force-includes it — proof the build knows it's native). Plus fs WRITES: model cache at MEMORY_MODEL_CACHE ?? $HOME/.cache/hf-models (line 11). Also loads 2 models at runtime (Xenova/all-MiniLM-L6-v2 + Xenova/ms-marco-MiniLM-L-6-v2). Remediation: move embeddings to Workers AI (models available), a queue-consumer container, or external embedding API; reranker same. Used by Growth Memory recall AND the corpus ingest chain (lib/intelligence/corpus/ingest.ts:13 → corpus/embed.ts:19 → this file), so the corpus rebuild job also loads the native binding. |
| (whole tree) | — | `@prisma/client` (~150 files; lib/prisma.ts:4 `new PrismaClient()`) | BLOCKER | Verified native engine: node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node. PrismaClient cannot run on Workers. Remediation: switch to Prisma driver adapter (@prisma/adapter-pg + pg over nodejs_compat) or Prisma Accelerate; Payload CMS uses its own @payloadcms/db-postgres (drizzle/pg, no native) so the two DB paths can be unified on pg. |
| lib/sitefiles/sftp.ts | 10 | `import { Client } from "ssh2"` | WORKAROUND | ssh2 is pure JS (no .node), but needs raw TCP + crypto. Workers supports `node:net` sockets via nodejs_compat — SFTP over it is possible but heavy/CPU-bound; better: move SFTP sync/deploy to a container or queue consumer, or keep feature VM-only. Used by websites deploy/sync routes. |

Not present (verified absent): bcrypt, puppeteer, canvas — no imports anywhere. onnxruntime-web is in package.json but only @imgly/background-removal uses it, and that is client-side only (lib/design/background-removal.ts:3 "runs 100% in the browser").

## B. child_process / exec / external binaries

| File | Line | Usage | Severity | Remediation |
|---|---|---|---|---|
| app/api/corpus/rebuild/route.ts | 7,53 | `import { spawn } from "node:child_process"`; `spawn("npx", ["tsx", "scripts/ingest-corpus.mts"], {detached:true})` + fs.writeFileSync log + `process.kill(pid,0)` reaper | BLOCKER | No process model on Workers. Move to Cloudflare Queue consumer or Workflows; status/log must live in KV/D1/R2, not files. |
| lib/intelligence/corpus/ingest.ts | 14,106 | `execFileSync("pdftotext", ["-layout", pdfPath, txtPath], {timeout:120000})` — external poppler binary, sync exec, 120s timeout, temp files in os.tmpdir() | BLOCKER | Replace with WASM PDF text extraction or a container/queue consumer. Graceful-degrades today ("VM without poppler → throws → PENDING") so it's safe to stub. |
| lib/flywheel/ctv/validator.ts | 12-15,69,82,115,166 | `execFile("ffprobe", …)` / `execFile("ffmpeg", …)` for stream probing, EBU R128 loudness, black-bar frame sampling | BLOCKER | ffmpeg/ffprobe binaries don't exist on Workers. Remediation: drop feature to container/VM lane, or ffmpeg.wasm (large, CPU-heavy — Workers limits hostile). Called by app/api/flywheel/ctv/creative/validate/route.ts which also does node:fs/promises writeFile+unlink of the upload to a tmp path. |

## C. fs reads AND writes (writes are the killer)

Disk-write roots found: `process.cwd()/.data/<…>` everywhere; `os.tmpdir()` scratch; `$HOME/.cache` model cache.

| File | Lines | R/W | Severity | Remediation |
|---|---|---|---|---|
| lib/filesystem/storage.ts:37-88 | LocalDiskAdapter | W | BLOCKER (unless S3) | S3CompatibleAdapter already exists (MARKETR_S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY → R2 is S3-compatible: use R2 on Workers). Local adapter must be disabled at the edge. |
| lib/scheduler/outputStore.ts | 98-112 | W | BLOCKER | Base dir `.data/scheduler-runs`; mkdir+writeFile per artifact. Move to R2/D1. |
| lib/audit/runner.ts | 26,55,61,67 | W+R | BLOCKER | FIX_SNAPSHOT_DIR ?? `.data/fix-snapshots`; mkdir + writeFile(JSON) + readFile. Move to R2/KV. Note: provider.readFile/writeFile at 138,163,168,275 go through SiteFileProvider (local or remote) — local provider = fs too. |
| app/api/websites/[id]/route.ts | 43 | W | BLOCKER | `fs.rm(siteWorkingDir(site.id), {recursive:true})` — working copies live at SITE_STORAGE_DIR ?? `.data/sites/<id>/working`. Move working copies to R2. |
| app/api/brand-kits/[id]/logo/route.ts | 59,63 | W | BLOCKER | mkdir + writeFile logo to local dir. Move to R2; serve via Worker asset route. |
| app/api/workspaces/white-label/logo/route.ts | 65,69 | W | BLOCKER | Same as brand-kit logo. |
| app/api/corpus/rebuild/route.ts | 47 | W | BLOCKER | writeFileSync rebuild log; covered by §B (whole flow moves off Workers). |
| app/api/flywheel/ctv/creative/validate/route.ts | 71 | W | BLOCKER | writeFile tmp upload → ffmpeg; covered by §B. |
| lib/intelligence/difficulty/authority.ts | 265,329 | W+R | BLOCKER | `new DatabaseSync(dest)` WRITE path builds a local SQLite index from a ~16GB Common Crawl ranks file (streams gunzip via node:zlib/readline) — build-time only (no runtime callers of buildCcIndex; only scripts/cc-graph-download.sh references it). RUNTIME path `lookupCcDomains` (line 317) opens `new DatabaseSync(indexFile,{readOnly:true})` — read-only sqlite still impossible on Workers (no node:sqlite, no fs). Called from lib/intelligence/difficulty/service.ts:114,120. Remediation: precompute → D1/KV lookup, or drop CC-graph adapter (it's graceful: returns {available:false}). |
| lib/connectors/local.ts:17-… | R+W | LocalDirProvider | BLOCKER | Entire provider is a server-filesystem abstraction (fs.promises, mkdir, readdir, readFile, writeFile, rm). Working copies for github/sftp sites. Cannot run on Workers; replace with R2-backed provider or keep feature VM-only. |
| lib/sitefiles/* (sftp.ts, paths.ts, assist.ts…) | — | via providers | WORKAROUND | Abstraction already exists (SiteFileProvider); add R2 provider, disable local provider at edge. ssh2 SFTP (§A) also needs a home. |
| lib/intelligence/corpus/ingest.ts | 13-17 | R | WORKAROUND | fs/path/url/os imports — node:fs readFileSync(txtPath) of its own temp file (tied to §B pdftotext). scripts/ingest-corpus.mts also reads `data/corpus/*` + writes manifest. All corpus file ops move to R2 with the rebuild job. |
| lib/intelligence/corpus/store.ts, activity.ts, proposals.ts | 19,13,10 | R(+W?) | WORKAROUND | fs+path reads of corpus JSON/manifest. Corpus status/log files (proposals.ts: rebuildLogPath) move to KV/D1. Verify each write site during migration. |
| lib/intelligence/difficulty/gate.ts, authority.ts | 28,23 | R | FINE-ish | node:fs/os/path/readline/zlib/sqlite — the CC-graph BUILD path is offline; keep it a VM/script concern, never bundled into the Worker. |
| lib/pdf/generate.ts | 25,73-74,156-163 | W+R | BLOCKER | Reads logo bytes from disk at request time (line 73-74), mkdir+writeFile the finished PDF to `.data/reports` (156-158), stores relative path in DB. All PDF bytes must go to R2; logos become bundled assets or R2 fetches. |
| lib/brand-logo.ts:9-10, lib/authority/intelligence/pdf.tsx:8-9, lib/media/{audio,io-briefs,launch-packet}.tsx, lib/mail/eddm-brief.tsx | — | R | WORKAROUND | fs+path for logo/font asset reads at PDF render time — must become bundled assets or R2 fetches. |
| lib/design/render-server.ts:29 | R+W | BLOCKER | BLOCKER | existsSync/mkdirSync/writeFileSync to os.tmpdir() for fonts (line 83 comment: "Writes to os.tmpdir() once per…") + sharp + dns.lookup — whole server render pipeline (§A) is non-portable. |
| lib/security/upload-safety.ts:14, lib/seo/programmatic-service.ts:8 | — | R | FINE/WORKAROUND | node:path only (no fs writes seen) — path is in nodejs_compat, fine. |
| payload.config.ts:1, payload/collections/Media.ts:1 | — | R | FINE | node:path import only. |
| lib/filesystem/compat.ts | 17-18 | R | WORKAROUND | node:fs/promises readFile+unlink for legacy `.data/attachments/<project>/<uuid>` rows; new rows go through the storage-adapter registry. Legacy reads must be migrated to R2 or dropped. |
| app/dashboard/intelligence/corpus/page.tsx:8-9 | — | R | WORKAROUND | Server component importing node:fs/path — corpus dashboard reads local corpus files; must read from R2/D1 instead. |
| tests/, scripts/capture-*.mjs, scripts/generate-template-pack.ts | — | R/W | FINE | Test/build scripts never run on Workers; exclude from Worker bundle (generate-template-pack.ts runs at build time to emit pack.json — keep it build-time). |

Node builtin safety notes: node:crypto (65 files), node:path (40), node:url (4), node:os (9), node:util, node:zlib, node:readline are all in the Workers nodejs_compat allowlist — WORKAROUND at most (audit actual API usage; e.g. node:os.tmpdir() returns "/" on Workers but writes fail). node:net (lib/safe-url.ts:24, lib/security/malware-scan.ts:15) — Workers supports net.Socket via nodejs_compat but raw TCP to arbitrary hosts needs care (SSRF guard present in safe-url). node:dns (render-server only) is NOT in the compat surface the way used here — moot, whole file is BLOCKER via sharp. node:sqlite (authority.ts) — NOT available on Workers; use D1.

## D. WebSocket servers vs clients

Definitive: **zero WebSocket usage in the codebase** (case-insensitive word search for websocket/websockets across app/, lib/, components/, auth.ts, proxy.ts, payload.config.ts, payload/ — only hit is a comment in lib/design/penpot.ts:19 noting a Penpot RPC path "cannot be called from a server route"). No `ws` package imports, no `new WebSocket(`, no upgrade handlers. Collaboration (yjs/y-protocols, @tiptap/extension-collaboration) is client-side only. → FINE, nothing to migrate.

## E. Long-running / CPU-heavy request handlers (Workers CPU/wall-clock limits)

Standard Workers: 30s wall clock (paid) / 10ms–30s CPU tiers; maxDuration exports are a Vercel/Node concept OpenNext maps partially. Handlers at risk:

| File | Issue | Severity | Remediation |
|---|---|---|---|
| app/api/flywheel/ctv/creative/validate/route.ts | `maxDuration = 300` + ffmpeg/ffprobe exec (§B) | BLOCKER | Move to container/queue consumer (covered §B). |
| app/api/corpus/rebuild/route.ts | Detached spawn + setInterval reaper + file log (§B) | BLOCKER | Queue consumer / Workflows; status in KV/D1. |
| app/api/substrate/graph/connectors/[id]/sync/route.ts | `maxDuration = 120`; runs Tier-S platform pulls inline (lib/substrate/graph/connectors/tiers.ts, tierm.ts WooCommerce poller, tierw.ts) | WORKAROUND | Split into queue-consumer sync jobs; keep route as enqueue + status poll. WooCommerce "gentle poller" delays are wall-clock hostile. |
| app/api/cron/fleet/route.ts → lib/intelligence/fleet/run.ts | runFleetForWorkspace loops all competitor watches: per watch = sitemap discovery + change detection + snapshots, each many polite fetches (PoliteFetcher, robots cache). Unbounded wall clock as watch count grows. | WORKAROUND | Shard per-watch into a Queue (one message per watch) or Cron-triggered fan-out; results to D1. Cron route itself maps cleanly to Cloudflare Cron Triggers. |
| lib/orchestrator/orchestrator.ts | DEFAULT_MAX_STEPS = 40; each step = LLM call + tool execution. A full mission run can take many minutes of wall clock (LLM latency). | WORKAROUND | Cloudflare Workflows (durable step execution) or queue-chained steps with state in D1. |
| lib/missions/engine.ts, lib/workflow/engine.ts, lib/scheduler/runner.ts | Multi-step engines; scheduler tick is cron-gated (app/api/scheduler/tick/route.ts, CRON_SECRET bearer or signed-in session via lib/cron/gate.ts) | WORKAROUND | Cron Triggers for tick; engines to Workflows/queues. The `while(true)` in scheduler/runner.ts:125 is just a bounded worker-pool (runWithLimit) — not a daemon. |
| lib/substrate/memory/consolidate.ts | Growth Memory consolidation; MEMORY_WORKER_ROLE env distinguishes a dedicated worker role | WORKAROUND | Natural queue-consumer candidate; keep role env as a binding/env var. |
| app/api/studio/designs/render/route.ts (`runtime="nodejs"`) | Server JSON→PNG via render-server.ts (sharp, §A) | BLOCKER | Whole pipeline non-portable; replace renderer. |
| 15 routes with `export const runtime = "nodejs"` | listmonk ×6, postiz ×4, webhooks (callrail, lob, postgrid), media/links/go/[slug], studio/designs/render | WORKAROUND | Audit each: most are plain fetch/DB handlers that likely run fine under nodejs_compat once the flag is removed — the explicit `runtime="nodejs"` pins them out of edge. Remove pin after compat check per route; the render route stays BLOCKER. |
| lib/security/malware-scan.ts:50 | `connect(port, host)` to a ClamAV daemon (CLAMAV_HOST) | WORKAROUND | Daemon unreachable from Workers; use NoOp scanner at edge or scan in queue consumer with R2-hosted files. Fail-closed today (throws → 503) — decide edge posture explicitly. |
| lib/safe-url.ts:24-25 | SSRF guard does `lookup()` from node:dns/promises at request time | WORKAROUND | node:dns `lookup` is not in the Workers nodejs_compat surface the way used here (UNVERIFIED exact subset — confirm against compat table). Replace with IP-allowlist/proxy-egress or accept platform networking. |

## F. Payload CMS internals (@payloadcms/next, @payloadcms/db-postgres)

- @payloadcms/db-postgres deps: `pg`, drizzle-orm, drizzle-kit — **pure JS, no native**. → WORKAROUND (needs pg over a reachable DB: Workers → Hyperdrive or TCP proxy; DATABASE_URL to localhost:5433 will not resolve).
- payload core dist node: usage: only `node:path`/`node:fs`/`node:os`/`node:assert`/`node:process`/`node:url` in telemetry (`dist/utilities/telemetry/conf/`) and one `node:url` in dist/index.js. Telemetry does fs reads at init → WORKAROUND: disable Payload telemetry (env) so init never touches fs; the rest is compat-covered.
- payload.config.ts:1, payload/collections/Media.ts:1 — node:path only → FINE.
- withPayload(nextConfig) wrapper in next.config.ts — UNVERIFIED under OpenNext; confirm OpenNext's withPayload support before migration.

## G. next.config.* / proxy / instrumentation

- `output: "standalone"` — required for current Docker/VM deploy; OpenNext builds its own output → WORKAROUND: config must branch per target (keep standalone for Docker, drop/adjust for OpenNext). `outputFileTracingIncludes` (onnxruntime .so) and `serverExternalPackages: ["takumi-pdf"]` are standalone-trace concerns; the takumi workerd bundler (§A) replaces the externalize hack on Workers.
- `withPayload` wrapper — see §F (UNVERIFIED).
- proxy.ts (Next 16 middleware): JWT via getToken (AUTH_SECRET/NEXTAUTH_SECRET), in-memory fixed-window rate limiter (lib/api/rate-limit.ts:74 `new Map()`). On Workers: (a) proxy runs at edge fine, (b) **in-memory limiter is per-isolate — not global** → WORKAROUND: move buckets to KV or a DO; (c) secret must be a Worker secret/env binding, not process.env at build. No instrumentation.ts file — FINE (nothing to port).
- Security headers in next.config.ts headers() — portable as-is.

## H. Environment variable patterns

- ~most provider keys (OPENAI_API_KEY, STRIPE_*, provider API keys) read at request time → FINE as Worker secrets/env bindings. NEXT_PUBLIC_* inlined at build → FINE (verify values at OpenNext build time).
- **Break at the edge**: DATABASE_URL (localhost:5433 PG → Hyperdrive), CORPUS_DIR (lib/intelligence/corpus/store.ts:27 defaults to `data/corpus`), CC_GRAPH_DIR, SITE_STORAGE_DIR (lib/connectors/local.ts:148), FIX_SNAPSHOT_DIR (lib/audit/runner.ts:26), MEMORY_MODEL_CACHE (embed.ts:11), MEMORY_WORKER_ROLE (consolidate.ts — keep as env), CLAMAV_HOST/PORT (daemon unreachable), MARKETR_S3_* (the R2 path — REQUIRED for storage at edge).
- E2E_MOCK_OAUTH and friends — test-only, exclude from Worker bundle.

## I. Severity tally + UNVERIFIED items

- BLOCKER files: sharp ×2 (render-server.ts, media/qr.ts), @xenova/transformers/onnxruntime-node (embed.ts), @prisma/client engine (~150 files via lib/prisma.ts), child_process ×3 (corpus rebuild route, ingest.ts pdftotext, ctv validator ffmpeg), fs-write paths ×8+ (LocalDiskAdapter, outputStore, audit runner snapshots, websites working dir, 2 logo routes, corpus log, sqlite CC-graph), node:sqlite read path (difficulty/authority.ts via service.ts:114,120).
- WORKAROUND: takumi-pdf (workerd bundler exists), ssh2 SFTP, S3→R2 storage adapter (already built), corpus file ops → R2, sync/fleet/orchestrator/missions → Queues/Workflows/Cron Triggers, 15 runtime="nodejs" pins, in-memory rate limiter → KV, safe-url dns guard, malware-scan ClamAV, Payload pg → Hyperdrive + telemetry off, next.config standalone branch.
- FINE: WebSocket (none exists), node:crypto/path/url/os/util/zlib/readline imports (nodejs_compat), @imgly/background-removal (browser-only), next/font + @fontsource (build-time), takumi workerd condition, no instrumentation file.
- UNVERIFIED: (1) exact Workers nodejs_compat subset for node:dns/promises lookup as used in lib/safe-url.ts; (2) withPayload() under OpenNext; (3) whether scripts/ingest-corpus.mts pulls embed.ts (onnxruntime) into the rebuild job — likely, check during migration; (4) font/template fs reads inside lib/pdf/generate.ts at request time (only import lines verified).
