// ShapesOS — Phase 9 (sites), end to end against Postgres (as the app role):
//   1. site_checkout → edit → site_publish_draft writes a DRAFT revision
//      (site_revisions, FORCE RLS) from the TEST-ONLY fake sandbox; the live
//      working copy is untouched; the run's Changes review shows the draft's
//      diff.
//   2. RLS: no GUC → zero rows; another workspace sees none and can't write
//      one for this workspace.
//   3. Applying a draft writes the working copy and keeps a backup revision
//      (restoring it reverts); a site that moved on is refused unless forced;
//      a draft applies once; discard.
//   4. Rollback: the request lands in the real Phase 14 approval queue; it
//      runs only after approval (labelled mock Netlify target), once; the
//      Composio execute path refuses it.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… MARKETR_CREDENTIALS_KEY=… npx tsx --test lib/sites/__tests__/site-revisions-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { prisma } from "@/lib/prisma";
import { countWithoutScope, withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createAgentRun } from "@/lib/agents/runs/service";
import { loadRunReview } from "@/lib/ship/review";
import type { ToolContext, ToolDef } from "@/lib/chat/tools";
import { createFakeSandbox, type FakeSandbox } from "@/lib/ship/__tests__/fake-sandbox";
import { decideApproval, executeApproved } from "@/lib/integrations/actions/gate";
import { buildDeployTarget, encryptHostingConfig } from "@/lib/deploy";
import {
  RollbackError,
  executeRollback,
  openRollbackApprovals,
  phase14RollbackPort,
  requestRollback,
  rollbackBinding,
} from "@/lib/deploy/rollback";
import { createSiteTools, defaultSiteToolDeps } from "../tools";
import { readSiteWorkingCopy, writeSiteWorkingCopy } from "../files";
import { createSiteRevision, getSiteRevision, listSiteRevisions } from "../revisions";
import { SiteRevisionError, applySiteRevision, discardSiteRevision } from "../apply";

const RUN = `p9s-${Date.now().toString(36)}`;
const WS_A = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const USER = `${RUN}-user`;
let projectId = "";
let siteId = "";
let runId = "";
let sb: FakeSandbox;
const storage = mkdtempSync(path.join(tmpdir(), "shapes-site-storage-"));
const savedStorage = process.env.SITE_STORAGE_DIR;

const LIVE = [
  { path: "/index.html", content: "<h1>Acme</h1>\n<p>Call us</p>\n" },
  { path: "/old.html", content: "<p>old page</p>\n" },
];

let tools: Map<string, ToolDef>;
const ctx = (): ToolContext => ({ projectId, workspaceId: WS_A, userId: USER, role: "editor", confirmed: false, runId });

before(async () => {
  process.env.SITE_STORAGE_DIR = storage;
  sb = createFakeSandbox();
  tools = new Map(
    createSiteTools({ ...defaultSiteToolDeps, getSandbox: async () => sb }).map((t) => [t.name, t]),
  );
  for (const id of [WS_A, WS_B]) await prisma.workspace.create({ data: { id, name: `P9 ${id}`, ownerUserId: USER } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS_A, domain: `${RUN}.example` } })).id;
  siteId = (await prisma.site.create({ data: { projectId, name: "Acme Landing", sourceType: "file", configEnc: "" } })).id;
  await writeSiteWorkingCopy(siteId, LIVE);
  runId = (await createAgentRun({ workspaceId: WS_A, kind: "chat", startedBy: USER, agentKey: "actor", allowedTools: ["workspace", "code", "site"] })).id;
});

