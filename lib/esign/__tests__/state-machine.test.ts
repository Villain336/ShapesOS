// ShapesOS — Phase 2 (F): e-sign state-machine integrity.
// Terminal states ignore later events, status is monotonic (webhooks AND
// refresh), completion + pipeline links fire once under concurrent
// duplicates, invalid signedAt is rejected before any write, an errored
// envelope can be re-sent or voided, and a double confirm creates one vendor
// envelope. Regression tests for the probes in the 2026-10-03 audit (§5).
// Run: npx tsx --test lib/esign/__tests__/state-machine.test.ts
//
// The fake DB returns SNAPSHOTS (like Prisma) and yields between calls, so
// Promise.all genuinely interleaves read → decide → write; updateMany is
// atomic per call, like a single UPDATE … WHERE in Postgres.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildSendToken,
  ingestDocumensoWebhook,
  refreshEnvelope,
  sendEnvelope,
  statusesBelow,
  voidEnvelope,
} from "../envelopes";
import { sweepExpirations } from "../agent";
import { sha256Hex } from "../audit";
import { onPipelineLink } from "../pipeline";
import type { EsignVendor } from "../vendor";

const ENV = { DOCUMENSO_WEBHOOK_SECRET: "wh-secret" };
const tick = () => new Promise<void>((r) => setImmediate(r));

function matchesWhere(row: any, where: any): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v instanceof Date) {
      if (!(row[k] instanceof Date) || row[k].getTime() !== v.getTime()) return false;
    } else if (v && typeof v === "object") {
      const c = v as { in?: unknown[]; notIn?: unknown[]; lt?: Date };
      if (c.in && !c.in.includes(row[k])) return false;
      if (c.notIn && c.notIn.includes(row[k])) return false;
      if (c.lt && !(row[k] instanceof Date && row[k].getTime() < c.lt.getTime())) return false;
    } else if (v === null ? row[k] != null : row[k] !== v) {
      return false;
    }
  }
  return true;
}

function snapshot(env: any) {
  return { ...env, signers: env.signers.map((s: any) => ({ ...s })), fields: env.fields.map((f: any) => ({ ...f })) };
}

let seq = 0;
function makeDb(seed: Record<string, unknown>) {
  const env: any = {
    id: `env_${++seq}`,
    workspaceId: "ws_1",
    title: "SOW — Acme",
    status: "sent",
    signingOrder: "sequential",
    vendorRef: `doc_${seq}`,
    vendorStatus: "PENDING",
    documentName: "sow.pdf",
    sourcePdf: Buffer.from([1, 2, 3]),
    sourcePdfHash: sha256Hex(new Uint8Array([1, 2, 3])),
    sealedPdf: null,
    sealedPdfHash: null,
    sealedPdfFetchedAt: null,
    contractType: "sow",
    contractRef: `sow_${seq}`,
    pipelineRef: null,
    expiresAt: null,
    voidReason: null,
    updatedAt: new Date(Date.now() - 1000),
    signers: [{ id: `sgn_${seq}`, email: "jane@acme.com", name: "Jane", role: "signer", orderIndex: 0, status: "pending", signedAt: null }],
    fields: [],
    ...seed,
  };
  const audit: any[] = [];
  const signerWrites: any[] = [];
  const db: any = {
    env,
    audit,
    signerWrites,
    esignEnvelope: {
      async findFirst({ where }: any) {
        await tick();
        if (where.id && where.id !== env.id) return null;
        if (where.vendorRef && where.vendorRef !== env.vendorRef) return null;
        return snapshot(env);
      },
      async findMany({ where }: any) {
        await tick();
        return matchesWhere(env, { workspaceId: where.workspaceId, status: where.status }) &&
          env.expiresAt && env.expiresAt < where.expiresAt.lt
          ? [snapshot(env)]
          : [];
      },
      async update({ data }: any) {
        await tick();
        Object.assign(env, data, { updatedAt: new Date() });
        return snapshot(env);
      },
      async updateMany({ where, data }: any) {
        await tick();
        if (!matchesWhere(env, where)) return { count: 0 };
        Object.assign(env, data, { updatedAt: new Date() });
        return { count: 1 };
      },
    },
    esignSigner: {
      async update({ where, data }: any) {
        await tick();
        signerWrites.push(data);
        const s = env.signers.find((x: any) => x.id === where.id);
        Object.assign(s, data);
        return { ...s };
      },
    },
    esignField: { async update() {} },
    esignAuditEvent: {
      async findFirst() {
        await tick();
        const last = audit[audit.length - 1];
        return last ? { hash: last.hash } : null;
      },
      async create({ data }: any) {
        await tick();
        if (audit.some((r) => r.bodyHash === data.bodyHash)) {
          const e = new Error("unique") as Error & { code: string };
          e.code = "P2002";
          throw e;
        }
        audit.push(data);
        return { id: `evt_${audit.length}`, ...data };
      },
    },
  };
  return db;
}

