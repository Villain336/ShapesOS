// Marketr — E-sign module tests (slice 5): legal vault + legal binding + evidence pack.
// Run: npx tsx --test lib/esign/__tests__/vault.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EsignGateError } from "../envelopes";
import { appendAuditEvent } from "../audit";
import { storeInVault, setLegalHold, releaseLegalHold, purgeExpired, verifyAuditChain } from "../vault";
import { linkContract, flipContractExecuted, buildEvidencePack } from "../legal";

function makeDb() {
  const envelopes = new Map<string, any>();
  const vaultEntries = new Map<string, any>();
  const auditRows: any[] = [];
  let seq = 0;
  const db: any = {
    envelopes,
    vaultEntries,
    auditRows,
    esignEnvelope: {
      async create({ data }: any) {
        const id = `env_${++seq}`;
        const row = { id, status: "draft", createdAt: new Date(), ...data, sealedPdf: data.sealedPdf ?? null };
        envelopes.set(id, row);
        return row;
      },
      async findFirst({ where, include }: any) {
        for (const e of envelopes.values()) {
          if (where.id && e.id !== where.id) continue;
          if (where.workspaceId && e.workspaceId !== where.workspaceId) continue;
          const out: any = { ...e };
          if (include?.signers) out.signers = e.signers ?? [];
          if (include?.events)
            out.events = auditRows
              .filter((r) => r.envelopeId === e.id)
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.seqNo - b.seqNo);
          if (include?.vaultEntry)
            out.vaultEntry = [...vaultEntries.values()].find((v) => v.envelopeId === e.id) ?? null;
          return out;
        }
        return null;
      },
      async update({ where, data }: any) {
        const e = envelopes.get(where.id);
        Object.assign(e, data);
        return e;
      },
    },
    esignVaultEntry: {
      async create({ data }: any) {
        const id = `vault_${++seq}`;
        const row = {
          id,
          storedAt: new Date(),
          legalHold: false,
          legalHoldReason: null,
          purgedAt: null,
          ...data,
        };
        vaultEntries.set(id, row);
        return row;
      },
      async findFirst({ where }: any) {
        for (const v of vaultEntries.values()) {
          if (where.id && v.id !== where.id) continue;
          if (where.workspaceId && v.workspaceId !== where.workspaceId) continue;
          return v;
        }
        return null;
      },
      async findMany({ where }: any) {
        return [...vaultEntries.values()].filter((v) => {
          if (where.workspaceId && v.workspaceId !== where.workspaceId) return false;
          if (where.purgedAt === null && v.purgedAt !== null) return false;
          if (where.retentionUntil?.lt && !(v.retentionUntil && v.retentionUntil < where.retentionUntil.lt))
            return false;
          return true;
        });
      },
      async update({ where, data }: any) {
        const v = vaultEntries.get(where.id);
        Object.assign(v, data);
        return v;
      },
    },
    esignAuditEvent: {
      async findFirst({ where, orderBy }: any) {
        const rows = auditRows
          .filter((r) => r.envelopeId === where.envelopeId)
          .sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.seqNo - a.seqNo,
          );
        const r = rows[0];
        return r ? { hash: r.hash } : null;
      },
      async create({ data }: any) {
        const id = `evt_${++seq}`;
        const row = { id, seqNo: seq, createdAt: new Date(), ...data };
        auditRows.push(row);
        return { id };
      },
      async update({ where, data }: any) {
        const r = auditRows.find((x) => x.id === where.id);
        Object.assign(r, data);
        return r;
      },
    },
  };
  return db;
}

async function completeEnvelope(db: any, overrides: any = {}) {
  const env = await db.esignEnvelope.create({
    data: {
      workspaceId: "ws_1",
      title: "MSA",
      status: "completed",
      sealedPdf: Buffer.from("sealed"),
      sealedPdfHash: "sealhash",
      signers: [{ name: "A", email: "a@x.com", role: "client", orderIndex: 0, status: "signed" }],
      contractType: null,
      contractRef: null,
      ...overrides,
    },
  });
  await appendAuditEvent(db, {
    envelopeId: env.id,
    event: "created",
    actor: "u1",
    payload: { title: "MSA" },
    bodyHash: `bh_created_${env.id}`,
  });
  await appendAuditEvent(db, {
    envelopeId: env.id,
    event: "completed",
    actor: "system",
    payload: {},
    bodyHash: `bh_completed_${env.id}`,
  });
  return env;
}