after(async () => {
  for (const id of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await sb.destroy();
  await fs.rm(storage, { recursive: true, force: true });
  if (savedStorage === undefined) delete process.env.SITE_STORAGE_DIR;
  else process.env.SITE_STORAGE_DIR = savedStorage;
  await prisma.$disconnect();
});

let draftId = "";

describe("agent draft from the sandbox", () => {
  it("checkout → edit → publish_draft stores a draft and leaves the live copy alone", async () => {
    await tools.get("site_checkout")!.execute(ctx(), { site: "Acme Landing" });
    const dir = path.join(sb.workdir, "sites", "acme-landing");
    await fs.writeFile(path.join(dir, "index.html"), "<h1>Acme</h1>\n<p>Call us today</p>\n");
    await fs.rm(path.join(dir, "old.html"));
    await fs.writeFile(path.join(dir, "offer.html"), "<p>$49 drain cleaning</p>\n");
    const r = await tools.get("site_publish_draft")!.execute(ctx(), { summary: "Sharper offer page" });
    assert.match(r.summary, /Saved draft #1 of Acme Landing/);

    const list = await listSiteRevisions(WS_A, siteId);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.status, "draft");
    assert.equal(list[0]!.source, "agent");
    assert.equal(list[0]!.runId, runId);
    assert.equal(list[0]!.hasPatch, true);
    draftId = list[0]!.id;
    const full = await getSiteRevision(WS_A, siteId, draftId);
    assert.deepEqual(full!.files.map((f) => f.path), ["/index.html", "/offer.html"]);
    assert.match(full!.patch!, /\+<p>Call us today<\/p>/);

    // The live working copy did not change.
    const live = await readSiteWorkingCopy(siteId);
    assert.deepEqual(live.files, LIVE);

    // The run's Changes review shows the draft's diff.
    const review = await loadRunReview(WS_A, runId);
    assert.equal(review?.changes?.source.tool, "site_publish_draft");
    assert.ok(review!.changes!.files.some((f) => f.path.includes("offer.html")));
  });

  it("site_revisions is FORCE RLS: no scope → 0 rows; another workspace sees and writes nothing", async () => {
    assert.equal(await countWithoutScope("site_revisions"), 0);
    assert.equal((await listSiteRevisions(WS_B, siteId)).length, 0);
    assert.equal(await getSiteRevision(WS_B, siteId, draftId), null);
    await assert.rejects(
      withWorkspaceScope(WS_B, (tx) =>
        tx.siteRevision.create({ data: { workspaceId: WS_A, siteId, number: 99, files: [] } }),
      ),
      /row-level security|violates/i,
    );
  });
});

describe("applying a draft", () => {
  it("writes the working copy exactly and keeps a backup; a draft applies once", async () => {
    const out = await applySiteRevision({ workspaceId: WS_A, projectId, siteId, revisionId: draftId, userId: USER });
    assert.equal(out.written, 2);
    assert.deepEqual(out.removed, ["/old.html"]);
    const live = await readSiteWorkingCopy(siteId);
    assert.deepEqual(live.files.map((f) => f.path), ["/index.html", "/offer.html"]);

    const draft = await getSiteRevision(WS_A, siteId, draftId);
    assert.equal(draft!.status, "applied");
    assert.equal(draft!.appliedBy, USER);
    const backup = await getSiteRevision(WS_A, siteId, out.backupId);
    assert.equal(backup!.status, "backup");
    assert.deepEqual(backup!.files, LIVE);

    await assert.rejects(
      applySiteRevision({ workspaceId: WS_A, projectId, siteId, revisionId: draftId, userId: USER }),
      (e: unknown) => e instanceof SiteRevisionError && e.code === "not_applicable",
    );
    const log = await prisma.fileChangeLog.findFirst({ where: { siteId, action: "ai_applied" } });
    assert.match(log!.summary, /Applied agent draft #1/);

    // Restoring the backup is the revert.
    await applySiteRevision({ workspaceId: WS_A, projectId, siteId, revisionId: out.backupId, userId: USER });
    assert.deepEqual((await readSiteWorkingCopy(siteId)).files, LIVE);
  });

  it("refuses a draft whose site moved on, unless forced; discard", async () => {
    const stale = await createSiteRevision({
      workspaceId: WS_A,
      siteId,
      status: "draft",
      source: "agent",
      files: [{ path: "/index.html", content: "stale" }],
      baseFingerprint: "not-the-current-site",
    });
    await assert.rejects(
      applySiteRevision({ workspaceId: WS_A, projectId, siteId, revisionId: stale.id, userId: USER }),
      (e: unknown) => e instanceof SiteRevisionError && e.code === "site_changed" && e.status === 409,
    );
    await applySiteRevision({ workspaceId: WS_A, projectId, siteId, revisionId: stale.id, userId: USER, force: true });
    assert.equal((await readSiteWorkingCopy(siteId)).files[0]!.content, "stale");

    const other = await createSiteRevision({ workspaceId: WS_A, siteId, status: "draft", source: "agent", files: [{ path: "/a.html", content: "a" }] });
    await discardSiteRevision({ workspaceId: WS_A, siteId, revisionId: other.id });
    assert.equal((await getSiteRevision(WS_A, siteId, other.id))!.status, "discarded");
    await assert.rejects(discardSiteRevision({ workspaceId: WS_A, siteId, revisionId: other.id }), /Only a draft/);
    const numbers = (await listSiteRevisions(WS_A, siteId)).map((r) => r.number);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => b - a), "per-site sequence, newest first");
    assert.equal(new Set(numbers).size, numbers.length);
  });
});

