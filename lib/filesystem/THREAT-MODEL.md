# THREAT MODEL — W3 Workspace Filesystem (Phase B track B1)

**Date:** 2026-09-22 · **Author:** Z7 (subagent) · **Scope:** `lib/filesystem/`,
`app/api/files/`, `app/dashboard/files/`, chat-attach integration.

The filesystem is a multi-tenant boundary: every workspace's skills, memory,
artifacts, and files live behind it. A filesystem bug is a tenant-isolation bug.
The threat model therefore leads the build; the adversarial battery
(`scripts/verify-filesystem.mts`) must cover every abuse case below.

## Trust boundaries

- The **DB registry** (`WorkspaceFile`, `WorkspaceQuota`) is the authorization
  boundary — never the storage path, never the client-supplied filename.
- Storage adapters (local disk, S3-compatible) are dumb byte stores keyed by
  opaque UUIDs. They must never see user filenames or workspace IDs in keys.
- Internal service-to-service writes (scheduler run outputs) are trusted for
  provenance but NOT for type safety — they still pass the upload-safety gate
  unless they come from a server-generated path with no user bytes in it.

## Abuse cases

### 1. Path traversal (encoded, absolute, double-encoded)

- **Attack:** `logicalPath` like `/files/../../etc/passwd`, `..%2f..%2f`,
  `%252e%252e%252f`, absolute `/etc/shadow`, NUL bytes, Windows separators,
  trailing dots.
- **Mitigation:** `normalizeLogicalPath` is a strict whitelist parser:
  - must match `^\/(skills|memory|artifacts|files)(\/[A-Za-z0-9._-]{1,120})*$`,
    max depth 12, max total length 512;
  - rejects `..` as a literal segment *and* after `decodeURIComponent` (double
    decode is deliberately NOT applied to names — names may contain literal
    `%`; `..` after one decode round is rejected);
  - never concatenated with any base path — the DB row is the only mapping
    between logical path and the opaque storage key.
- **Residual:** filenames with Unicode lookalikes (`\u202e`) are display-safe
  (download sets `Content-Disposition` with ASCII-safe filename) but may
  confuse users in the UI. Accepted; mitigated by UI-side display, not storage.

### 2. IDOR via workspace_id confusion

- **Attack:** user in workspace A requests `fileId` belonging to workspace B;
  or passes A's workspaceId with B's fileId hoping the code checks only one.
- **Mitigation:** every service function takes `workspaceId` and re-queries
  the registry with `where: { id: fileId, workspaceId }` — a row from another
  workspace is indistinguishable from a nonexistent row (404 both ways, no
  existence oracle). API routes derive membership from
  `requireWorkspaceAccess(userId, workspaceId, min)`; they never trust a
  workspaceId embedded in a fileId or JWT claim alone. **Registry-first:
  fetch the row, then check `row.workspaceId === caller workspaceId`.**
- **Battery:** cross-workspace read/download/rename/move/trash/restore/purge
  all must 404.

### 3. Quota bypass, including concurrent uploads

- **Attack:** user races 20 simultaneous uploads past a "check then write"
  gap so `usedBytes` never reflects in-flight bytes.
- **Mitigation:** `writeFile` runs inside a serializable-ish transaction:
  `WorkspaceQuota` row is created eagerly (`limitBytes` = 10 GB default) and
  incremented via `usedBytes: { increment: sizeBytes }` inside the same
  transaction as the file-row insert. The pre-flight check reads the row with
  a row-level lock (`SELECT ... FOR UPDATE` via Prisma transaction + raw query)
  so two writers serialize. Quota check happens *after* upload-safety
  validation (cheap reject first) but *before* adapter.put; adapter.put
  happens inside the transaction so a failed insert never orphans bytes...
  with one caveat: local-disk writes cannot roll back on tx abort, so a
  reconciliation `purgeOrphanKeys` hook exists and storage keys are only
  reachable via registry rows (orphan bytes are unaddressable, not leakable).
- **Trashed files still count** against quota until purged — no "trash to free
  quota" bypass, and restore doesn't double-count.
- **Battery:** 20 parallel writes under a tightened limit must fail all-but-N
  with 413, final `usedBytes` exact.

### 4. Symlink attacks (local disk adapter)

- **Attack:** a `storageKey` that is actually a symlink pointing outside the
  storage root (e.g., attacker-influenced row, or a key crafted to contain
  `/`); or TOCTOU where a path is checked then replaced by a symlink.
