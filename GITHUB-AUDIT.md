# GitHub Integration Audit — Marketr

**Date:** 2026-09-21
**Scope:** Everywhere the platform touches GitHub repos — connectors, API routes, UI, and downstream consumers.
**Method:** Read-only code review. No source files modified.

> **Day-1 remediation note (2026-09-22):** The day-1 hardening pass (`fix(day1): security hardening + critical edge-case fixes`) did not change any GitHub-integration paths — the gaps below are feature work, not security findings, and were out of day-1 scope. They remain open as documented. The only deploy-path change in day-1 was the Cloudflare Pages manifest format fix (path→hash), which does not touch the GitHub connector.

---

## 1. Architecture (how GitHub fits in)

Marketr uses a **working-copy model** for GitHub-backed sites:

```
GitHub repo ──sync──▶ local working copy (.data/sites/<siteId>) ──deploy──▶ GitHub repo (one commit)
                        ▲
                        │ the IDE, fix agent, and programmatic publisher
                        │ ALL edit the working copy — never GitHub directly
```

- `lib/connectors/github.ts` — `GitHubSiteFileProvider`: full GitHub REST implementation (no Octokit), `isLive = true`. Implements `SiteFileProvider` + repo ops (`listRepos`, `createRepo`, `pushFiles`).
- `lib/connectors/mock-github.ts` — `MockGitHubConnector`: deterministic labeled mock, `mock: true` on every row.
- `lib/connectors/source.ts` — `getSiteRemote()` builds live-or-mock connector from the decrypted `Site.configEnc`; `getSiteIdeProvider()` always returns the local working copy.
- `lib/connectors/types.ts` — `GitHubConnector` interface, `GitHubConfig { token, owner, repo, branch, demo }`.

## 2. What works (verified in code)

| Capability | Where | Status |
|---|---|---|
| Connect via PAT (paste token, list repos, pick or create repo, choose branch) | `components/SitesManager.tsx` → `POST /api/websites/github/repos` | ✅ Implemented |
| Token stored encrypted (AES-256-GCM) in `Site.configEnc`, decrypted server-side only, never sent to client | `app/api/websites/route.ts`, `lib/connectors/source.ts` (`decryptSiteConfig`, `publicSite`) | ✅ Implemented |
| Admin+ required to connect credentialed sources | `app/api/websites/route.ts` (`storesCredentials` → `minRole = "admin"`) | ✅ Implemented |
| Credential connect audit-logged | `app/api/websites/route.ts` (`credential_created`) | ✅ Implemented |
| Sync remote → working copy | `POST /api/websites/[id]/sync` (`app/api/websites/[id]/sync/route.ts`) | ✅ Implemented |
| Deploy working copy → GitHub in **one commit** via Git Data API (blobs → tree → commit → ref update), returns commit SHA | `POST /api/websites/[id]/deploy` + `GitHubSiteFileProvider.pushFiles` | ✅ Implemented |
| Deploy audit-logged with commit SHA | `app/api/websites/[id]/deploy/route.ts` | ✅ Implemented |
| IDE edits GitHub-backed sites (banner shows `owner/repo@branch`) | `app/dashboard/projects/[id]/ide/page.tsx` → `components/SiteIde.tsx` | ✅ Implemented |
| AI proposes → user approves (supervised rung); saves land in working copy | `components/SiteIde.tsx` (`saveFile`, `applyProposal`) | ✅ Implemented |
| Fix agent applies to working copy with snapshots + one-click revert | `lib/audit/runner.ts` (provider = `getSiteIdeProvider`) | ✅ Implemented (working copy only — see §4) |
| Programmatic SEO pages push to site working copy | `lib/seo/programmatic-publish.ts` (`"marketr-site"` target) | ✅ Implemented (working copy only — see §4) |
| Demo/mock mode end-to-end (no token or network) | `MockGitHubConnector`, `demo` flag throughout | ✅ Implemented |
| Create repo (private by default) | `GitHubSiteFileProvider.createRepo` → `POST /user/repos` | ✅ Implemented |
| Honest mock labeling in UI | `SitesManager.tsx` (`mock` badges), `siteIsMock` | ✅ Implemented |

## 3. Credential & security handling

