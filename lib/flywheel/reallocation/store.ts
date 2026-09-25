// Marketr — Phase 7 F1: persistence boundary.
//
// ReallocationStore is the single persistence interface for F1. Routes and
// the checkout path depend on the interface, never on a concrete backend.
//
// - createMemoryReallocationStore(): in-memory, used by the verify battery
//   and tests.
// - createPrismaReallocationStore(): Prisma-backed. The F1 models live in
//   prisma/fragments/phase7-reallocation.prisma until the coordinator merges
//   fragments into schema.prisma; until then the delegates are reached
//   through narrowly-scoped casts (marked MERGE). Behavior is identical
//   after the merge; the casts just keep tsc green before it.

import type { PrismaClient } from "@prisma/client";
import type {
  AuditEvent,
  BreakerEvent,
  ChannelFloor,
  MarginalCurve,
  PolicyDecision,
  ReallocationProposal,
  ReallocationRun,
  SraEnvelope,
} from "./types";
import { createMemoryAuditStore, type AuditStore } from "./audit";

export interface SraRecord extends SraEnvelope {
  id: string;
}
export interface ProposalRecord extends ReallocationProposal {
  id: string;
}
export interface PolicyDecisionRecord extends PolicyDecision {
  id: string;
}
export interface BreakerEventRecord extends BreakerEvent {
  id: string;
}
export interface RunRecord extends ReallocationRun {
  id: string;
}
export interface CurveRecord extends MarginalCurve {
  id: string;
}

export interface ReallocationStore {
  // SRAs
  createSra(sra: Omit<SraRecord, "id"> & { id?: string }): Promise<SraRecord>;
  getSra(id: string, workspaceId: string): Promise<SraRecord | null>;
  updateSra(id: string, workspaceId: string, patch: Partial<SraRecord>): Promise<SraRecord>;
  listSras(workspaceId: string): Promise<SraRecord[]>;
  // proposals
  createProposal(p: Omit<ProposalRecord, "id"> & { id?: string }): Promise<ProposalRecord>;
  getProposal(id: string, workspaceId: string): Promise<ProposalRecord | null>;
  updateProposal(id: string, workspaceId: string, patch: Partial<ProposalRecord>): Promise<ProposalRecord>;
  listProposals(workspaceId: string, limit?: number): Promise<ProposalRecord[]>;
  /** Executed |shifts| under an SRA since a timestamp (cap accounting). */
  executedShiftsSince(sraId: string, workspaceId: string, sinceIso: string): Promise<ProposalRecord[]>;
  // policy decisions
  appendPolicyDecision(d: Omit<PolicyDecisionRecord, "id"> & { id?: string }): Promise<PolicyDecisionRecord>;
  listPolicyDecisions(proposalId: string, workspaceId: string): Promise<PolicyDecisionRecord[]>;
  // curves
  saveCurve(c: Omit<CurveRecord, "id"> & { id?: string }): Promise<CurveRecord>;
  listCurves(workspaceId: string, channel?: string): Promise<CurveRecord[]>;
  // floors
  upsertFloor(f: ChannelFloor): Promise<ChannelFloor>;
  listFloors(workspaceId: string): Promise<ChannelFloor[]>;
  // runs
  createRun(r: Omit<RunRecord, "id"> & { id?: string }): Promise<RunRecord>;
  getRun(id: string, workspaceId: string): Promise<RunRecord | null>;
  listRuns(workspaceId: string, limit?: number): Promise<RunRecord[]>;
  // breakers
  appendBreakerEvent(e: Omit<BreakerEventRecord, "id"> & { id?: string }): Promise<BreakerEventRecord>;
  updateBreakerEvent(id: string, workspaceId: string, patch: Partial<BreakerEventRecord>): Promise<BreakerEventRecord>;
  listBreakerEvents(workspaceId: string, limit?: number): Promise<BreakerEventRecord[]>;
  // audit
  audit: AuditStore;
}