describe("verifyAuditChain", () => {
  it("accepts a well-formed chain", async () => {
    const db = makeDb();
    const env = await completeEnvelope(db);
    const rows = db.auditRows.filter((r: any) => r.envelopeId === env.id);
    const res = verifyAuditChain(
      rows.map((r: any) => ({
        event: r.event,
        hash: r.hash,
        previousHash: r.previousHash,
        payload: r.payload,
        createdAt: r.createdAt,
      })),
    );
    assert.equal(res.ok, true);
    assert.equal(res.checked, 2);
  });
});

describe("storeInVault", () => {
  it("vaults a completed sealed envelope with integrity anchors", async () => {
    const db = makeDb();
    const env = await completeEnvelope(db);
    const entry = await storeInVault(db, {
      envelopeId: env.id,
      workspaceId: "ws_1",
      retentionDays: 30,
      actor: "u1",
    });
    assert.equal(entry.sealedPdfHash, "sealhash");
    assert.equal(entry.eventCount, 2); // created + completed (vault_stored lands after)
    assert.ok(entry.retentionUntil && entry.retentionUntil > new Date());
    assert.equal(entry.legalHold, false);
  });

  it("is idempotent — re-storing returns the existing entry", async () => {
    const db = makeDb();
    const env = await completeEnvelope(db);
    const a = await storeInVault(db, { envelopeId: env.id, workspaceId: "ws_1", actor: "u1" });
    const b = await storeInVault(db, { envelopeId: env.id, workspaceId: "ws_1", actor: "u1" });
    assert.equal(a.id, b.id);
  });

  it("blocks non-completed envelopes", async () => {
    const db = makeDb();
    const env = await db.esignEnvelope.create({
      data: { workspaceId: "ws_1", title: "D", status: "sent", signers: [] },
    });
    await assert.rejects(
      storeInVault(db, { envelopeId: env.id, workspaceId: "ws_1", actor: "u1" }),
      (e: any) => e instanceof EsignGateError && e.code === "not_completed",
    );
  });

  it("blocks envelopes with no sealed PDF", async () => {
    const db = makeDb();
    const env = await db.esignEnvelope.create({
      data: { workspaceId: "ws_1", title: "D", status: "completed", signers: [] },
    });
    await appendAuditEvent(db, {
      envelopeId: env.id,
      event: "completed",
      actor: "system",
      payload: {},
      bodyHash: `bh_x_${env.id}`,
    });
    await assert.rejects(
      storeInVault(db, { envelopeId: env.id, workspaceId: "ws_1", actor: "u1" }),
      (e: any) => e instanceof EsignGateError && e.code === "no_sealed_pdf",
    );
  });

  it("blocks a tampered chain — the vault never anchors broken evidence", async () => {
    const db = makeDb();
    const env = await completeEnvelope(db);
    const rows = db.auditRows.filter((r: any) => r.envelopeId === env.id);
    await db.esignAuditEvent.update({ where: { id: rows[0].id }, data: { hash: "tampered" } });
    await assert.rejects(
      storeInVault(db, { envelopeId: env.id, workspaceId: "ws_1", actor: "u1" }),
      (e: any) => e instanceof EsignGateError && e.code === "broken_chain",
    );
  });
});

