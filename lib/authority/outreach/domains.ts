// Marketr — Phase 6 O1 outreach engine: sending-domain store + warmup tracking.
//
// Secondary domains only. Primary domains are hard-blocked from cold sending
// (enforced in guards.depth3Checklist). No Gmail free accounts.
// Prisma store is the production path; createMemoryDomainStore() is the
// battery twin (same interface).

import { prisma } from "@/lib/prisma";
import { createId } from "@/lib/media/ids";
import {
  type ChecklistFailure, type SendingDomainChecklistInput,
  depth3Checklist, assertDepth3Enabled, MIN_WARMUP_DAYS,
} from "@/lib/authority/guards";
import type { SendingDomain, SendingDomainStatus } from "@prisma/client";

export interface DomainCreateInput {
  domain: string;
  isPrimary?: boolean;
  spfOk?: boolean;
  dkimOk?: boolean;
  dmarcPolicy?: string | null;
  trackingCnameOk?: boolean;
  warmupStartedAt?: Date | null;
}

export interface DomainUpdateInput {
  spfOk?: boolean;
  dkimOk?: boolean;
  dmarcPolicy?: string | null;
  trackingCnameOk?: boolean;
  warmupStartedAt?: Date | null;
  status?: SendingDomainStatus;
}

export interface DomainStore {
  create(workspaceId: string, input: DomainCreateInput): Promise<SendingDomain>;
  get(id: string, workspaceId: string): Promise<SendingDomain | null>;
  getByDomain(workspaceId: string, domain: string): Promise<SendingDomain | null>;
  list(workspaceId: string): Promise<SendingDomain[]>;
  update(id: string, workspaceId: string, input: DomainUpdateInput): Promise<SendingDomain>;
}

type DomainLike = Pick<
  SendingDomain,
  "domain" | "isPrimary" | "spfOk" | "dkimOk" | "dmarcPolicy" | "warmupStartedAt" | "warmupStage" | "trackingCnameOk"
>;

/** Days since warmupStartedAt (0 when never started). */
export function warmupDays(d: Pick<DomainLike, "warmupStartedAt">, now = new Date()): number {
  if (!d.warmupStartedAt) return 0;
  return Math.max(0, Math.floor((now.getTime() - d.warmupStartedAt.getTime()) / 86_400_000));
}

const GMAIL_FREE = new Set(["gmail.com", "googlemail.com"]);

/** Build the guard input from a domain row (derives isGmailFree + warmupStage). */
export function checklistInputFor(d: DomainLike, now = new Date()): SendingDomainChecklistInput {
  return {
    domain: d.domain,
    isPrimary: d.isPrimary,
    spfOk: d.spfOk,
    dkimOk: d.dkimOk,
    dmarcPolicy: d.dmarcPolicy,
    warmupStartedAt: d.warmupStartedAt,
    warmupStage: warmupDays(d, now),
    trackingCnameOk: d.trackingCnameOk,
    isGmailFree: GMAIL_FREE.has(d.domain.toLowerCase()),
  };
}

/** Evaluate a domain against the depth-3 enablement checklist (pure). */
export function evaluateDomain(d: DomainLike, now = new Date()): { failures: ChecklistFailure[]; ready: boolean } {
  const failures = depth3Checklist(checklistInputFor(d, now));
  return { failures, ready: failures.length === 0 };
}

/** Assert depth-3 enablement for a domain row; throws naming every missing item. */
export function assertDepth3EnabledSafe(d: DomainLike, now = new Date()): void {
  assertDepth3Enabled(checklistInputFor(d, now));
}

/** Derive the lifecycle status from checklist state (pure). */
export function statusFor(d: DomainLike, now = new Date()): SendingDomainStatus {
  if (d.isPrimary) return "blocked"; // primary domains never cold-send; parked here visibly
  const { ready } = evaluateDomain(d, now);
  if (ready) return "ready";
  if (d.warmupStartedAt && warmupDays(d, now) < MIN_WARMUP_DAYS) return "warming";
  return "pending";
}

// ---------------------------------------------------------------------------
// Prisma store
// ---------------------------------------------------------------------------

