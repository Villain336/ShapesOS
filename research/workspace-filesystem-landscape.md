# Private per-Workspace Filesystem — Landscape Brief (2026-09-22)

## 1. Isolation patterns (concrete)
- **Shared bucket + tenant prefix** is the common default: `s3://bucket/<tenant-id>/…` with bucket policies / IAM per-prefix (AWS Storage Blog: three patterns — dedicated bucket per tenant, shared bucket + prefixes, S3 Access Points per tenant). Azure's guidance mirrors this: shared file shares with per-tenant paths → per-tenant shares → per-tenant storage accounts, in order of cost/complexity.
- "A shared S3 bucket with tenant subdirectories is **not isolated — it is organized**." Real isolation means IAM/ACL policies making cross-tenant reads impossible at the storage layer, not just unlikely via naming (4spotconsulting SaaS isolation guide).
- **DB-per-org** (SAP Astonish): separate Postgres database per organization — a connection to org_001 literally cannot query org_002's tables; backups/exports naturally per-org. Strongest, ~5–50× the cost of metadata filtering; most SaaS use a hybrid: pooled for small tenants, siloed for enterprise.
- Takeaway for Marketr: files should live under one **storage root keyed by workspace_id**, but every read/write must also pass a **DB file registry** scoped by workspace — the registry is the real boundary, the prefix is organization.

## 2. Unified filesystem for skills, memory, artifacts, files
- **ByteDance OpenViking**: `viking://` protocol unifying agent context, memories, resources, skills, knowledge under standard filesystem semantics (`ls`/`find`), with tiered context layers — L0 summary, L1 overview, L2 full content — to keep token cost down (reported 24.6M → 4.2M tokens on LoCoMo). This is the closest production precedent for "everything is a file."
- **LangChain deepagents CompositeBackend**: routes `/memories/` (durable `AGENTS.md`), `/workspace/` (shared working files), and everything else thread-scoped; backs it on Azure Blob Storage with prefixes that appear as folders in the portal — so agents, UI file browsers, and APIs all see the same tree.
- **LangChain Agent Builder** pattern: AGENTS.md (procedural memory), `skills/`, `tools.json`, `knowledge/` — files stored in Postgres and exposed to the agent as a virtual filesystem ("the files are the agent; move the folder, move the agent").
- **"The Folder Is the Agent"** convention (practitioner pattern): `system/` (read-only instructions), `skills/` (markdown task playbooks), `memory/` (append-only notes), `inbox/`, `outputs/` — agent tools are just `list_dir`/`read_file`/`write_file`; the system prompt teaches the *map*, not the content.
- Access model that recurs: agent gets file tools scoped to its workspace root; humans get a file-manager UI over the same paths; API serves bytes. One namespace, three surfaces.

## 3. Quotas, versioning, backup/restore, trash
- **Quotas**: enforce per-tenant limits at the gateway — storage cap (e.g. 10 GB), query rate, indexing throughput — so one tenant can't stall others (multi-tenant RAG design notes). Count bytes in the DB registry on write; check quota *before* accepting bytes.
- **Versioning**: object versioning on the store, or explicit version rows for agent memory (AWS config-service pattern: `version` field + rollback). Keep versions cheap: only for `memory/` and `skills/`, not bulk uploads.
- **Trash**: soft-delete flag with a recovery window (Salesforce ships 30-day `_trash` folders, then hard delete). Soft-delete is good for recovery, bad for compliance — after the window, hard-delete and prove it (cryptographic erasure = destroy the per-tenant key).
- **Backup/restore**: per-workspace export on demand and at offboarding (SaaS tenancy runbooks treat onboarding/suspension/offboarding as first-class). Backup scope inherits data sensitivity — encrypt backups with a *different* key than live data.

## 4. Self-hosted: local disk vs S3-compatible
- **Local disk** (Zulip's `LOCAL_UPLOADS_DIR`): fastest to ship; **breaks the moment you run two app servers** — uploads land on different machines. Also hits inode/IOPS limits at scale and makes backups host-coupled. Fine for single-box self-host, not for HA.
- **S3-compatible (MinIO/RustFS/Ceph/Garage)**: the standard self-host answer. InsForge's pattern — bundle MinIO on the internal Docker network, proxy mode so the store is unreachable by browsers, presigned URLs optional — is a good template for Marketr self-host.
- What breaks at scale with S3-compatibles: **same-key write limits differ** (GCS ~1 write/s/object, Cloudflare R2 ~1 concurrent write/s; excess returns 429); **conditional writes (If-None-Match) are "unknown until tested"** per provider — quota/claim races can double-run jobs on providers that don't enforce them (loonfs provider matrix). Test your chosen backend's semantics, don't assume AWS parity.
- Cost angle: S3 egress and API-call pricing punish chatty agent file access; cache hot reads locally.

## 5. Honest risks
- **Path traversal is real and recent**: OpenWebUI had CVE-2026-44566 (path traversal → arbitrary file write) chained with CVE-2026-54012 (IDOR cross-tenant file access) disclosed May 2026; small AI startups leaked RAG knowledge bases. Defenses: never trust user filenames in paths — store content-addressed keys (`<workspace>/<uuid>`), sanitize with `Path().name`, normalize + re-verify the resolved path stays under the workspace root.
- **Zip-slip**: extracting archives with `../` entries writes outside the root. Don't extract agent/workspace archives, or validate every entry path.
- **Quota bypass**: presigned direct-to-S3 uploads skip the app's byte counting — always close the loop with a server-side completion callback that records bytes, or route uploads through the backend.
- **Cache/scoping bugs**: cache keys without `tenant_id` are the #1 multi-tenant leak class; bulk export endpoints are where a forgotten `.where(workspace_id)` leaks the most per request (runverdict review toolkit).
- **Backup cost**: versioning + soft-delete + per-workspace backups multiply stored bytes fast; set retention caps per class up front.

## Recommendation sketch for Marketr
S3-compatible backend (MinIO bundled for self-host, real S3/R2 for hosted) + DB file registry as the authorization boundary + content-addressed keys under `ws_<id>/` prefixes + one write path that enforces quota + 30-day trash + versions only for `memory/` and `skills/`. Single namespace — `skills/`, `memory/`, `artifacts/`, `files/` — surfaced via agent tools, a UI file manager, and the API.

Sources: AWS Storage Blog (S3 multi-tenant patterns), Azure Architecture Center (multitenant storage), SAP Astonish multi-tenant platform ADR, 4spotconsulting isolation guide, langchain-azure deepagents storage backend, OpenViking via Oracle Developers, runverdict sf-security-review-toolkit, rafter-cli secure-design docs, Zulip upload-backends, InsForge self-host storage, loonfs object-storage provider matrix, narwhal-lab OpenWebUI CVE case (CVE-2026-44566 / CVE-2026-54012). Flags: token-consumption claims for OpenViking come from a Medium summary of a ByteDance paper — couldn't verify the primary source.
