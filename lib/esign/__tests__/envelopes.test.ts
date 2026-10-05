// Marketr — E-sign module tests (slice 2): governed actions + webhook ingestion.
// Run: npx tsx --test lib/esign/__tests__/envelopes.test.ts
// Fake in-memory DB and vendor — no live services, no real database.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildSendToken,
  createEnvelopeDraft,
  EsignGateError,
  ingestDocumensoWebhook,
  sendEnvelope,
  validateDraftInput,
  voidEnvelope,
  type CreateDraftInput,
} from "../envelopes";
import { sha256Hex } from "../audit";
import { onPipelineLink, type PipelineLinkEvent } from "../pipeline";
import type { EsignVendor } from "../vendor";

const WEBHOOK_ENV = { DOCUMENSO_WEBHOOK_SECRET: "wh-secret" };

// ------------------------------------------------------------- fakes ---


// Minimal Prisma `where` matcher for the fake updateMany (equality, Date
// equality, null, { in }, { notIn }) — the guarded writes the module uses.
function matchesWhere(row: any, where: any): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v instanceof Date) {
      if (!(row[k] instanceof Date) || row[k].getTime() !== v.getTime()) return false;
    } else if (v && typeof v === "object") {
      const c = v as { in?: unknown[]; notIn?: unknown[] };
      if (c.in && !c.in.includes(row[k])) return false;
      if (c.notIn && c.notIn.includes(row[k])) return false;
    } else if (v === null ? row[k] != null : row[k] !== v) {
      return false;
    }
  }
  return true;
}

function makeFakeDb() {
  const envelopes = new Map<string, any>();
  const auditRows: any[] = [];
  let seq = 0;
  const db = {
    envelopes,
    auditRows,
    esignEnvelope: {
      async create({ data }: any) {
        const id = `env_${++seq}`;
        const env: any = {
          id,
          workspaceId: data.workspaceId,
          title: data.title,
          status: data.status ?? "draft",
          signingOrder: data.signingOrder ?? "sequential",
          vendor: "documenso",
          vendorRef: null,
          vendorStatus: null,
          documentName: data.documentName ?? null,
          documentSize: data.documentSize ?? null,
          sourcePdf: data.sourcePdf ?? null,
          sourcePdfHash: data.sourcePdfHash ?? null,
          sealedPdf: null,
          sealedPdfHash: null,
          sealedPdfFetchedAt: null,
          contractType: data.contractType ?? null,
          contractRef: data.contractRef ?? null,
          pipelineRef: null,
          templateId: data.templateId ?? null,
          expiresAt: data.expiresAt ?? null,
          voidReason: null,
          createdBy: data.createdBy ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
          signers: [],
          fields: [],
        };
        for (const s of data.signers?.create ?? []) {
          env.signers.push({
            id: `sgn_${++seq}`,
            envelopeId: id,
            signedAt: null,
            identityEvidence: null,
            ...s,
          });
        }
        for (const f of data.fields?.create ?? []) {
          env.fields.push({ id: `fld_${++seq}`, envelopeId: id, signerId: null, value: null, ...f });
        }
        envelopes.set(id, env);
        return env;
      },
      async findFirst({ where }: any) {
        for (const env of envelopes.values()) {
          if (where.id && env.id !== where.id) continue;
          if (where.workspaceId && env.workspaceId !== where.workspaceId) continue;
          if (where.vendorRef && env.vendorRef !== where.vendorRef) continue;
          return env;
        }
        return null;
      },
      async update({ where, data }: any) {
        const env = envelopes.get(where.id);
        if (!env) throw new Error("envelope not found");
        Object.assign(env, data, { updatedAt: new Date() });
        return env;
      },
      async updateMany({ where, data }: any) {
        let count = 0;
        for (const env of envelopes.values()) {
          if (!matchesWhere(env, where)) continue;
          Object.assign(env, data, { updatedAt: new Date() });
          count++;
        }
        return { count };
      },
    },
    esignSigner: {
      async update({ where, data }: any) {
        for (const env of envelopes.values()) {
          const s = env.signers.find((x: any) => x.id === where.id);
          if (s) {
            Object.assign(s, data);
            return s;
          }
        }
        throw new Error("signer not found");
      },
    },
    esignField: {
      async update({ where, data }: any) {
        for (const env of envelopes.values()) {
          const f = env.fields.find((x: any) => x.id === where.id);
          if (f) {
            Object.assign(f, data);
            return f;
          }
        }
        throw new Error("field not found");
      },
    },
    esignAuditEvent: {
      async findFirst({ where }: any) {
        const rows = auditRows.filter((r) => r.envelopeId === where.envelopeId);
        const last = rows[rows.length - 1];
        return last ? { hash: last.hash } : null;
      },
      async create({ data }: any) {
        if (auditRows.some((r) => r.bodyHash === data.bodyHash)) {
          const e = new Error("unique") as Error & { code: string };
          e.code = "P2002";
          throw e;
        }
        const row = { id: `evt_${++seq}`, ...data };
        auditRows.push(row);
        return row;
      },
    },
  };
  return db as any;
}