function makeVendor(overrides: Partial<Record<keyof EsignVendor, unknown>> = {}) {
  const calls: string[] = [];
  const vendor: any = {
    calls,
    name: "documenso",
    async createEnvelope() {
      calls.push("createEnvelope");
      await tick();
      return { vendorRef: `vdoc_${calls.length}`, vendorStatus: "DRAFT" };
    },
    async addSigners() {
      calls.push("addSigners");
    },
    async addFields() {
      calls.push("addFields");
    },
    async sendEnvelope() {
      calls.push("sendEnvelope");
    },
    async voidEnvelope(ref: string) {
      calls.push(`voidEnvelope:${ref}`);
    },
    async getStatus() {
      calls.push("getStatus");
      return { vendorStatus: "PENDING", envelopeStatus: "sent" };
    },
    async getSealedPdf() {
      calls.push("getSealedPdf");
      const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
      return { bytes, hash: sha256Hex(bytes) };
    },
    async listTemplates() {
      return [];
    },
    ...overrides,
  };
  return vendor as EsignVendor & { calls: string[] };
}

function hook(db: any, vendor: EsignVendor, event: string, recipients: unknown[] = [], createdAt = "2026-10-01T00:00:00Z") {
  return ingestDocumensoWebhook(db, vendor, {
    rawBody: JSON.stringify({ event, payload: { id: db.env.vendorRef, Recipient: recipients }, createdAt }),
    secretHeader: "wh-secret",
    env: ENV,
  });
}

const linkFires = (db: any) => db.audit.filter((a: any) => a.event === "pipeline_link_fired").length;

describe("terminal states ignore later events", () => {
  for (const status of ["voided", "declined", "expired"]) {
    it(`${status} + DOCUMENT_COMPLETED stays ${status}, fires nothing`, async () => {
      const db = makeDb({ status });
      const vendor = makeVendor();
      const res = await hook(db, vendor, "DOCUMENT_COMPLETED");
      assert.deepEqual(res, { ok: true, ignored: "terminal_state" });
      assert.equal(db.env.status, status);
      assert.equal(linkFires(db), 0, "no SOW→invoice-draft link for a dead envelope");
      assert.ok(!vendor.calls.includes("getSealedPdf"));
    });
  }

  it("a late signer event on a voided envelope writes no signer rows", async () => {
    const db = makeDb({ status: "voided" });
    await hook(db, makeVendor(), "DOCUMENT_SIGNED", [{ email: "jane@acme.com", signingStatus: "SIGNED" }]);
    assert.equal(db.signerWrites.length, 0);
    assert.equal(db.env.signers[0].status, "pending");
  });
});