let seq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export function createMemoryReallocationStore(): ReallocationStore {
  const sras = new Map<string, SraRecord>();
  const proposals = new Map<string, ProposalRecord>();
  const decisions: PolicyDecisionRecord[] = [];
  const curves: CurveRecord[] = [];
  const floors = new Map<string, ChannelFloor>();
  const runs = new Map<string, RunRecord>();
  const breakers = new Map<string, BreakerEventRecord>();
  const key = (id: string, ws: string) => `${ws}:${id}`;

  return {
    audit: createMemoryAuditStore(),
    async createSra(s) {
      const row = { ...structuredClone(s), id: uid("sra") };
      sras.set(key(row.id, row.workspaceId), row);
      return structuredClone(row);
    },
    async getSra(id, ws) {
      const r = sras.get(key(id, ws));
      return r ? structuredClone(r) : null;
    },
    async updateSra(id, ws, patch) {
      const r = sras.get(key(id, ws));
      if (!r) throw new Error("SRA not found in workspace.");
      const next = { ...structuredClone(r), ...structuredClone(patch) };
      sras.set(key(id, ws), next);
      return structuredClone(next);
    },
    async listSras(ws) {
      return [...sras.values()].filter((r) => r.workspaceId === ws).map((r) => structuredClone(r));
    },
    async createProposal(p) {
      const row = { ...structuredClone(p), id: uid("prop") };
      proposals.set(key(row.id, row.workspaceId), row);
      return structuredClone(row);
    },
    async getProposal(id, ws) {
      const r = proposals.get(key(id, ws));
      return r ? structuredClone(r) : null;
    },
    async updateProposal(id, ws, patch) {
      const r = proposals.get(key(id, ws));
      if (!r) throw new Error("Proposal not found in workspace.");
      const next = { ...structuredClone(r), ...structuredClone(patch) };
      proposals.set(key(id, ws), next);
      return structuredClone(next);
    },
    async listProposals(ws, limit = 200) {
      return [...proposals.values()]
        .filter((r) => r.workspaceId === ws)
        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
        .slice(0, limit)
        .map((r) => structuredClone(r));
    },
    async executedShiftsSince(sraId, ws, sinceIso) {
      const since = +new Date(sinceIso);
      return [...proposals.values()]
        .filter(
          (r) =>
            r.workspaceId === ws && r.sraId === sraId && r.status === "executed" && +new Date(r.createdAt) >= since,
        )
        .map((r) => structuredClone(r));
    },
    async appendPolicyDecision(d) {
      const row = { ...structuredClone(d), id: uid("pdec") };
      decisions.push(row);
      return structuredClone(row);
    },
    async listPolicyDecisions(proposalId, ws) {
      return decisions
        .filter((d) => d.proposalId === proposalId && d.workspaceId === ws)
        .map((d) => structuredClone(d));
    },
    async saveCurve(c) {
      const row = { ...structuredClone(c), id: uid("curve") };
      curves.push(row);
      return structuredClone(row);
    },
    async listCurves(ws, channel) {
      return curves
        .filter((c) => c.workspaceId === ws && (!channel || c.channel === channel))
        .map((c) => structuredClone(c));
    },
    async upsertFloor(f) {
      floors.set(`${f.workspaceId}:${f.channel}`, structuredClone(f));
      return structuredClone(f);
    },
    async listFloors(ws) {
      return [...floors.values()].filter((f) => f.workspaceId === ws).map((f) => structuredClone(f));
    },
    async createRun(r) {
      const row = { ...structuredClone(r), id: uid("run") };
      runs.set(key(row.id, row.workspaceId), row);
      return structuredClone(row);
    },
    async getRun(id, ws) {
      const r = runs.get(key(id, ws));
      return r ? structuredClone(r) : null;
    },
    async listRuns(ws, limit = 50) {
      return [...runs.values()]
        .filter((r) => r.workspaceId === ws)
        .sort((a, b) => +new Date(b.runAt) - +new Date(a.runAt))
        .slice(0, limit)
        .map((r) => structuredClone(r));
    },
    async appendBreakerEvent(e) {
      const row = { ...structuredClone(e), id: uid("brk") };
      breakers.set(key(row.id, row.workspaceId), row);
      return structuredClone(row);
    },
    async updateBreakerEvent(id, ws, patch) {
      const r = breakers.get(key(id, ws));
      if (!r) throw new Error("Breaker event not found in workspace.");
      const next = { ...structuredClone(r), ...structuredClone(patch) };
      breakers.set(key(id, ws), next);
      return structuredClone(next);
    },
    async listBreakerEvents(ws, limit = 200) {
      return [...breakers.values()]
        .filter((r) => r.workspaceId === ws)
        .sort((a, b) => +new Date(b.firedAt) - +new Date(a.firedAt))
        .slice(0, limit)
        .map((r) => structuredClone(r));
    },
  };
}