export function prismaDomainStore(): DomainStore {
  async function scoped(id: string, workspaceId: string) {
    const d = await prisma.sendingDomain.findFirst({ where: { id, workspaceId } });
    if (!d) throw new Error("Sending domain not found in workspace.");
    return d;
  }
  return {
    async create(workspaceId, input) {
      const warmupStartedAt = input.warmupStartedAt ?? null;
      const d = await prisma.sendingDomain.create({
        data: {
          id: createId(),
          workspaceId,
          domain: input.domain.trim().toLowerCase(),
          isPrimary: input.isPrimary ?? false,
          spfOk: input.spfOk ?? false,
          dkimOk: input.dkimOk ?? false,
          dmarcPolicy: input.dmarcPolicy ?? null,
          trackingCnameOk: input.trackingCnameOk ?? false,
          warmupStartedAt,
          warmupStage: warmupDays({ warmupStartedAt }),
          status: "pending",
        },
      });
      // Recompute status from checklist state right after create.
      const status = statusFor(d);
      if (status !== d.status) return prisma.sendingDomain.update({ where: { id: d.id }, data: { status } });
      return d;
    },
    get: (id, workspaceId) => prisma.sendingDomain.findFirst({ where: { id, workspaceId } }),
    getByDomain: (workspaceId, domain) =>
      prisma.sendingDomain.findFirst({ where: { workspaceId, domain: domain.trim().toLowerCase() } }),
    list: (workspaceId) => prisma.sendingDomain.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }),
    async update(id, workspaceId, input) {
      const cur = await scoped(id, workspaceId);
      const next = { ...cur, ...input, warmupStartedAt: input.warmupStartedAt !== undefined ? input.warmupStartedAt : cur.warmupStartedAt };
      const data = {
        ...input,
        warmupStage: warmupDays({ warmupStartedAt: next.warmupStartedAt }),
        status: input.status ?? statusFor(next),
      };
      return prisma.sendingDomain.update({ where: { id }, data });
    },
  };
}

// ---------------------------------------------------------------------------
// Memory store (battery twin)
// ---------------------------------------------------------------------------

export function createMemoryDomainStore(): DomainStore {
  const rows = new Map<string, SendingDomain>();
  function scoped(id: string, workspaceId: string): SendingDomain {
    const d = rows.get(id);
    if (!d || d.workspaceId !== workspaceId) throw new Error("Sending domain not found in workspace.");
    return d;
  }
  return {
    async create(workspaceId, input) {
      const warmupStartedAt = input.warmupStartedAt ?? null;
      const d = {
        id: createId(), workspaceId, domain: input.domain.trim().toLowerCase(),
        isPrimary: input.isPrimary ?? false, spfOk: input.spfOk ?? false,
        dkimOk: input.dkimOk ?? false, dmarcPolicy: input.dmarcPolicy ?? null,
        warmupStartedAt, warmupStage: warmupDays({ warmupStartedAt }),
        trackingCnameOk: input.trackingCnameOk ?? false, status: "pending" as SendingDomainStatus,
        createdAt: new Date(),
      } satisfies SendingDomain;
      d.status = statusFor(d);
      rows.set(d.id, d);
      return d;
    },
    async get(id, workspaceId) {
      const d = rows.get(id);
      return d && d.workspaceId === workspaceId ? d : null;
    },
    async getByDomain(workspaceId, domain) {
      const key = domain.trim().toLowerCase();
      return [...rows.values()].find((d) => d.workspaceId === workspaceId && d.domain === key) ?? null;
    },
    async list(workspaceId) {
      return [...rows.values()].filter((d) => d.workspaceId === workspaceId);
    },
    async update(id, workspaceId, input) {
      const cur = scoped(id, workspaceId);
      const next = { ...cur, ...input, warmupStartedAt: input.warmupStartedAt !== undefined ? input.warmupStartedAt : cur.warmupStartedAt };
      next.warmupStage = warmupDays({ warmupStartedAt: next.warmupStartedAt });
      next.status = input.status ?? statusFor(next);
      rows.set(id, next);
      return next;
    },
  };
}
