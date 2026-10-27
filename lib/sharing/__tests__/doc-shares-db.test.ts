// ShapesOS — Phase 23: Office doc + report share links against real Postgres
// (least-privilege app role; RLS batteries are meaningful).
//   - create: token returned once, only the SHA-256 is persisted; expiry
//     clamps to the family default/max; a link can't be minted for a doc in
//     another workspace
//   - list: newest first, no token material; revoke is immediate
//   - resolve (the public-route lookup): live link resolves with its doc;
//     revoked, expired and unknown tokens all resolve null (no oracle);
//     the doc read itself runs under the link's own workspace scope
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  createDocShare,
  createReportShare,
  hashShareToken,
  listDocShares,
  listReportShares,
  resolveDocShareToken,
  resolveReportShareToken,
  revokeDocShare,
  revokeReportShare,
  DOC_SHARE_TOKEN_PREFIX,
  REPORT_SHARE_TOKEN_PREFIX,
} from "../doc-shares";

const RUN = randomUUID().slice(0, 8);
const WS_A = `p23a-${RUN}`;
const WS_B = `p23b-${RUN}`;
const USER = `p23-user-${RUN}`;

let docId = "";
let reportId = "";

before(async () => {
  for (const ws of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id: ws } });
  for (const ws of [WS_A, WS_B]) {
    await prisma.workspace.create({ data: { id: ws, name: ws, ownerUserId: USER } });
    await prisma.workspaceMember.create({
      data: { workspaceId: ws, userId: USER, role: "admin", email: `p23-${RUN}@example.test`, name: "P23" },
    });
  }
  const doc = await withWorkspaceScope(WS_A, (tx) =>
    tx.univerDoc.create({
      data: { workspaceId: WS_A, kind: "doc", title: "Shared plan", snapshot: { body: { textRuns: [{ st: 0, ed: 5, ts: {} }] } } },
    }),
  );
  docId = doc.id;
  const template = await prisma.reportTemplate.create({
    data: { workspaceId: WS_A, name: "Monthly", type: "custom", content: {} },
  });
  const report = await prisma.report.create({
    data: { templateId: template.id, period: "2026-10", status: "ready", pdfPath: "local://reports/p23.pdf" },
  });
  reportId = report.id;
});

after(async () => {
  for (const ws of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id: ws } });
  await prisma.$disconnect();
});

describe("doc + report share links (DB)", () => {
  it("mint returns the token once; only its hash + hint persist", async () => {
    const { share, token } = await createDocShare({ workspaceId: WS_A, docId, userId: USER });
    assert.ok(token.startsWith(DOC_SHARE_TOKEN_PREFIX));
    const row = await withWorkspaceScope(WS_A, (tx) => tx.univerDocShare.findUnique({ where: { id: share.id } }));
    assert.equal(row!.tokenHash, hashShareToken(token));
    assert.equal(row!.tokenHint, token.slice(-4));
    assert.ok(!JSON.stringify(row).includes(token), "the raw token never persists");
  });

  it("a link cannot be minted for a doc outside the workspace", async () => {
    await assert.rejects(createDocShare({ workspaceId: WS_B, docId, userId: USER }), /DOC_NOT_FOUND/);
  });

  it("list is newest-first with no token material; revoke is immediate", async () => {
    const a = await createDocShare({ workspaceId: WS_A, docId, userId: USER, label: "first" });
    const b = await createDocShare({ workspaceId: WS_A, docId, userId: USER, label: "second" });
    const listed = await listDocShares(WS_A, docId);
    assert.equal(listed[0]!.label, "second");
    assert.ok(!JSON.stringify(listed).includes(a.token) && !JSON.stringify(listed).includes(b.token));
    await revokeDocShare(WS_A, docId, b.share.id, USER);
    const after = await listDocShares(WS_A, docId);
    assert.equal(after.find((s) => s.id === b.share.id)!.state, "revoked");
    assert.equal(await resolveDocShareToken(b.token), null, "revoked link stops resolving");
    assert.ok(await resolveDocShareToken(a.token), "the other link stays live");
  });

  it("expired and unknown tokens resolve null (no oracle)", async () => {
    const { token } = await createDocShare({ workspaceId: WS_A, docId, userId: USER, expiresInDays: 1 });
    const future = new Date(Date.now() + 2 * 86_400_000);
    assert.equal(await resolveDocShareToken(token, future), null, "expired link does not resolve");
    assert.equal(await resolveDocShareToken(`${DOC_SHARE_TOKEN_PREFIX}nope`), null);
    assert.equal(await resolveDocShareToken("not-a-token"), null);
  });

  it("the public doc lookup returns only the shared doc, under its own workspace scope", async () => {
    const { token } = await createDocShare({ workspaceId: WS_A, docId, userId: USER });
    const resolved = await resolveDocShareToken(token);
    assert.ok(resolved);
    assert.equal(resolved!.doc.id, docId);
    assert.equal(resolved!.doc.title, "Shared plan");
    assert.equal(resolved!.share.workspaceId, WS_A);
  });

  it("reports: only a ready/sent report is shareable; resolve returns the PDF pointer", async () => {
    const { share, token } = await createReportShare({ workspaceId: WS_A, reportId, userId: USER });
    assert.ok(token.startsWith(REPORT_SHARE_TOKEN_PREFIX));
    const resolved = await resolveReportShareToken(token);
    assert.equal(resolved!.report.id, reportId);
    assert.equal(resolved!.report.pdfPath, "local://reports/p23.pdf");
    const listed = await listReportShares(WS_A, reportId);
    assert.equal(listed[0]!.id, share.id);
    await revokeReportShare(WS_A, reportId, share.id, USER);
    assert.equal(await resolveReportShareToken(token), null, "revoked report link stops resolving");
  });

  it("reports: a failed report refuses a link", async () => {
    const template = await prisma.reportTemplate.create({
      data: { workspaceId: WS_A, name: "Broken", type: "custom", content: {} },
    });
    const failed = await prisma.report.create({
      data: { templateId: template.id, period: "2026-09", status: "failed", error: "boom" },
    });
    await assert.rejects(
      createReportShare({ workspaceId: WS_A, reportId: failed.id, userId: USER }),
      /REPORT_NOT_READY/,
    );
  });
});