describe("status is monotonic", () => {
  it("statusesBelow ranks draft/error < sending < sent < partially-signed < terminal", () => {
    assert.deepEqual(statusesBelow("sent").sort(), ["draft", "error", "sending"]);
    assert.ok(statusesBelow("completed").includes("partially-signed"));
    assert.ok(!statusesBelow("completed").includes("voided"));
    assert.deepEqual(statusesBelow("error"), []);
  });

  it("a late DOCUMENT_SENT never regresses partially-signed", async () => {
    const db = makeDb({ status: "partially-signed" });
    await hook(db, makeVendor(), "DOCUMENT_SENT");
    assert.equal(db.env.status, "partially-signed");
  });

  it("refresh never resurrects a locally voided envelope the vendor still reports as sent", async () => {
    const db = makeDb({ status: "voided" });
    await refreshEnvelope(db, makeVendor(), db.env.id);
    assert.equal(db.env.status, "voided");
  });

  it("refresh with an unknown vendor state never overwrites a live envelope", async () => {
    const db = makeDb({ status: "sent" });
    await refreshEnvelope(db, makeVendor({ getStatus: async () => ({ vendorStatus: "WEIRD", envelopeStatus: "error" }) }), db.env.id);
    assert.equal(db.env.status, "sent");
    assert.equal(db.env.vendorStatus, "WEIRD", "the vendor's raw status is still recorded");
  });

  it("refresh still moves a live envelope forward", async () => {
    const db = makeDb({ status: "sending" });
    await refreshEnvelope(db, makeVendor(), db.env.id);
    assert.equal(db.env.status, "sent");
  });
});

describe("completion + pipeline links fire once", () => {
  it("concurrent duplicate DOCUMENT_COMPLETED deliveries (distinct bodies) fire the link once", async () => {
    const db = makeDb({ status: "sent" });
    const vendor = makeVendor();
    const seen: string[] = [];
    const off = onPipelineLink((e) => {
      if (e.envelopeId === db.env.id) seen.push(e.kind);
    });
    try {
      const results = await Promise.all([
        hook(db, vendor, "DOCUMENT_COMPLETED", [], "2026-10-01T00:00:00Z"),
        hook(db, vendor, "DOCUMENT_COMPLETED", [], "2026-10-01T00:00:01Z"),
        hook(db, vendor, "DOCUMENT_COMPLETED", [], "2026-10-01T00:00:02Z"),
      ]);
      assert.ok(results.every((r) => r.ok));
    } finally {
      off();
    }
    assert.equal(db.env.status, "completed");
    assert.equal(linkFires(db), 1);
    assert.deepEqual(seen, ["sow_to_invoice_draft"]);
    assert.ok(db.env.sealedPdfHash, "sealed PDF stored");
  });

  it("a refresh that completes first means the webhook does not fire the link again", async () => {
    const db = makeDb({ status: "partially-signed" });
    const vendor = makeVendor({ getStatus: async () => ({ vendorStatus: "COMPLETED", envelopeStatus: "completed" }) });
    await refreshEnvelope(db, vendor, db.env.id);
    assert.equal(db.env.status, "completed");
    assert.equal(linkFires(db), 1);
    await hook(db, vendor, "DOCUMENT_COMPLETED");
    assert.equal(linkFires(db), 1);
  });

  it("the expiry sweep never expires an envelope that completed after the read", async () => {
    const db = makeDb({ status: "sent", expiresAt: new Date(Date.now() - 60_000) });
    const vendor = makeVendor();
    // The completion lands between the sweep's read and its write.
    const findMany = db.esignEnvelope.findMany;
    db.esignEnvelope.findMany = async (args: any) => {
      const rows = await findMany(args);
      await hook(db, vendor, "DOCUMENT_COMPLETED");
      return rows;
    };
    const swept = await sweepExpirations(db, { workspaceId: "ws_1", actor: "cron" });
    assert.equal(swept.expired, 0);
    assert.equal(db.env.status, "completed");
    assert.equal(linkFires(db), 1);
  });
});

describe("invalid signedAt is rejected before any write", () => {
  it("returns bad_payload (400, not retried) with no signer or status write", async () => {
    const db = makeDb({ status: "sent", signers: [
      { id: "s1", email: "a@x.com", name: "A", role: "signer", orderIndex: 0, status: "pending", signedAt: null },
      { id: "s2", email: "b@x.com", name: "B", role: "signer", orderIndex: 1, status: "pending", signedAt: null },
    ] });
    const res = await hook(db, makeVendor(), "DOCUMENT_SIGNED", [
      { email: "a@x.com", signingStatus: "SIGNED", signedAt: "2026-10-01T00:00:00Z" },
      { email: "b@x.com", signingStatus: "SIGNED", signedAt: "not-a-date" },
    ]);
    assert.deepEqual(res, { ok: false, reason: "bad_payload" });
    assert.equal(db.signerWrites.length, 0, "the valid signer was not half-applied either");
    assert.equal(db.env.status, "sent");
  });

  it("a valid signedAt is stored as given", async () => {
    const db = makeDb({ status: "sent" });
    await hook(db, makeVendor(), "DOCUMENT_SIGNED", [{ email: "jane@acme.com", signingStatus: "SIGNED", signedAt: "2026-09-30T12:00:00Z" }]);
    assert.equal(db.env.signers[0].signedAt.toISOString(), "2026-09-30T12:00:00.000Z");
  });
});