// ---------------------------------------------------------------------------
// Prisma-backed store (post-merge). MERGE: narrow casts until
// prisma/fragments/phase7-reallocation.prisma is merged into schema.prisma
// and the client regenerated — then replace with direct delegates.
// ---------------------------------------------------------------------------

type PrismaModels = {
  sraEnvelope: any;
  reallocationProposal: any;
  policyDecision: any;
  marginalCurve: any;
  channelFloor: any;
  reallocationRun: any;
  breakerEvent: any;
  flywheelAuditEvent: any;
};

const models = (prisma: PrismaClient): PrismaModels =>
  prisma as unknown as PrismaModels;

const toIso = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d));

export function createPrismaReallocationStore(prisma: PrismaClient): ReallocationStore {
  const m = models(prisma);
  const audit: AuditStore = {
    async append(e) {
      const { sha256Hex } = await import("@/lib/media/safety");
      const { canonicalize } = await import("@/lib/media/approvals");
      const { auditEventHash } = await import("./audit");
      const payloadHash = sha256Hex(canonicalize(e.payload));
      const last = await m.flywheelAuditEvent.findFirst({
        where: { workspaceId: e.workspaceId },
        orderBy: { ts: "desc" },
      });
      const prevHash = last?.eventHash ?? "GENESIS";
      const eventHash = auditEventHash(prevHash, {
        correlationId: e.correlationId,
        kind: e.kind,
        actor: e.actor,
        ts: e.ts,
        payloadHash,
      });
      const row = await m.flywheelAuditEvent.create({
        data: {
          workspaceId: e.workspaceId,
          correlationId: e.correlationId,
          kind: e.kind,
          actor: e.actor,
          payload: e.payload,
          payloadHash,
          prevHash,
          eventHash,
          ts: new Date(e.ts),
        },
      });
      return { ...row, ts: toIso(row.ts) } as AuditEvent;
    },
    async list(workspaceId, limit = 500) {
      const rows = await m.flywheelAuditEvent.findMany({
        where: { workspaceId },
        orderBy: { ts: "asc" },
        take: limit,
      });
      return rows.map((r: any) => ({ ...r, ts: toIso(r.ts) }) as AuditEvent);
    },
  };

  const serSra = (r: any): SraRecord => ({
    ...r,
    validFrom: toIso(r.validFrom),
    validUntil: toIso(r.validUntil),
    createdAt: toIso(r.createdAt),
    revokedAt: r.revokedAt ? toIso(r.revokedAt) : null,
  });
  const serProposal = (r: any): ProposalRecord => ({ ...r, createdAt: toIso(r.createdAt) });
  const serDecision = (r: any): PolicyDecisionRecord => ({ ...r, revocationCheckedAt: toIso(r.revocationCheckedAt) });
  const serCurve = (r: any): CurveRecord => ({ ...r, fittedAt: toIso(r.fittedAt) });
  const serRun = (r: any): RunRecord => ({ ...r, runAt: toIso(r.runAt) });
  const serBreaker = (r: any): BreakerEventRecord => ({
    ...r,
    firedAt: toIso(r.firedAt),
    acknowledgedAt: r.acknowledgedAt ? toIso(r.acknowledgedAt) : null,
    cooldownUntil: toIso(r.cooldownUntil),
  });

  return {
    audit,
    async createSra(s) {
      const { id: _drop, ...data } = s;
      return serSra(await m.sraEnvelope.create({ data: { ...data, channels: s.channels, signerIds: s.signerIds } }));
    },
    async getSra(id, ws) {
      const r = await m.sraEnvelope.findFirst({ where: { id, workspaceId: ws } });
      return r ? serSra(r) : null;
    },
    async updateSra(id, ws, patch) {
      return serSra(await m.sraEnvelope.update({ where: { id }, data: { ...patch, workspaceId: ws } }));
    },
    async listSras(ws) {
      return (await m.sraEnvelope.findMany({ where: { workspaceId: ws } })).map(serSra);
    },
    async createProposal(p) {
      const { id: _drop, ...data } = p;
      return serProposal(await m.reallocationProposal.create({ data: { ...data, decisionRecord: p.decisionRecord } }));
    },
    async getProposal(id, ws) {
      const r = await m.reallocationProposal.findFirst({ where: { id, workspaceId: ws } });
      return r ? serProposal(r) : null;
    },
    async updateProposal(id, ws, patch) {
      return serProposal(await m.reallocationProposal.update({ where: { id }, data: { ...patch, workspaceId: ws } }));
    },
    async listProposals(ws, limit = 200) {
      return (
        await m.reallocationProposal.findMany({ where: { workspaceId: ws }, orderBy: { createdAt: "desc" }, take: limit })
      ).map(serProposal);
    },
    async executedShiftsSince(sraId, ws, sinceIso) {
      return (
        await m.reallocationProposal.findMany({
          where: { workspaceId: ws, sraId, status: "executed", createdAt: { gte: new Date(sinceIso) } },
        })
      ).map(serProposal);
    },
    async appendPolicyDecision(d) {
      const { id: _drop, ...data } = d;
      return serDecision(await m.policyDecision.create({ data }));
    },
    async listPolicyDecisions(proposalId, ws) {
      return (
        await m.policyDecision.findMany({ where: { proposalId, workspaceId: ws }, orderBy: { revocationCheckedAt: "asc" } })
      ).map(serDecision);
    },
    async saveCurve(c) {
      const { id: _drop, ...data } = c;
      return serCurve(
        await m.marginalCurve.create({ data: { ...data, params: c.params, adstock: c.adstock, seasonality: c.seasonality } }),
      );
    },
    async listCurves(ws, channel) {
      return (
        await m.marginalCurve.findMany({ where: { workspaceId: ws, ...(channel ? { channel } : {}) }, orderBy: { fittedAt: "desc" } })
      ).map(serCurve);
    },
    async upsertFloor(f) {
      return m.channelFloor.upsert({
        where: { workspaceId_channel: { workspaceId: f.workspaceId, channel: f.channel } },
        update: { learningViableMinCentsDay: f.learningViableMinCentsDay, stabilizationHours: f.stabilizationHours },
        create: f,
      });
    },
    async listFloors(ws) {
      return m.channelFloor.findMany({ where: { workspaceId: ws } });
    },
    async createRun(r) {
      const { id: _drop, ...data } = r;
      return serRun(await m.reallocationRun.create({ data: { ...data, dataHealthSnapshot: r.dataHealthSnapshot } }));
    },
    async getRun(id, ws) {
      const r = await m.reallocationRun.findFirst({ where: { id, workspaceId: ws } });
      return r ? serRun(r) : null;
    },
    async listRuns(ws, limit = 50) {
      return (
        await m.reallocationRun.findMany({ where: { workspaceId: ws }, orderBy: { runAt: "desc" }, take: limit })
      ).map(serRun);
    },
    async appendBreakerEvent(e) {
      const { id: _drop, ...data } = e;
      return serBreaker(await m.breakerEvent.create({ data }));
    },
    async updateBreakerEvent(id, ws, patch) {
      return serBreaker(await m.breakerEvent.update({ where: { id }, data: { ...patch, workspaceId: ws } }));
    },
    async listBreakerEvents(ws, limit = 200) {
      return (
        await m.breakerEvent.findMany({ where: { workspaceId: ws }, orderBy: { firedAt: "desc" }, take: limit })
      ).map(serBreaker);
    },
  };
}