describe("rollback through the approval gate", () => {
  it("requests → approval → runs once on the labelled mock; Composio execute refuses it", async () => {
    const conn = await prisma.hostingConnection.create({
      data: { projectId, name: "Netlify demo", target: "netlify", configEnc: encryptHostingConfig({ demo: true }) },
    });
    const old = await prisma.deployment.create({
      data: { siteId, projectId, connectionId: conn.id, target: "netlify", url: "https://a.netlify.app", deploymentId: "mock-dep-netlify-001", status: "ready", mock: true, providerProject: "mock-site" },
    });
    const binding = rollbackBinding(old);
    const pending = await requestRollback(phase14RollbackPort, { workspaceId: WS_A, binding, actor: USER, summary: "Roll back Acme Landing" });
    assert.equal(pending.status, "pending");
    const open = await openRollbackApprovals(WS_A, siteId);
    assert.deepEqual(open.get(old.id), { approvalId: pending.id, status: "pending" });
    assert.equal((await openRollbackApprovals(WS_B, siteId)).size, 0);

    const target = buildDeployTarget("netlify", { demo: true });
    await assert.rejects(
      executeRollback(phase14RollbackPort, { workspaceId: WS_A, binding, approvalId: pending.id, actor: USER, target, place: {} }),
      (e: unknown) => e instanceof RollbackError && e.code === "approval_pending",
    );

    await decideApproval({ workspaceId: WS_A, approvalId: pending.id, decision: "approved", decidedBy: USER });
    await assert.rejects(executeApproved({ workspaceId: WS_A, approvalId: pending.id, executedBy: USER }), /deployment list/);

    // A different rollback can't ride on this approval.
    await assert.rejects(
      executeRollback(phase14RollbackPort, { workspaceId: WS_A, binding: { ...binding, providerDeploymentId: "x" }, approvalId: pending.id, actor: USER, target, place: {} }),
      (e: unknown) => e instanceof RollbackError && e.code === "binding_mismatch",
    );
    const out = await executeRollback(phase14RollbackPort, { workspaceId: WS_A, binding, approvalId: pending.id, actor: USER, target, place: { project: "mock-site" } });
    assert.equal(out.result.mock, true);
    assert.equal(out.result.status, "ready");
    await assert.rejects(
      executeRollback(phase14RollbackPort, { workspaceId: WS_A, binding, approvalId: pending.id, actor: USER, target, place: {} }),
      (e: unknown) => e instanceof RollbackError && e.code === "approval_replayed",
    );
    const row = await withWorkspaceScope(WS_A, (tx) => tx.composioActionApproval.findFirst({ where: { id: pending.id } }));
    assert.equal(row!.status, "executed");
    assert.equal(row!.appKey, "hosting");
  });
});