describe("send: claim, error recovery, double confirm", () => {
  const tokenFor = (env: any) =>
    buildSendToken({
      id: env.id,
      title: env.title,
      signerEmails: env.signers.map((s: any) => s.email),
      signingOrder: env.signingOrder,
      expiresAt: env.expiresAt,
      sourcePdfHash: env.sourcePdfHash,
    });

  it("two concurrent confirms with the same token create ONE vendor envelope", async () => {
    const db = makeDb({ status: "draft", vendorRef: null });
    const vendor = makeVendor();
    const token = tokenFor(db.env);
    const results = await Promise.allSettled([
      sendEnvelope(db, vendor, { envelopeId: db.env.id, token, actor: "user:1" }),
      sendEnvelope(db, vendor, { envelopeId: db.env.id, token, actor: "user:1" }),
    ]);
    assert.equal(vendor.calls.filter((c) => c === "createEnvelope").length, 1);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.equal(rejected.reason.code, "not_draft");
    assert.equal(db.env.status, "sent");
  });

  it("a failed send lands in error, voids the orphan vendor envelope, and can be re-sent", async () => {
    const db = makeDb({ status: "draft", vendorRef: null });
    let fail = true;
    const vendor = makeVendor({
      async sendEnvelope() {
        if (fail) throw new Error("vendor 503");
      },
    });
    const token = tokenFor(db.env);
    await assert.rejects(sendEnvelope(db, vendor, { envelopeId: db.env.id, token, actor: "user:1" }));
    assert.equal(db.env.status, "error");
    assert.ok(vendor.calls.some((c) => c.startsWith("voidEnvelope:vdoc_")), "orphan voided at the vendor");
    const failed = db.audit.find((a: any) => a.event === "send_failed");
    assert.equal(failed.payload.orphanVoided, true);

    fail = false;
    const sent = await sendEnvelope(db, vendor, { envelopeId: db.env.id, token, actor: "user:1" });
    assert.equal(sent.status, "sent");
    assert.ok(sent.vendorRef);
  });

  it("an errored envelope can be voided", async () => {
    const db = makeDb({ status: "error", vendorRef: null });
    const vendor = makeVendor();
    const res = await voidEnvelope(db, vendor, { envelopeId: db.env.id, reason: "abandon", actor: "user:1" });
    assert.equal(res.status, "voided");
  });

  it("a fresh 'sending' claim cannot be re-sent; a stale one can", async () => {
    const db = makeDb({ status: "sending", vendorRef: null, updatedAt: new Date() });
    const vendor = makeVendor();
    const token = tokenFor(db.env);
    await assert.rejects(
      sendEnvelope(db, vendor, { envelopeId: db.env.id, token, actor: "user:1" }),
      (e: any) => e.code === "not_draft",
    );
    db.env.updatedAt = new Date(Date.now() - 11 * 60 * 1000);
    const sent = await sendEnvelope(db, vendor, { envelopeId: db.env.id, token, actor: "user:1" });
    assert.equal(sent.status, "sent");
  });

  it("void never overwrites a completion that landed meanwhile", async () => {
    const db = makeDb({ status: "sent" });
    const vendor = makeVendor();
    const [voided] = await Promise.allSettled([
      voidEnvelope(db, vendor, { envelopeId: db.env.id, reason: "oops", actor: "user:1" }),
      hook(db, vendor, "DOCUMENT_COMPLETED"),
    ]);
    // Whichever wins, the loser does not overwrite it.
    if (db.env.status === "completed") {
      assert.equal(voided.status, "rejected");
      assert.equal(linkFires(db), 1);
    } else {
      assert.equal(db.env.status, "voided");
      assert.equal(linkFires(db), 0);
    }
  });
});
