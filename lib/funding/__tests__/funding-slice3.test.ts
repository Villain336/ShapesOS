// Marketr — Funding/VC slice 3 tests: data room versioning, share links,
// per-viewer analytics, tenant scoping.
// Run: npx tsx --test lib/funding/__tests__/funding-slice3.test.ts
//
// DB-backed tests run against the local dev DB and clean up their own test
// workspaces. The public token route's logic is covered through the pure
// resolveShareLink + the store methods the route calls.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../../prisma";
import { PrismaFundingStore } from "../prisma-store";
import { FundingError } from "../types";
import {
  DATA_ROOM_KIND_LABELS,
  generateShareToken,
  MAX_SHARE_EXPIRY_DAYS,
  normalizeViewerEmails,
  planNewDocVersion,
  resolveShareLink,
  validateDocInput,
  validateShareLinkInput,
  viewerIdentityFor,
  type ShareLinkForAccess,
} from "../dataroom";

const NOW = new Date(Date.UTC(2026, 9, 1, 12, 0, 0)); // 2026-10-01 12:00 UTC
const DAY_MS = 86_400_000;
const atDaysOut = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

const store = new PrismaFundingStore(prisma);
const testWorkspaceIds: string[] = [];

async function makeWorkspace(): Promise<string> {
  const ws = await prisma.workspace.create({
    data: {
      name: `test-funding-slice3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerUserId: "test-funding-slice3",
    },
  });
  testWorkspaceIds.push(ws.id);
  return ws.id;
}

const pdf = (tag: string) =>
  Buffer.from(`%PDF-1.4\n% data-room test ${tag}\n1 0 obj<</>>endobj\n`);

async function makeDoc(ws: string, tag: string, kind: "pitch_deck" = "pitch_deck") {
  return store.createDoc(ws, "founder@example.com", {
    title: `Deck ${tag}`,
    kind,
    fileName: `deck-${tag}.pdf`,
    fileBytes: pdf(tag),
    mimeType: "application/pdf",
  });
}

after(async () => {
  await prisma.workspace.deleteMany({
    where: { id: { in: testWorkspaceIds } },
  });
  await prisma.$disconnect();
});

// ------------------------------------------------------------------
// Pure domain.
// ------------------------------------------------------------------

describe("planNewDocVersion", () => {
  it("starts at version 1 with no supersedes for a new document", () => {
    assert.deepEqual(planNewDocVersion(null), {
      versionNumber: 1,
      supersedesVersionId: null,
    });
  });

  it("a new upload becomes version N+1 superseding the previous one", () => {
    assert.deepEqual(planNewDocVersion({ id: "v1", versionNumber: 1 }), {
      versionNumber: 2,
      supersedesVersionId: "v1",
    });
  });
});

describe("validateDocInput", () => {
  it("requires a title and a valid docType", () => {
    assert.ok(validateDocInput({ title: "", kind: "pitch_deck" }).length > 0);
    assert.ok(validateDocInput({ title: "x", kind: "not_a_kind" }).length > 0);
    assert.ok(validateDocInput({ title: "  Deck  ", kind: "metrics" }).length === 0);
  });

  it("rejects overlong notes", () => {
    assert.ok(
      validateDocInput({ title: "x", kind: "other", notes: "n".repeat(2001) })
        .length > 0,
    );
  });
});

describe("validateShareLinkInput", () => {
  it("rejects past and far-future expiry", () => {
    assert.ok(
      validateShareLinkInput(
        { expiresAt: new Date(NOW.getTime() - 1000).toISOString() },
        NOW,
      ).length > 0,
    );
    assert.ok(
      validateShareLinkInput(
        { expiresAt: atDaysOut(MAX_SHARE_EXPIRY_DAYS + 1).toISOString() },
        NOW,
      ).length > 0,
    );
    assert.equal(
      validateShareLinkInput(
        { expiresAt: atDaysOut(14).toISOString() },
        NOW,
      ).length,
      0,
    );
  });

  it("rejects bad viewer emails and docVersionId without a doc", () => {
    assert.ok(
      validateShareLinkInput({ viewerEmails: ["not-an-email"] }, NOW).length > 0,
    );
    assert.ok(
      validateShareLinkInput(
        { docId: null, docVersionId: "v1" },
        NOW,
      ).length > 0,
    );
    assert.equal(
      validateShareLinkInput(
        { viewerEmails: ["a@b.com"], expiresAt: atDaysOut(7).toISOString() },
        NOW,
      ).length,
      0,
    );
  });
});

describe("generateShareToken", () => {
  it("is unguessable: fsr_ prefix + 128 bits, unique", () => {
    const tokens = new Set(Array.from({ length: 100 }, generateShareToken));
    assert.equal(tokens.size, 100);
    for (const t of tokens) {
      assert.match(t, /^fsr_[0-9a-f]{32}$/);
    }
  });
});

describe("viewerIdentityFor", () => {
  it("uses the email when provided, else a stable fingerprint", () => {
    assert.equal(
      viewerIdentityFor({ email: " vc@firm.com " }),
      "vc@firm.com",
    );
    const a = viewerIdentityFor({ ip: "1.2.3.4", userAgent: "ua" });
    const b = viewerIdentityFor({ ip: "1.2.3.4", userAgent: "ua" });
    const c = viewerIdentityFor({ ip: "9.9.9.9", userAgent: "ua" });
    assert.match(a, /^fp:[0-9a-f]{16}$/);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe("normalizeViewerEmails", () => {
  it("trims, lowercases, dedupes", () => {
    assert.deepEqual(
      normalizeViewerEmails([" A@B.com ", "a@b.com", "c@d.com", ""]),
      ["a@b.com", "c@d.com"],
    );
  });
});

describe("resolveShareLink", () => {
  const open: ShareLinkForAccess = {
    revoked: false,
    expiresAt: null,
    viewerEmails: [],
  };

  it("serves open links", () => {
    assert.deepEqual(resolveShareLink(open, {}, NOW), { ok: true });
  });

  it("revoked and expired links fail closed", () => {
    assert.deepEqual(
      resolveShareLink({ ...open, revoked: true }, {}, NOW),
      { ok: false, failure: "link_revoked" },
    );
    assert.deepEqual(
      resolveShareLink(
        { ...open, expiresAt: new Date(NOW.getTime() - 1) },
        {},
        NOW,
      ),
      { ok: false, failure: "link_expired" },
    );
    // Boundary: exactly at expiry is expired.
    assert.deepEqual(
      resolveShareLink({ ...open, expiresAt: NOW }, {}, NOW),
      { ok: false, failure: "link_expired" },
    );
  });

  it("allowlisted links require a matching email (case-insensitive)", () => {
    const gated: ShareLinkForAccess = {
      ...open,
      viewerEmails: ["Partner@Firm.com"],
    };
    assert.deepEqual(resolveShareLink(gated, {}, NOW), {
      ok: false,
      failure: "email_required",
    });
    assert.deepEqual(resolveShareLink(gated, { email: "stranger@x.com" }, NOW), {
      ok: false,
      failure: "email_not_allowlisted",
    });
    assert.deepEqual(resolveShareLink(gated, { email: "partner@firm.COM" }, NOW), {
      ok: true,
    });
  });

  it("a revoked allowlisted link fails on revocation first", () => {
    assert.deepEqual(
      resolveShareLink(
        { ...open, revoked: true, viewerEmails: ["a@b.com"] },
        {},
        NOW,
      ),
      { ok: false, failure: "link_revoked" },
    );
  });
});

describe("doc kinds", () => {
  it("has labels for the spec's docTypes", () => {
    assert.deepEqual(Object.keys(DATA_ROOM_KIND_LABELS).sort(), [
      "financials",
      "metrics",
      "other",
      "pitch_deck",
    ]);
  });
});

// ------------------------------------------------------------------
// Store: versioning.
// ------------------------------------------------------------------

describe("document versioning", () => {
  it("createDoc starts at version 1 with the file under /files/funding/", async () => {
    const ws = await makeWorkspace();
    const doc = await makeDoc(ws, "v1");
    assert.equal(doc.title, "Deck v1");
    assert.equal(doc.kind, "pitch_deck");
    assert.equal(doc.versionCount, 1);
    assert.ok(doc.currentVersion);
    assert.equal(doc.currentVersion.versionNumber, 1);
    assert.equal(doc.currentVersion.isCurrent, true);
    assert.equal(doc.currentVersion.uploadedBy, "founder@example.com");

    const versionRow = await prisma.fundingDataRoomDocVersion.findFirstOrThrow({
      where: { documentId: doc.id },
      select: { workspaceFileId: true },
    });
    const wf = await prisma.workspaceFile.findUniqueOrThrow({
      where: { id: versionRow.workspaceFileId },
      select: { logicalPath: true },
    });
    assert.ok(wf.logicalPath.startsWith("/files/funding/pitch_deck/"));
    assert.ok(wf.logicalPath.includes("v1-"));
  });

  it("a new upload NEVER mutates a published version — v1 row is byte-identical after v2", async () => {
    const ws = await makeWorkspace();
    const created = await makeDoc(ws, "immutable");
    const v1 = created.currentVersion!;
    const v1Snapshot = { ...v1 };

    const updated = await store.addDocVersion(ws, "founder@example.com", created.id, {
      fileName: "deck-immutable-v2.pdf",
      fileBytes: pdf("immutable-v2"),
      mimeType: "application/pdf",
    });
    assert.equal(updated.versionCount, 2);
    assert.equal(updated.currentVersion!.versionNumber, 2);
    assert.equal(updated.currentVersion!.supersedesVersionId, v1.id);
    assert.notEqual(updated.currentVersion!.id, v1.id);

    // v1 row re-read from the DB: unchanged.
    const v1Reread = await prisma.fundingDataRoomDocVersion.findUniqueOrThrow({
      where: { id: v1.id },
    });
    assert.equal(v1Reread.versionNumber, 1);
    assert.equal(v1Reread.fileName, v1Snapshot.fileName);
    assert.equal(v1Reread.sizeBytes, v1Snapshot.sizeBytes);
    assert.equal(v1Reread.supersedesVersionId, null);

    // The legacy flat fields moved forward with the doc.
    const docRow = await prisma.fundingDataRoomDoc.findUniqueOrThrow({
      where: { id: created.id },
    });
    assert.equal(docRow.version, 2);
    assert.equal(docRow.currentVersionId, updated.currentVersion!.id);
  });

  it("three uploads keep the full chain: v3 → v2 → v1", async () => {
    const ws = await makeWorkspace();
    const created = await makeDoc(ws, "chain");
    await store.addDocVersion(ws, "founder@example.com", created.id, {
      fileName: "chain-v2.pdf",
      fileBytes: pdf("chain-v2"),
    });
    const after3 = await store.addDocVersion(ws, "founder@example.com", created.id, {
      fileName: "chain-v3.pdf",
      fileBytes: pdf("chain-v3"),
    });
    assert.equal(after3.currentVersion!.versionNumber, 3);
    const detail = await store.getDocDetail(ws, created.id);
    assert.equal(detail.versions.length, 3);
    assert.deepEqual(
      detail.versions.map((v) => v.versionNumber),
      [3, 2, 1],
    );
    assert.equal(detail.versions[0].isCurrent, true);
    assert.equal(detail.versions[1].isCurrent, false);
    assert.equal(
      detail.versions[0].supersedesVersionId,
      detail.versions[1].id,
    );
    assert.equal(
      detail.versions[1].supersedesVersionId,
      detail.versions[2].id,
    );
  });

  it("validates doc input and rejects empty uploads", async () => {
    const ws = await makeWorkspace();
    await assert.rejects(
      () =>
        store.createDoc(ws, "u", {
          title: "",
          kind: "pitch_deck",
          fileName: "x.pdf",
          fileBytes: pdf("x"),
        }),
      (e: unknown) => e instanceof FundingError && e.code === "INVALID_DOC",
    );
    await assert.rejects(
      () =>
        store.createDoc(ws, "u", {
          title: "x",
          kind: "nope" as "pitch_deck",
          fileName: "x.pdf",
          fileBytes: pdf("x"),
        }),
      (e: unknown) => e instanceof FundingError && e.code === "INVALID_DOC",
    );
    await assert.rejects(
      () =>
        store.createDoc(ws, "u", {
          title: "x",
          kind: "pitch_deck",
          fileName: "x.pdf",
          fileBytes: Buffer.alloc(0),
        }),
      (e: unknown) => e instanceof FundingError && e.code === "EMPTY_FILE",
    );
  });

  it("a version upload to another tenant's doc 404s", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    const doc = await makeDoc(wsA, "tenant");
    await assert.rejects(
      () =>
        store.addDocVersion(wsB, "u", doc.id, {
          fileName: "x.pdf",
          fileBytes: pdf("x"),
        }),
      (e: unknown) => e instanceof FundingError && e.code === "DOC_NOT_FOUND",
    );
  });
});

// ------------------------------------------------------------------
// Store: share links.
// ------------------------------------------------------------------

describe("share links", () => {
  it("creates doc links (pinned + current-at-access) and whole-room links", async () => {
    const ws = await makeWorkspace();
    const doc = await makeDoc(ws, "share");
    const v1 = doc.currentVersion!;

    const pinned = await store.createShareLink(ws, {
      docId: doc.id,
      docVersionId: v1.id,
      expiresAt: atDaysOut(14).toISOString(),
      viewerEmails: ["VC@firm.com"],
    });
    assert.match(pinned.urlPath, /^\/r\/funding\/fsr_[0-9a-f]{32}$/);
    assert.equal(pinned.docId, doc.id);
    assert.equal(pinned.docVersionId, v1.id);
    assert.equal(pinned.pinnedVersionNumber, 1);
    assert.deepEqual(pinned.viewerEmails, ["vc@firm.com"]);
    assert.equal(pinned.revoked, false);
    assert.equal(pinned.expired, false);

    const room = await store.createShareLink(ws, {
      docId: null,
      docVersionId: null,
      expiresAt: null,
      viewerEmails: [],
    });
    assert.equal(room.docId, null);
    assert.equal(room.docTitle, null);

    // Pinned version resolves through the token lookup.
    const byToken = await store.getShareLinkByToken(
      pinned.urlPath.split("/").pop()!,
    );
    assert.ok(byToken);
    assert.equal(byToken.docId, doc.id);
    assert.equal(byToken.resolvedVersion?.id, v1.id);

    // Unpinned resolves to the CURRENT version at access time.
    const floating = await store.createShareLink(ws, {
      docId: doc.id,
      docVersionId: null,
      expiresAt: null,
      viewerEmails: [],
    });
    await store.addDocVersion(ws, "u", doc.id, {
      fileName: "share-v2.pdf",
      fileBytes: pdf("share-v2"),
    });
    const byToken2 = await store.getShareLinkByToken(
      floating.urlPath.split("/").pop()!,
    );
    assert.equal(byToken2?.resolvedVersion?.versionNumber, 2);
    // The pinned link still resolves to v1.
    const byToken3 = await store.getShareLinkByToken(
      pinned.urlPath.split("/").pop()!,
    );
    assert.equal(byToken3?.resolvedVersion?.versionNumber, 1);
  });

  it("rejects a pinned version on a whole-room link", async () => {
    const ws = await makeWorkspace();
    await assert.rejects(
      () =>
        store.createShareLink(ws, {
          docId: null,
          docVersionId: "v1",
          expiresAt: null,
          viewerEmails: [],
        }),
      (e: unknown) =>
        e instanceof FundingError && e.code === "INVALID_SHARE_LINK",
    );
  });

  it("rejects links to another tenant's doc or a mismatched version", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    const docA = await makeDoc(wsA, "cross");
    await assert.rejects(
      () =>
        store.createShareLink(wsB, {
          docId: docA.id,
          docVersionId: null,
          expiresAt: null,
          viewerEmails: [],
        }),
      (e: unknown) => e instanceof FundingError && e.code === "DOC_NOT_FOUND",
    );
    await assert.rejects(
      () =>
        store.createShareLink(wsA, {
          docId: docA.id,
          docVersionId: "cmadeup000000000000000000",
          expiresAt: null,
          viewerEmails: [],
        }),
      (e: unknown) =>
        e instanceof FundingError && e.code === "VERSION_NOT_FOUND",
    );
  });

  it("revocation sticks and fails closed at access time", async () => {
    const ws = await makeWorkspace();
    const doc = await makeDoc(ws, "revoke");
    const link = await store.createShareLink(ws, {
      docId: doc.id,
      docVersionId: null,
      expiresAt: null,
      viewerEmails: [],
    });
    const revoked = await store.revokeShareLink(ws, link.id);
    assert.equal(revoked.revoked, true);
    assert.ok(revoked.expired === false);

    // Access-time enforcement sees the revocation.
    const byToken = await store.getShareLinkByToken(
      link.urlPath.split("/").pop()!,
    );
    assert.ok(byToken);
    assert.deepEqual(
      resolveShareLink(
        {
          revoked: byToken.revoked,
          expiresAt: byToken.expiresAt,
          viewerEmails: byToken.viewerEmails,
        },
        {},
        NOW,
      ),
      { ok: false, failure: "link_revoked" },
    );

    // Revoking twice is idempotent.
    const again = await store.revokeShareLink(ws, link.id);
    assert.equal(again.revoked, true);

    await assert.rejects(
      () => store.revokeShareLink(ws, "cmadeup000000000000000000"),
      (e: unknown) => e instanceof FundingError && e.code === "LINK_NOT_FOUND",
    );
  });

  it("an expired link fails closed at access time (expiry enforced on read)", async () => {
    const ws = await makeWorkspace();
    const doc = await makeDoc(ws, "expiry");
    const link = await store.createShareLink(ws, {
      docId: doc.id,
      docVersionId: null,
      expiresAt: atDaysOut(30).toISOString(),
      viewerEmails: [],
    });
    // Simulate time passing: the row expired after creation.
    await prisma.fundingShareLink.update({
      where: { id: link.id },
      data: { expiresAt: new Date(NOW.getTime() - DAY_MS) },
    });
    const byToken = await store.getShareLinkByToken(
      link.urlPath.split("/").pop()!,
    );
    assert.ok(byToken);
    assert.deepEqual(
      resolveShareLink(
        {
          revoked: byToken.revoked,
          expiresAt: byToken.expiresAt,
          viewerEmails: byToken.viewerEmails,
        },
        {},
        NOW,
      ),
      { ok: false, failure: "link_expired" },
    );
  });
});

// ------------------------------------------------------------------
// Store: view analytics.
// ------------------------------------------------------------------

describe("view analytics", () => {
  it("logs who opened what, when — and records optional duration", async () => {
    const ws = await makeWorkspace();
    const doc = await makeDoc(ws, "views");
    const link = await store.createShareLink(ws, {
      docId: doc.id,
      docVersionId: null,
      expiresAt: null,
      viewerEmails: [],
    });
    const view = await store.recordDocView(ws, {
      linkId: link.id,
      docVersionId: doc.currentVersion!.id,
      viewerIdentity: "partner@firm.com",
      userAgent: "TestAgent/1.0",
    });
    assert.ok(view.id);

    await store.recordDocView(ws, {
      linkId: link.id,
      docVersionId: doc.currentVersion!.id,
      viewerIdentity: "fp:abcdef1234567890",
    });

    await store.updateViewDuration(ws, view.id, 42_000);

    const rows = await store.listViews(ws, { docId: doc.id });
    assert.equal(rows.length, 2);
    const mine = rows.find((r) => r.viewerIdentity === "partner@firm.com")!;
    assert.equal(mine.docTitle, "Deck views");
    assert.equal(mine.docVersionNumber, 1);
    assert.equal(mine.userAgent, "TestAgent/1.0");
    assert.equal(mine.durationMs, 42_000);
    assert.ok(mine.openedAt instanceof Date);
    const anon = rows.find((r) => r.viewerIdentity === "fp:abcdef1234567890")!;
    assert.equal(anon.durationMs, null);

    // Link filter narrows it down.
    const byLink = await store.listViews(ws, { linkId: link.id });
    assert.equal(byLink.length, 2);

    await assert.rejects(
      () => store.updateViewDuration(ws, view.id, -5),
      (e: unknown) =>
        e instanceof FundingError && e.code === "INVALID_DURATION",
    );
  });

  it("view counts roll up onto docs and links", async () => {
    const ws = await makeWorkspace();
    const doc = await makeDoc(ws, "rollup");
    const link = await store.createShareLink(ws, {
      docId: doc.id,
      docVersionId: null,
      expiresAt: null,
      viewerEmails: [],
    });
    await store.recordDocView(ws, {
      linkId: link.id,
      docVersionId: doc.currentVersion!.id,
      viewerIdentity: "a@b.com",
    });
    const docs = await store.listDocs(ws);
    assert.equal(docs[0].viewCount, 1);
    assert.equal(docs[0].shareLinkCount, 1);
    const links = await store.listShareLinks(ws);
    assert.equal(links[0].viewCount, 1);
  });

  it("analytics are tenant-scoped", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    const doc = await makeDoc(wsA, "scoped");
    const link = await store.createShareLink(wsA, {
      docId: doc.id,
      docVersionId: null,
      expiresAt: null,
      viewerEmails: [],
    });
    await store.recordDocView(wsA, {
      linkId: link.id,
      docVersionId: doc.currentVersion!.id,
      viewerIdentity: "a@b.com",
    });

    assert.deepEqual(await store.listDocs(wsB), []);
    assert.deepEqual(await store.listShareLinks(wsB), []);
    assert.deepEqual(await store.listViews(wsB), []);
    await assert.rejects(
      () => store.getDoc(wsB, doc.id),
      (e: unknown) => e instanceof FundingError && e.code === "DOC_NOT_FOUND",
    );
  });
});

describe("deleteDoc", () => {
  it("removes the doc, its versions, links, and views", async () => {
    const ws = await makeWorkspace();
    const doc = await makeDoc(ws, "delete");
    const link = await store.createShareLink(ws, {
      docId: doc.id,
      docVersionId: null,
      expiresAt: null,
      viewerEmails: [],
    });
    await store.recordDocView(ws, {
      linkId: link.id,
      docVersionId: doc.currentVersion!.id,
      viewerIdentity: "a@b.com",
    });
    await store.deleteDoc(ws, doc.id);
    assert.deepEqual(await store.listDocs(ws), []);
    assert.deepEqual(await store.listShareLinks(ws), []);
    assert.deepEqual(await store.listViews(ws), []);
    await assert.rejects(
      () => store.deleteDoc(ws, doc.id),
      (e: unknown) => e instanceof FundingError && e.code === "DOC_NOT_FOUND",
    );
  });
});