function makeFakeVendor(overrides: Record<string, unknown> = {}): EsignVendor & { calls: string[] } {
  const calls: string[] = [];
  const vendor = {
    calls,
    name: "documenso" as const,
    async createEnvelope() {
      calls.push("createEnvelope");
      return { vendorRef: "doc_1", vendorStatus: "DRAFT" };
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
    async voidEnvelope() {
      calls.push("voidEnvelope");
    },
    async getStatus() {
      calls.push("getStatus");
      return { vendorStatus: "PENDING", envelopeStatus: "sent" as const };
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
  return vendor;
}

function draftInput(overrides: Partial<CreateDraftInput> = {}): CreateDraftInput {
  return {
    workspaceId: "ws_1",
    title: "MSA — Acme",
    signers: [{ name: "Jane", email: "jane@acme.com" }],
    pdfBytes: new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

function webhookBody(event: string, docId: string, recipients: unknown[] = []) {
  return JSON.stringify({
    event,
    payload: { id: docId, title: "MSA — Acme", Recipient: recipients },
    createdAt: "2026-10-01T00:00:00Z",
  });
}

// ---------------------------------------------------------- validation ---

describe("validateDraftInput", () => {
  it("accepts a valid draft", () => {
    validateDraftInput(draftInput());
  });

  it("rejects bad input with named errors", () => {
    assert.throws(() => validateDraftInput(draftInput({ title: "  " })), EsignGateError);
    assert.throws(() => validateDraftInput(draftInput({ signers: [] })), EsignGateError);
    assert.throws(
      () => validateDraftInput(draftInput({ signers: [{ name: "X", email: "nope" }] })),
      EsignGateError,
    );
    assert.throws(
      () =>
        validateDraftInput(
          draftInput({
            signers: [
              { name: "A", email: "a@x.com" },
              { name: "B", email: "A@x.com" },
            ],
          }),
        ),
      EsignGateError,
    );
    assert.throws(
      () =>
        validateDraftInput(
          draftInput({ fields: [{ signerEmail: "ghost@x.com", fieldType: "signature" }] }),
        ),
      EsignGateError,
    );
    assert.throws(() => validateDraftInput(draftInput({ pdfBytes: new Uint8Array(0) })), EsignGateError);
    assert.throws(
      () => validateDraftInput(draftInput({ expiresAt: new Date("2020-01-01") })),
      EsignGateError,
    );
  });
});

// ---------------------------------------------------------- send token ---

describe("buildSendToken", () => {
  const basis = {
    id: "env_1",
    title: "MSA",
    signerEmails: ["jane@acme.com"],
    signingOrder: "sequential",
    expiresAt: null,
    sourcePdfHash: "abc",
  };

  it("is deterministic and binds every reviewed field", () => {
    const t1 = buildSendToken(basis);
    assert.equal(t1, buildSendToken(basis));
    assert.notEqual(t1, buildSendToken({ ...basis, title: "MSA v2" }));
    assert.notEqual(t1, buildSendToken({ ...basis, signerEmails: ["jane@acme.com", "b@x.com"] }));
    assert.notEqual(t1, buildSendToken({ ...basis, sourcePdfHash: "changed" }));
    assert.notEqual(t1, buildSendToken({ ...basis, signingOrder: "parallel" }));
  });

  it("is insensitive to signer order and email case", () => {
    const t1 = buildSendToken({ ...basis, signerEmails: ["a@x.com", "b@x.com"] });
    const t2 = buildSendToken({ ...basis, signerEmails: ["B@x.com", "A@x.com"] });
    assert.equal(t1, t2);
  });
});

// ------------------------------------------------------------ send gate ---

describe("sendEnvelope (heavy gate)", () => {
  it("creates the draft locally with signers, fields, and a created audit row", async () => {
    const db = makeFakeDb();
    const env = await createEnvelopeDraft(
      db,
      draftInput({
        fields: [{ signerEmail: "jane@acme.com", fieldType: "signature" }],
      }),
    );
    assert.equal(env.status, "draft");
    assert.equal(env.signers.length, 1);
    assert.equal(env.fields.length, 1);
    assert.equal(env.fields[0].signerId, env.signers[0].id);
    assert.equal(db.auditRows.length, 1);
    assert.equal(db.auditRows[0].event, "created");
  });

  it("refuses to send without a token, with a stale token, or twice", async () => {
    const db = makeFakeDb();
    const vendor = makeFakeVendor();
    const env = await createEnvelopeDraft(db, draftInput());
    const token = buildSendToken({
      id: env.id,
      title: env.title,
      signerEmails: env.signers.map((s: any) => s.email),
      signingOrder: env.signingOrder,
      expiresAt: env.expiresAt,
      sourcePdfHash: env.sourcePdfHash,
    });

    await assert.rejects(
      sendEnvelope(db, vendor, { envelopeId: env.id, token: "", actor: "user:u1" }),
      (e: unknown) => e instanceof EsignGateError && e.code === "missing_token",
    );
    await assert.rejects(
      sendEnvelope(db, vendor, { envelopeId: env.id, token: "stale", actor: "user:u1" }),
      (e: unknown) => e instanceof EsignGateError && e.code === "stale_token",
    );
    assert.deepEqual(vendor.calls, [], "no vendor call before a valid approval");

    const sent = await sendEnvelope(db, vendor, { envelopeId: env.id, token, actor: "user:u1" });
    assert.equal(sent.status, "sent");
    assert.deepEqual(vendor.calls, ["createEnvelope", "addSigners", "sendEnvelope"]);

    await assert.rejects(
      sendEnvelope(db, vendor, { envelopeId: env.id, token, actor: "user:u1" }),
      (e: unknown) => e instanceof EsignGateError && e.code === "not_draft",
    );
  });

  it("invalidates the token when the draft changes after preview", async () => {
    const db = makeFakeDb();
    const vendor = makeFakeVendor();
    const env = await createEnvelopeDraft(db, draftInput());
    const token = buildSendToken({
      id: env.id,
      title: env.title,
      signerEmails: env.signers.map((s: any) => s.email),
      signingOrder: env.signingOrder,
      expiresAt: env.expiresAt,
      sourcePdfHash: env.sourcePdfHash,
    });
    // The draft changes after the human reviewed it.
    await db.esignEnvelope.update({ where: { id: env.id }, data: { title: "MSA — Acme v2" } });
    await assert.rejects(
      sendEnvelope(db, vendor, { envelopeId: env.id, token, actor: "user:u1" }),
      (e: unknown) => e instanceof EsignGateError && e.code === "stale_token",
    );
    assert.deepEqual(vendor.calls, [], "changed draft is never sent on a stale approval");
  });

  it("scopes sends to the workspace", async () => {
    const db = makeFakeDb();
    const vendor = makeFakeVendor();
    const env = await createEnvelopeDraft(db, draftInput({ workspaceId: "ws_1" }));
    const token = buildSendToken({
      id: env.id,
      title: env.title,
      signerEmails: env.signers.map((s: any) => s.email),
      signingOrder: env.signingOrder,
      expiresAt: env.expiresAt,
      sourcePdfHash: env.sourcePdfHash,
    });
    await assert.rejects(
      sendEnvelope(db, vendor, { envelopeId: env.id, token, actor: "user:u1", workspaceId: "ws_2" }),
      (e: unknown) => e instanceof EsignGateError && e.code === "unknown_envelope",
    );
    assert.deepEqual(vendor.calls, [], "cross-workspace send never reaches the vendor");
  });
});

// ------------------------------------------------------------------ void ---

describe("voidEnvelope", () => {
  it("requires a reason and a voidable status", async () => {
    const db = makeFakeDb();
    const vendor = makeFakeVendor();
    const env = await createEnvelopeDraft(db, draftInput());

    await assert.rejects(
      voidEnvelope(db, vendor, { envelopeId: env.id, reason: "  ", actor: "user:u1" }),
      (e: unknown) => e instanceof EsignGateError && e.code === "missing_reason",
    );

    const voided = await voidEnvelope(db, vendor, {
      envelopeId: env.id,
      reason: "wrong template",
      actor: "user:u1",
    });
    assert.equal(voided.status, "voided");
    assert.equal(voided.voidReason, "wrong template");
    assert.deepEqual(vendor.calls, [], "draft never touched the vendor — no vendor call");

    await assert.rejects(
      voidEnvelope(db, vendor, { envelopeId: env.id, reason: "again", actor: "user:u1" }),
      (e: unknown) => e instanceof EsignGateError && e.code === "not_voidable",
    );
  });

  it("calls the vendor when the envelope was sent", async () => {
    const db = makeFakeDb();
    const vendor = makeFakeVendor();
    const env = await createEnvelopeDraft(db, draftInput());
    const token = buildSendToken({
      id: env.id,
      title: env.title,
      signerEmails: env.signers.map((s: any) => s.email),
      signingOrder: env.signingOrder,
      expiresAt: env.expiresAt,
      sourcePdfHash: env.sourcePdfHash,
    });
    await sendEnvelope(db, vendor, { envelopeId: env.id, token, actor: "user:u1" });
    await voidEnvelope(db, vendor, { envelopeId: env.id, reason: "deal fell through", actor: "user:u1" });
    assert.ok(vendor.calls.includes("voidEnvelope"));
    const row = await db.esignEnvelope.findFirst({ where: { id: env.id } });
    assert.equal(row.status, "voided");
  });
});

// -------------------------------------------------------------- webhook ---

describe("ingestDocumensoWebhook", () => {
  async function sentEnvelope() {
    const db = makeFakeDb();
    const vendor = makeFakeVendor();
    const env = await createEnvelopeDraft(db, draftInput());
    const token = buildSendToken({
      id: env.id,
      title: env.title,
      signerEmails: env.signers.map((s: any) => s.email),
      signingOrder: env.signingOrder,
      expiresAt: env.expiresAt,
      sourcePdfHash: env.sourcePdfHash,
    });
    await sendEnvelope(db, vendor, { envelopeId: env.id, token, actor: "user:u1" });
    return { db, vendor, env };
  }

  it("rejects forged deliveries before parsing", async () => {
    const db = makeFakeDb();
    const vendor = makeFakeVendor();
    const r = await ingestDocumensoWebhook(db, vendor, {
      rawBody: webhookBody("DOCUMENT_COMPLETED", "doc_1"),
      secretHeader: "forged",
      env: WEBHOOK_ENV,
    });
    assert.deepEqual(r, { ok: false, reason: "bad_signature" });
  });

  it("ignores unknown envelopes and informational events", async () => {
    const db = makeFakeDb();
    const vendor = makeFakeVendor();
    const unknown = await ingestDocumensoWebhook(db, vendor, {
      rawBody: webhookBody("DOCUMENT_COMPLETED", "doc_nope"),
      secretHeader: "wh-secret",
      env: WEBHOOK_ENV,
    });
    assert.deepEqual(unknown, { ok: true, ignored: "unknown_envelope" });

    const { db: db2 } = await sentEnvelope();
    const ignored = await ingestDocumensoWebhook(db2, vendor, {
      rawBody: webhookBody("DOCUMENT_REMINDER_SENT", "doc_1"),
      secretHeader: "wh-secret",
      env: WEBHOOK_ENV,
    });
    assert.deepEqual(ignored, { ok: true, ignored: "event_ignored" });
  });

  it("tracks signer progress but completes ONLY on DOCUMENT_COMPLETED", async () => {
    const { db, vendor } = await sentEnvelope();
    const signed = await ingestDocumensoWebhook(db, vendor, {
      rawBody: webhookBody("DOCUMENT_SIGNED", "doc_1", [
        { email: "jane@acme.com", signingStatus: "SIGNED", signedAt: "2026-10-01T01:00:00Z" },
      ]),
      secretHeader: "wh-secret",
      env: WEBHOOK_ENV,
    });
    assert.deepEqual(signed, { ok: true, applied: "partially-signed" });
    const row = await db.esignEnvelope.findFirst({ where: { vendorRef: "doc_1" } });
    assert.equal(row.status, "partially-signed");
    assert.notEqual(row.status, "completed", "a SIGNED event must never complete the envelope");
    assert.equal(row.signers[0].status, "signed");
    assert.ok(!vendor.calls.includes("getSealedPdf"), "no sealed PDF before completion");
  });

  it("completes on DOCUMENT_COMPLETED and mirrors the sealed PDF", async () => {
    const { db, vendor } = await sentEnvelope();
    const done = await ingestDocumensoWebhook(db, vendor, {
      rawBody: webhookBody("DOCUMENT_COMPLETED", "doc_1"),
      secretHeader: "wh-secret",
      env: WEBHOOK_ENV,
    });
    assert.deepEqual(done, { ok: true, applied: "completed" });
    const row = await db.esignEnvelope.findFirst({ where: { vendorRef: "doc_1" } });
    assert.equal(row.status, "completed");
    assert.ok(row.sealedPdf, "sealed PDF mirrored");
    assert.ok(row.sealedPdfHash, "sealed PDF hashed");
    assert.ok(vendor.calls.includes("getSealedPdf"));
  });

  it("dedupes identical redeliveries", async () => {
    const { db, vendor } = await sentEnvelope();
    const body = webhookBody("DOCUMENT_COMPLETED", "doc_1");
    const first = await ingestDocumensoWebhook(db, vendor, {
      rawBody: body,
      secretHeader: "wh-secret",
      env: WEBHOOK_ENV,
    });
    assert.deepEqual(first, { ok: true, applied: "completed" });
    const before = db.auditRows.length;
    const replay = await ingestDocumensoWebhook(db, vendor, {
      rawBody: body,
      secretHeader: "wh-secret",
      env: WEBHOOK_ENV,
    });
    assert.deepEqual(replay, { ok: true, deduped: true });
    assert.equal(db.auditRows.length, before, "replay adds no audit row");
  });

  it("never regresses a terminal state", async () => {
    const { db, vendor } = await sentEnvelope();
    await ingestDocumensoWebhook(db, vendor, {
      rawBody: webhookBody("DOCUMENT_COMPLETED", "doc_1"),
      secretHeader: "wh-secret",
      env: WEBHOOK_ENV,
    });
    // A late duplicate SIGNED event must not move a completed envelope backwards.
    const late = await ingestDocumensoWebhook(db, vendor, {
      rawBody: webhookBody("DOCUMENT_SIGNED", "doc_1", [
        { email: "jane@acme.com", signingStatus: "SIGNED", signedAt: "2026-10-01T02:00:00Z" },
      ]),
      secretHeader: "wh-secret",
      env: WEBHOOK_ENV,
    });
    assert.ok(late.ok);
    const row = await db.esignEnvelope.findFirst({ where: { vendorRef: "doc_1" } });
    assert.equal(row.status, "completed");
  });

  it("maps rejection and cancellation to terminal states", async () => {
    const { db, vendor } = await sentEnvelope();
    const r = await ingestDocumensoWebhook(db, vendor, {
      rawBody: webhookBody("DOCUMENT_REJECTED", "doc_1", [
        { email: "jane@acme.com", signingStatus: "REJECTED" },
      ]),
      secretHeader: "wh-secret",
      env: WEBHOOK_ENV,
    });
    assert.deepEqual(r, { ok: true, applied: "declined" });
    const row = await db.esignEnvelope.findFirst({ where: { vendorRef: "doc_1" } });
    assert.equal(row.status, "declined");
    assert.equal(row.signers[0].status, "declined");
  });
});

describe("completion fires pipeline links", () => {
  it("a completed proposal-linked envelope announces proposal_to_contract", async () => {
    const db = makeFakeDb();
    const vendor = makeFakeVendor();
    const env = await createEnvelopeDraft(
      db,
      draftInput({ contractType: "proposal", contractRef: "prop_1" }),
    );
    const token = buildSendToken({
      id: env.id,
      title: env.title,
      signerEmails: env.signers.map((s: any) => s.email),
      signingOrder: env.signingOrder,
      expiresAt: env.expiresAt,
      sourcePdfHash: env.sourcePdfHash,
    });
    await sendEnvelope(db, vendor, { envelopeId: env.id, token, actor: "user:u1" });

    const seen: PipelineLinkEvent[] = [];
    const unsub = onPipelineLink((e) => {
      seen.push(e);
    });
    try {
      const done = await ingestDocumensoWebhook(db, vendor, {
        rawBody: webhookBody("DOCUMENT_COMPLETED", "doc_1"),
        secretHeader: "wh-secret",
        env: WEBHOOK_ENV,
      });
      assert.deepEqual(done, { ok: true, applied: "completed" });
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.kind, "proposal_to_contract");
      assert.equal(seen[0]!.refId, "prop_1");
      assert.equal(seen[0]!.envelopeId, env.id);
      assert.ok(db.auditRows.some((r: any) => r.event === "pipeline_link_fired"));
    } finally {
      unsub();
    }
  });
});