- **Storage:** PAT in `Site.configEnc`, AES-256-GCM (`lib/secrets`), same crypto as M6/M13. Server-side decrypt only.
- **Transport:** PAT is pasted into the browser and POSTed to the API (HTTPS assumed in production via Caddy); held in React state during the connect flow; the `/github/repos` route explicitly does **not** persist it — persistence happens only on site creation.
- **Scopes:** UI says "needs repo scope". For classic PATs that's correct. For fine-grained PATs the actual requirement is **Contents: read/write** — this is **not documented** anywhere (small doc gap).
- **Auth model:** PAT-only. No GitHub OAuth App flow exists (see gap #6).
- **Roles:** connect/delete = admin+; sync/deploy/edit = editor+ (`lib/authz.ts`).

## 4. Design decisions that look like gaps (but are intentional)

- **IDE/fix-agent/M17 write to the working copy, not to GitHub directly.** Deploy is the explicit push step. This is the trust ladder (supervised → scheduled) working as designed — but it means fixes and programmatic pages sit unpublished until someone clicks Deploy.
- **`GitHubSiteFileProvider.writeFile` (per-file Contents API PUT) is implemented but unused** — nothing in the app calls it for GitHub sites, because the IDE always edits the working copy. Dead code in the live path (kept for interface conformance).

## 5. Gaps (numbered, with effort estimates)

### Gap 1 — No token rotation / config update (MEDIUM)
- **File:** `app/api/websites/[id]/route.ts` (only `GET` and `DELETE` exist — no `PATCH`).
- **What's missing:** When a PAT expires or is revoked, or the user wants to switch branch/owner, there is no way to update the stored config. The only path is **delete the site** (which wipes the working copy from disk) **and reconnect from scratch**.
- **Work:** Small–medium — add `PATCH /api/websites/[id]` accepting `github: { token?, branch?, owner?, repo? }`, re-encrypt `configEnc`, admin+ gated, audit-logged; add a "Settings / reconnect" UI in `SitesManager`.

### Gap 2 — Sync has no conflict detection (MEDIUM, data-loss risk)
- **File:** `app/api/websites/[id]/sync/route.ts`.
- **What's missing:** Sync blindly overwrites every working-copy file with remote content. If the user edited files in the IDE since the last sync (or the fix agent ran), those changes are **silently clobbered** — no dirty check, no warning, no merge.
- **Work:** Medium — record a sync watermark (remote commit SHA at last sync); before overwriting, compare working-copy files against the watermarked state; surface a conflict list in the UI and require explicit "overwrite" confirmation.

### Gap 3 — Deploy cannot delete remote files (SMALL–MEDIUM)
- **Files:** `lib/connectors/github.ts` (`pushFiles`), `lib/connectors/types.ts` (no `deleteFile` in any interface).
- **What's missing:** `pushFiles` builds the new tree on top of `base_tree`, so files deleted in the working copy **persist on GitHub** and get re-synced back on the next sync. There is no delete path at all — the connector interface doesn't even declare one.
- **Work:** Small — add `deleteFiles(paths[])` using the Git Data API (build tree from `base_tree` minus deleted paths); wire a "also delete N removed files" option into the deploy route/UI.

### Gap 4 — No GitHub OAuth (MEDIUM, UX)
- **Files:** `components/SitesManager.tsx` (PAT paste input), `app/api/websites/github/repos/route.ts` (takes raw `token` in body).
- **What's missing:** No GitHub App OAuth flow — users must mint a PAT manually and paste it. No token expiry/refresh handling; a dead token is only discovered when sync/deploy fails.
- **Work:** Medium — register a GitHub App, add OAuth authorize/callback routes, store refreshable user-to-server tokens encrypted per workspace. (PAT path can stay as fallback.)

### Gap 5 — No diff/preview before deploy; commit message not editable in UI (SMALL–MEDIUM)
- **Files:** `app/api/websites/[id]/deploy/route.ts` (accepts `message` but UI never sends it), `components/SitesManager.tsx` (`deploySite` sends only `{ projectId }`).
- **What's missing:** Deploy pushes the **entire working copy** with no "what will change" summary, and the commit message is always the default `Marketr deploy: <site name>`. No way to review or annotate what's going out.
- **Work:** Small–medium — compare working-copy file hashes against the last-synced remote state to produce a changed/added/deleted list; add a confirm modal with editable commit message.

### Gap 6 — No webhooks / inbound repo events (MEDIUM–LARGE if wanted)
- **Files:** (none — no webhook routes exist; `grep webhook` finds nothing GitHub-related).
- **What's missing:** No `push`-event ingestion, no auto-sync when the repo changes outside Marketr, no PR-based review flow. The platform only ever talks **to** GitHub, never listens.
- **Work:** Large if done fully (webhook receiver + signature verification + per-site auto-sync + notifications). Not required for the current working-copy model — flag as future.

### Gap 7 — GitHub push doesn't trigger hosting deploys (MEDIUM)
- **Files:** `app/api/websites/[id]/deploy-hosting/route.ts`, `lib/deploy/`.
- **What's missing:** M9 Vercel/Cloudflare deploys **upload files directly** — there is no "import this GitHub repo into Vercel/Cloudflare" flow. Pushing to GitHub does not redeploy hosting; the user deploys twice (git push, then hosting deploy). Anyone expecting the standard git-push-to-deploy loop will be surprised.
- **Work:** Medium — optional "connect repo to hosting project" path in the deploy-hosting flow, or document that hosting deploy is file-upload based.

### Gap 8 — No "test connection" for existing sites (SMALL)
- **Files:** `lib/connectors/github.ts` (`test()` exists), but no API route wires it for sites (WP/Webflow have `/test` routes: `app/api/websites/wordpress/test/route.ts`, `app/api/websites/webflow/test/route.ts`).
- **What's missing:** A dead/expired PAT is only discovered at sync/deploy time. WP and Webflow both have test buttons; GitHub doesn't.
- **Work:** Small — add `POST /api/websites/[id]/test-connection` calling `connector.test()`, plus a button in `SitesManager`.

### Gap 9 — Deploy creates a commit even when nothing changed (SMALL)
- **File:** `app/api/websites/[id]/deploy/route.ts` → `pushFiles` (no change detection).
- **What's missing:** Every deploy builds blobs/tree/commit unconditionally. Deploying twice in a row creates an empty commit the second time.
- **Work:** Small — compare the new tree SHA against the branch's current tree SHA; skip the commit when identical.

### Gap 10 — Fine-grained PAT scope requirements undocumented (SMALL, docs)
- **Files:** `components/SitesManager.tsx` ("needs repo scope"), `DEPLOY.md`.
- **What's missing:** No note that fine-grained PATs need **Contents: read/write** (and nothing else). Users guessing scopes will hit 403s.
- **Work:** Trivial — one line in the connect form + DEPLOY.md.

### Verification caveat (not a code gap)
The live GitHub paths were **never exercised against the real API** from the sandbox — `lib/connectors/github.ts` is written against public REST/Git-Data-API docs, and `mock-github.ts` covers the flow. `DEPLOY.md` §"Live verification checklist" already includes: *"GitHub (real PAT): connect, browse a scratch repo, commit a change, confirm the commit SHA."* That checklist item is the gate before calling this production-ready.

---

## 6. Consumer-by-consumer verdict

| Consumer | Needs GitHub? | Verdict |
|---|---|---|
| **Site IDE** (M6/M7) | Browse + edit repo files | ✅ Fully wired — via working copy; sync/deploy bridge is solid |
| **Site deploys** (M7) | Push working copy → repo | ✅ Fully wired — one-commit push, SHA returned, audit-logged |
| **Landing page builder** (M7) | Publish generated pages | ✅ Wired — writes to site working copy; needs manual Deploy for GitHub sites |
| **Fix agent** (M10) | Apply approved fixes | ✅ Wired to working copy (by design); GitHub update requires Deploy |
| **Programmatic SEO push** (M17) | Push generated pages | ✅ Wired to working copy (by design); GitHub update requires Deploy |
| **Vercel/Cloudflare deploys** (M9) | Git-backed hosting deploys | ⚠️ Partial — file-upload deploys only; no repo-linked auto-deploys (Gap 7) |
| **WordPress/Webflow** (M8) | Nothing GitHub-related | N/A — content APIs, correctly separate |
| **Newsletters / social / ads / studio** (M19–M22) | Nothing GitHub-related | N/A |

## 7. Bottom line

The GitHub integration is **genuinely implemented, not stubbed** — connect, browse, sync, edit-in-IDE, and one-commit deploy are all real code with a faithful mock for testing. Credential handling is sound (encrypted at rest, server-side only, admin-gated, audit-logged).

The weak spots are all **around the edges of the working-copy model**: no credential rotation without delete-and-reconnect (Gap 1), sync can silently clobber local edits (Gap 2), deploys can't delete remote files (Gap 3), and the live API has never been hit (verification caveat). None of these block a private beta, but Gaps 1–3 should be fixed before agency clients touch it.
