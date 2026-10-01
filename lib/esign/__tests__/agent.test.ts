// Marketr — E-sign module tests (slice 6): agent-driven signing workflows.
// Run: npx tsx --test lib/esign/__tests__/agent.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EsignGateError } from "../envelopes";
import { appendAuditEvent } from "../audit";
import {
  prepareEnvelopeDraft,
  listPendingSigners,
  draftNudge,
  approveNudge,
  recordNudgeDelivery,
  sweepExpirations,
  cloneAsDraft,
  signingAnalytics,
} from "../agent";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function makeDb() {
  const envelopes = new Map<string, any>();
  const templates = new Map<string, any>();
  const auditRows: any[] = [];
  let seq = 0;
  const db: any = {
    envelopes,
    auditRows,
    esignEnvelope: {
      async create({ data }: any) {
        const id = `env_${++seq}`;
        const signers = (data.signers?.create ?? []).map((s: any, i: number) => ({
          id: `sig_${seq}_${i}`,
          status: "pending",
          signedAt: null,
          ...s,
        }));
        const fields = (data.fields?.create ?? []).map((f: any, i: number) => ({
          id: `fld_${seq}_${i}`,
          signerId: null,
          ...f,
        }));
        // Bind field signerIndex -> signer id.
        for (const f of fields) {
          if (typeof f.signerIndex === "number" && signers[f.signerIndex]) {
            f.signerId = signers[f.signerIndex].id;
          }
          delete f.signerIndex;
        }
        const row = {
          id,
          status: "draft",
          createdAt: new Date(),
          updatedAt: new Date(),
          signingOrder: "sequential",
          templateId: null,
          contractType: null,
          contractRef: null,
          documentName: null,
          sourcePdf: null,
          expiresAt: null,
          ...data,
          signers,
          fields,
        };
        delete row.signers?.create;
        envelopes.set(id, row);
        return row;
      },
      async findFirst({ where, include }: any) {
        for (const e of envelopes.values()) {
          if (where.id && e.id !== where.id) continue;
          if (where.workspaceId && e.workspaceId !== where.workspaceId) continue;
          const out: any = { ...e };
          if (include?.signers) out.signers = e.signers ?? [];
          if (include?.fields) out.fields = e.fields ?? [];
          return out;
        }
        return null;
      },
      async findMany({ where, include }: any) {
        return [...envelopes.values()]
          .filter((e) => {
            if (where.workspaceId && e.workspaceId !== where.workspaceId) return false;
            if (where.status) {
              if (where.status.in) { if (!where.status.in.includes(e.status)) return false; }
              else if (e.status !== where.status) return false;
            }
            if (where.expiresAt?.lt && !(e.expiresAt && e.expiresAt < where.expiresAt.lt)) return false;
            if (where.createdAt?.gte && !(e.createdAt >= where.createdAt.gte)) return false;
            return true;
          })
          .map((e) => {
            const out: any = { ...e };
            if (include?.signers) out.signers = e.signers ?? [];
            return out;
          });
      },
      async update({ where, data }: any) {
        const e = envelopes.get(where.id);
        Object.assign(e, data, { updatedAt: new Date() });
        return e;
      },
    },
    esignTemplate: {
      async findFirst({ where }: any) {
        for (const t of templates.values()) {
          if (where.id && t.id !== where.id) continue;
          if (where.workspaceId && t.workspaceId !== where.workspaceId) continue;
          return t;
        }
        return null;
      },
    },
    esignAuditEvent: {
      async findFirst({ where }: any) {
        const rows = auditRows
          .filter((r) => r.envelopeId === where.envelopeId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.seqNo - a.seqNo);
        const r = rows[0];
        return r ? { hash: r.hash } : null;
      },
      async findUnique({ where }: any) {
        return auditRows.find((r) => r.id === where.id) ?? null;
      },
      async findMany({ where, orderBy }: any) {
        let rows = auditRows.filter((r) => {
          if (where.envelopeId && r.envelopeId !== where.envelopeId) return false;
          if (where.event && r.event !== where.event) return false;
          return true;
        });
        if (orderBy?.createdAt === "desc")
          rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.seqNo - a.seqNo);
        else rows = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.seqNo - b.seqNo);
        return rows;
      },
      async create({ data }: any) {
        const id = `evt_${++seq}`;
        const row = { id, seqNo: seq, createdAt: new Date(), ...data };
        auditRows.push(row);
        return { id };
      },
    },
    __templates: templates,
  };
  return db as any;
}

async function seedTemplate(db: any) {
  const id = "tpl_1";
  db.__templates.set(id, {
    id,
    workspaceId: "ws_1",
    name: "MSA",
    sourceDocument: Buffer.from(PDF),
    sourceDocumentHash: "tmphash",
    signerRoles: [
      { role: "client", orderIndex: 0, required: true },
      { role: "founder", orderIndex: 1, required: true },
    ],
    fieldLayout: [],
    mergeFieldMapping: {},
  });
  return id;
}