- **Mitigation:**
  - Storage keys are `[0-9a-f-]{36}` UUIDs — regex-validated before any path
    construction; a key can never contain `/`, `..`, or NUL. The adapter
    refuses anything else.
  - `LocalDiskAdapter` resolves the final path and asserts
    `resolved.startsWith(storageRoot + sep)` (defense in depth).
  - Writes use `O_CREAT | O_EXCL`-equivalent semantics (write to a temp name
    inside the root, then atomic rename); the temp name is itself a random
    UUID, so an attacker cannot pre-place a symlink at the target.
  - `delete`/`get` operate on the UUID filename only — no follow semantics
    beyond what the final resolved path check enforces.
- **Battery:** key with `/` or `..` must be rejected by the adapter; a
  pre-planted symlink at the target name must not cause an overwrite outside
  the root (atomic-rename write path).

### 5. Storage-key guessing

- **Attack:** enumerate `/api/files/download?key=<guess>` to fetch another
  workspace's bytes.
- **Mitigation:** there IS no key-addressed endpoint. Downloads are addressed
  by registry `fileId` with the IDOR check (§2). Storage keys (UUIDv4, 122
  bits) never leave the server; they appear in no API response, no URL, no
  log line. `WorkspaceFile.storageKey` is stripped from every serializer.
- **Battery:** assert no route accepts a raw storageKey param; assert API
  responses never contain `storageKey`.

### 6. Trash / restore races

- **Attack:** two concurrent restores of the same file; restore to a path that
  another file now occupies; restore of a file whose quota accounting changed.