describe("legal hold + retention", () => {
  it("a legal hold blocks purging; release lets it through", async () => {
    const db = makeDb();
    const env = await completeEnvelope(db);
    const entry = await storeInVault(db, {
      envelopeId: env.id,
      workspaceId: "ws_1",
      retentionDays: 30,
      actor: "u1",
    });
    // Simulate retention having lapsed.
    await db.esignVaultEntry.update({
      where: { id: entry.id },
      data: { retentionUntil: new Date(Date.now() - 1000) },
    });
    await setLegalHold(db, { entryId: entry.id, workspaceId: "ws_1", reason: "litigation", actor: "u1" });
    const r1 = await purgeExpired(db, { workspaceId: "ws_1", actor: "cron" });
    assert.equal(r1.purged, 0);
    assert.equal(r1.blockedByHold, 1);
    const after = await db.esignEnvelope.findFirst({ where: { id: env.id } });
    assert.ok(after.sealedPdf); // bytes survive the hold

    await releaseLegalHold(db, { entryId: entry.id, workspaceId: "ws_1", actor: "u1" });
    const r2 = await purgeExpired(db, { workspaceId: "ws_1", actor: "cron" });
    assert.equal(r2.purged, 1);
    const gone = await db.esignEnvelope.findFirst({ where: { id: env.id } });
    assert.equal(gone.sealedPdf, null);
    assert.equal(gone.sealedPdfHash, null);
  });

  it("legal hold requires a reason", async () => {
    const db = makeDb();
    const env = await completeEnvelope(db);
    const entry = await storeInVault(db, { envelopeId: env.id, workspaceId: "ws_1", actor: "u1" });
    await assert.rejects(
      setLegalHold(db, { entryId: entry.id, workspaceId: "ws_1", reason: "  ", actor: "u1" }),
      (e: any) => e instanceof EsignGateError && e.code === "missing_reason",
    );
  });
});

describe("linkContract + flipContractExecuted", () => {
  it("links a contract and flips executed on a completed sealed envelope", async () => {
    const db = makeDb();
    const env = await completeEnvelope(db);
    await linkContract(db, {
      envelopeId: env.id,
      workspaceId: "ws_1",
      contractType: "msa",
      contractRef: "contract_9",
      actor: "u1",
    });
    const flip = await flipContractExecuted(db, { envelopeId: env.id, workspaceId: "ws_1", actor: "u1" });
    assert.equal(flip.contractRef, "contract_9");
    const events = db.auditRows.filter((r: any) => r.envelopeId === env.id).map((r: any) => r.event);
    assert.ok(events.includes("contract_linked"));
    assert.ok(events.includes("contract_executed"));
  });

  it("flip blocks non-completed envelopes", async () => {
    const db = makeDb();
    const env = await db.esignEnvelope.create({
      data: { workspaceId: "ws_1", title: "D", status: "sent", signers: [], contractRef: "c1" },
    });
    await assert.rejects(
      flipContractExecuted(db, { envelopeId: env.id, workspaceId: "ws_1", actor: "u1" }),
      (e: any) => e instanceof EsignGateError && e.code === "not_completed",
    );
  });

  it("flip blocks envelopes with no contract link", async () => {
    const db = makeDb();
    const env = await completeEnvelope(db);
    await assert.rejects(
      flipContractExecuted(db, { envelopeId: env.id, workspaceId: "ws_1", actor: "u1" }),
      (e: any) => e instanceof EsignGateError && e.code === "no_contract_link",
    );
  });
});

describe("buildEvidencePack", () => {
  it("returns a complete pack: envelope, signers, hash-chained log, integrity, vault", async () => {
    const db = makeDb();
    const env = await completeEnvelope(db);
    await linkContract(db, {
      envelopeId: env.id,
      workspaceId: "ws_1",
      contractType: "msa",
      contractRef: "contract_9",
      actor: "u1",
    });
    const entry = await storeInVault(db, { envelopeId: env.id, workspaceId: "ws_1", actor: "u1" });
    const pack = await buildEvidencePack(db, { envelopeId: env.id, workspaceId: "ws_1" });
    assert.equal(pack.envelope.id, env.id);
    assert.equal(pack.envelope.contractRef, "contract_9");
    assert.equal(pack.envelope.sealedPdfHash, "sealhash");
    assert.equal(pack.integrity.chainOk, true);
    assert.ok(pack.integrity.eventsChecked >= 4);
    assert.equal(pack.signers.length, 1);
    assert.equal(pack.signers[0].email, "a@x.com");
    assert.ok(pack.auditLog.every((e: any) => e.hash && e.createdAt));
    assert.equal(pack.vault!.sealedPdfHash, "sealhash");
    assert.equal(pack.vault!.auditHeadHash, entry.auditHeadHash);
    assert.ok(pack.sealedPdfDownload);
  });
});