describe("prepareEnvelopeDraft", () => {
  it("prepares a raw draft behind the send gate — never sent", async () => {
    const db = makeDb();
    const res = await prepareEnvelopeDraft(db, {
      workspaceId: "ws_1",
      actor: "agent:pipeline",
      title: "Client SOW",
      pdfBytes: PDF,
      documentName: "sow.pdf",
      signers: [
        { name: "Client", email: "client@x.com", role: "signer" },
        { name: "Tico", email: "tico@x.com", role: "approver" },
      ],
    });
    assert.equal(res.status, "draft");
    assert.equal(res.sendPreview.signerCount, 2);
    assert.equal(res.sendPreview.sendGate, "human-review-required");
    const events = db.auditRows.filter((r: any) => r.envelopeId === res.envelopeId).map((r: any) => r.event);
    assert.ok(events.includes("agent_draft_prepared"));
    assert.ok(!events.includes("sent"), "the agent must never send");
    const env = await db.esignEnvelope.findFirst({ where: { id: res.envelopeId } });
    assert.equal(env.status, "draft");
  });

  it("prepares from a template's exact bytes", async () => {
    const db = makeDb();
    const templateId = await seedTemplate(db);
    const res = await prepareEnvelopeDraft(db, {
      workspaceId: "ws_1",
      actor: "agent:pipeline",
      title: "MSA for Acme",
      templateId,
      mergeValues: {},
      signerBindings: [
        { role: "client", name: "Acme", email: "acme@x.com" },
        { role: "founder", name: "Tico", email: "tico@x.com" },
      ],
    });
    assert.equal(res.status, "draft");
    const env = await db.esignEnvelope.findFirst({ where: { id: res.envelopeId }, include: { signers: true } });
    assert.equal(env.templateId, templateId);
    assert.equal(env.signers.length, 2);
    // Template roles order the signers; envelope roles stay the closed set.
    assert.equal(env.signers[0].email, "acme@x.com");
    assert.equal(env.signers[1].email, "tico@x.com");
  });

  it("requires a template or PDF bytes", async () => {
    const db = makeDb();
    await assert.rejects(
      prepareEnvelopeDraft(db, { workspaceId: "ws_1", actor: "agent:x", title: "T" }),
      (e: any) => e instanceof EsignGateError && e.code === "invalid_input",
    );
  });
});

describe("nudge engine", () => {
  async function sentEnvelope(db: any) {
    const env = await db.esignEnvelope.create({
      data: {
        workspaceId: "ws_1",
        title: "MSA",
        status: "sent",
        createdAt: new Date(Date.now() - 5 * 86400000),
        signers: {
          create: [
            { name: "Waiter", email: "w@x.com", role: "client", orderIndex: 0 },
            { name: "Done", email: "d@x.com", role: "founder", orderIndex: 1, status: "signed", signedAt: new Date() },
          ],
        },
      },
    });
    return env;
  }

  it("lists idle pending signers, oldest first; excludes the signed", async () => {
    const db = makeDb();
    const env = await sentEnvelope(db);
    const pending = await listPendingSigners(db, { workspaceId: "ws_1", idleDays: 0 });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].email, "w@x.com");
    assert.equal(pending[0].envelopeId, env.id);
    assert.ok(pending[0].daysWaiting >= 5);
  });

  it("draft -> approve -> record delivery; approve is single-release", async () => {
    const db = makeDb();
    const env = await sentEnvelope(db);
    const signerId = env.signers[0].id;
    const draft = await draftNudge(db, {
      envelopeId: env.id,
      signerId,
      workspaceId: "ws_1",
      actor: "agent:nudge",
    });
    assert.ok(draft.message.includes("Waiter"));
    assert.ok(draft.message.includes("MSA"));

    const approved = await approveNudge(db, {
      nudgeEventId: draft.nudgeEventId,
      workspaceId: "ws_1",
      actor: "tico",
    });
    assert.equal(approved.nudgeId, draft.nudgeId);

    await assert.rejects(
      approveNudge(db, { nudgeEventId: draft.nudgeEventId, workspaceId: "ws_1", actor: "tico" }),
      (e: any) => e instanceof EsignGateError && e.code === "nudge_already_released",
    );

    await recordNudgeDelivery(db, {
      nudgeId: draft.nudgeId,
      envelopeId: env.id,
      workspaceId: "ws_1",
      deliveredVia: "documenso-reminder",
      actor: "agent:nudge",
    });
    const pending = await listPendingSigners(db, { workspaceId: "ws_1", idleDays: 0 });
    assert.equal(pending[0].lastNudgeAt !== null, true);
  });

  it("blocks nudging a signer who already signed", async () => {
    const db = makeDb();
    const env = await sentEnvelope(db);
    const signedId = env.signers[1].id;
    await assert.rejects(
      draftNudge(db, { envelopeId: env.id, signerId: signedId, workspaceId: "ws_1", actor: "agent:nudge" }),
      (e: any) => e instanceof EsignGateError && e.code === "already_signed",
    );
  });
});