- **Mitigation:** trash/restore/delete are single-row updates guarded by the
  IDOR where-clause plus `trashedAt` state assertions inside the transaction:
  restore requires `trashedAt != null` and target logicalPath currently free
  (unique index on `(workspaceId, logicalPath)` where `trashedAt IS NULL` —
  partial unique index so trashed duplicates don't collide). Trash is
  idempotent (already-trashed → no-op success). Purge is admin-only and
  requires trashed state (can't purge a live file — prevents accidental or
  malicious data loss via "delete").
- **Battery:** double-trash idempotent; restore-collision 409; purge of live
  file 409; trash→restore→quota unchanged.

### 7. XSS via served SVG/HTML

- **Attack:** upload an SVG with `<script>` (or HTML) and get the victim's
  browser to execute it in Marketr's origin → session theft.
- **Mitigation:** layered:
  1. Upload-safety rejects active-content SVG at upload (Phase A pipeline).
  2. Download endpoint serves `X-Content-Type-Options: nosniff`,
     `Content-Security-Policy: sandbox` (no scripts, no origin access), and
     `Content-Disposition: attachment` for `text/html`, `image/svg+xml`,
     and anything not in an inline-safe list (images, PDF). Inline-safe
     types are still sniffed, never trusted from the stored mime alone.
  3. No user-controlled content is ever reflected into HTML pages unescaped
     (file names are textContent / React-escaped in the UI).
- **Battery:** fetch a stored SVG with inline disposition attempt → assert
  `content-security-policy: sandbox` and `content-disposition: attachment`
  headers present; assert upload-safety still blocks scripted SVG.

### 8. Content-type confusion on download

- **Attack:** upload `evil.jpg` containing HTML; download serves it as
  `text/html` based on stored mime or filename extension.
- **Mitigation:** served MIME comes from the **sniffed** mime recorded at
  upload (stored in the registry), never from the filename extension and
  never from a client-supplied header. The allow-list is the only source of
  inline-disposition types; everything else downloads as
  `application/octet-stream` + `attachment`. `nosniff` always set.
- **Battery:** polyglot HTML/JPEG → upload rejected (Phase A polyglot
  detection) or, if it ever passes, served as attachment octet-stream.

### 9. Logical-path squatting / skill overwrite

- **Attack:** upload a file to `/skills/<skill-id>/SKILL.md` shadowing an
  installed skill to inject prompt content into a future skill run.
- **Mitigation:** out of scope for B1 writes (roots are enforced, but
  skill-pack writes are reserved): `writeFile` with `kind: 'skill'` is
  restricted to the skill-install service principal (admin-only API path to
  be added by the scheduler/skill track; B1 exposes no UI write into
  `/skills`). The UI file manager only writes to `/files` and `/memory`;
  `/artifacts` writes come from internal run outputs. This reservation is
  documented in the service code.
- **Battery:** UI/API upload with `logicalPath` under `/skills/` as a
  non-install flow → 403.

### 10. Metadata / info leaks

- `listDir` returns name/path/size/mime/trashed only — no storageKey, no
  absolute paths, no internal error details. Errors are generic (`Not found`)
  to avoid oracle attacks (§2).
- Filenames are length-capped (255) and control-char stripped at write.

## Non-goals (from spec §9) — explicitly NOT defended here

Public sharing links (no such endpoint), content indexing/embeddings,
realtime collaboration, S3 versioning, multi-region replication.

## Residual risks (accepted, documented)

- In-memory/DB quota accounting vs eventual adapter reality: orphan bytes are
  unaddressable but consume disk until the (future) reaper runs. Accepted for
  B1; `purgeOrphans` helper is exported for a future scheduled job.
- The S3-compatible adapter's SigV4 signer is hand-rolled (~130 lines).
  Correctness is battery-tested against MinIO when available; with no
  credentials configured the adapter refuses to instantiate (fail closed).
- Local-disk storage is single-box; multi-instance deployments MUST use S3.
  This is enforced by config validation at boot when `MARKETR_STORAGE=s3`
  without credentials.

## Phase 21B (WS=drive) additions

### 11. Private homes (`/home/<userId>`)
- `files.ownerUserId` marks a file as private to its owner. Every read path checks it: the
  actor-aware layer (`lib/drive/access.ts`, `lib/files/access.ts` `fileRoleFor`) resolves a role
  or `null` (a 404, never a 403, so existence is not an oracle); `readFile`/`getFile` themselves
  refuse a private file unless the caller names its owner (`readFileAuthorised` is only for
  callers that already ran the access check); `listDir`, the tree reads, the Trash, the change
  feed, Spotlight (`file`, `file_content`, `folder`) and storage usage all filter it.
- Admins and workspace owners get nothing special: there is no break-glass (an owner decision).
- Test: `lib/drive/__tests__/drive-db.test.ts`, `library-db.test.ts`.

### 12. Case-insensitive collisions, Unicode, Windows names
- Names are NFC; `path_key` (lower-cased NFC) is unique among live rows; reserved device names,
  forbidden characters, trailing dots/spaces, control/bidi/zero-width characters are refused.
- Test: `lib/filesystem/__tests__/paths-drive.test.ts`, `drive-db.test.ts`.

### 13. Multipart uploads
- Presigned PUT URLs name one part, expire in 15 minutes and are signed with SigV4 query auth
  (verified against the AWS documentation vector). The browser never gets storage credentials.
- The upload row belongs to the person who started it; others get 404. The assembled object is
  size-checked, type-checked, and scanned end to end by the malware scanner; a flagged object is
  deleted. Hosted deployments refuse to start an upload without `CLAMAV_HOST`.
- Residual: abandoned multipart uploads hold space at the provider until `expireUploadsFor` runs
  or a bucket lifecycle rule (`AbortIncompleteMultipartUpload`, 2 days recommended) is set.

### 14. Archive extraction
- `extractZip` (pure) plans before it inflates: unsafe names, symbolic links, special files,
  case collisions, declared-size and ratio limits, entry-count limit; inflation is capped at the
  declared size + 1 so a lying header fails. Test: `lib/drive/__tests__/extract.test.ts`.

### 15. Agents and sandboxes
- A run writes only inside `/agents/<runId>` and the folders the person attached, and never with
  more rights than that person (`lib/drive/grants.ts`, `tools.ts`). Existing files are changed only
  with a Tier 2 confirmation (never auto); the sandbox sync never overwrites (it stages for a
  person); symbolic links in the sandbox are never read. The marker file inside a sandbox is
  untrusted: the folder it names must be inside the run's grant at sync time.
- Apps get their own container and quota, and files only through opaque, signed, expiring handles
  that die with the picker's access (`lib/drive/app-container.ts`, `handles.ts`).

### Residual risks added in 21B
- Journal writes serialise all structural writes in a workspace behind one lock (correctness over
  throughput). A very write-heavy workspace will queue.
- `workspace_files.size_bytes` is a 32-bit integer: files are capped at 2 GiB − 1 until a BIGINT
  migration.
- Google Drive and S3 multipart behaviour against the real services is UNVERIFIED-LIVE.