describe("sweepExpirations + cloneAsDraft", () => {
  it("expires stale live envelopes and leaves the rest", async () => {
    const db = makeDb();
    const stale = await db.esignEnvelope.create({
      data: { workspaceId: "ws_1", title: "Old", status: "sent", expiresAt: new Date(Date.now() - 1000), signers: { create: [] } },
    });
    const fresh = await db.esignEnvelope.create({
      data: { workspaceId: "ws_1", title: "New", status: "sent", expiresAt: new Date(Date.now() + 86400000), signers: { create: [] } },
    });
    const res = await sweepExpirations(db, { workspaceId: "ws_1", actor: "cron" });
    assert.equal(res.expired, 1);
    assert.deepEqual(res.ids, [stale.id]);
    const after = await db.esignEnvelope.findFirst({ where: { id: stale.id } });
    assert.equal(after.status, "expired");
    const stillFresh = await db.esignEnvelope.findFirst({ where: { id: fresh.id } });
    assert.equal(stillFresh.status, "sent");
  });

  it("clones an expired envelope into a fresh draft behind the send gate", async () => {
    const db = makeDb();
    const original = await db.esignEnvelope.create({
      data: {
        workspaceId: "ws_1",
        title: "MSA",
        status: "expired",
        sourcePdf: Buffer.from(PDF),
        signers: { create: [{ name: "C", email: "c@x.com", role: "client", orderIndex: 0 }] },
      },
    });
    const res = await cloneAsDraft(db, { envelopeId: original.id, workspaceId: "ws_1", actor: "tico" });
    assert.equal(res.status, "draft");
    assert.notEqual(res.envelopeId, original.id);
    const clone = await db.esignEnvelope.findFirst({ where: { id: res.envelopeId }, include: { signers: true } });
    assert.equal(clone.status, "draft");
    assert.equal(clone.title, "MSA (re-send)");
    assert.deepEqual(new Uint8Array(clone.sourcePdf), PDF);
    assert.equal(clone.signers[0].status, "pending");
    const events = db.auditRows.filter((r: any) => r.envelopeId === res.envelopeId).map((r: any) => r.event);
    assert.ok(!events.includes("sent"), "a clone re-enters the send gate");
    const origAfter = await db.esignEnvelope.findFirst({ where: { id: original.id } });
    assert.equal(origAfter.status, "expired");
  });

  it("blocks cloning a completed envelope", async () => {
    const db = makeDb();
    const done = await db.esignEnvelope.create({
      data: { workspaceId: "ws_1", title: "Done", status: "completed", sourcePdf: Buffer.from(PDF), signers: { create: [] } },
    });
    await assert.rejects(
      cloneAsDraft(db, { envelopeId: done.id, workspaceId: "ws_1", actor: "tico" }),
      (e: any) => e instanceof EsignGateError && e.code === "not_reopenable",
    );
  });
});

describe("signingAnalytics", () => {
  it("computes completion rate and time-to-sign from the audit trail", async () => {
    const db = makeDb();
    const t0 = new Date("2026-09-01T00:00:00Z");
    for (const [title, hours] of [["A", 24], ["B", 72]] as const) {
      const env = await db.esignEnvelope.create({
        data: { workspaceId: "ws_1", title, status: "completed", templateId: "tpl_1", signers: { create: [] } },
      });
      await appendAuditEvent(db, {
        envelopeId: env.id, event: "sent", actor: "u", payload: {},
        bodyHash: `s_${title}`, createdAt: t0,
      });
      await appendAuditEvent(db, {
        envelopeId: env.id, event: "completed", actor: "system", payload: {},
        bodyHash: `c_${title}`, createdAt: new Date(t0.getTime() + hours * 3600000),
      });
    }
    await db.esignEnvelope.create({
      data: { workspaceId: "ws_1", title: "C", status: "sent", templateId: "tpl_1", signers: { create: [] } },
    });
    const stats = await signingAnalytics(db, { workspaceId: "ws_1" });
    assert.equal(stats.envelopes, 3);
    assert.equal(stats.completed, 2);
    assert.ok(Math.abs(stats.completionRate - 2 / 3) < 1e-9);
    assert.ok(Math.abs(stats.avgHours! - 48) < 1e-9);
    assert.ok(Math.abs(stats.medianHours! - 72) < 1e-9);
    const tpl = stats.byTemplate.find((b) => b.templateId === "tpl_1")!;
    assert.equal(tpl.completed, 2);
  });
});
