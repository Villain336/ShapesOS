// Marketr — Phase 6 O1 outreach engine: deliverability monitoring.
//
// Fake Postmaster-style reputation monitor (spam rate, bounce rate, warmup
// stage per domain). The real Google Postmaster Tools API requires OAuth +
// domain verification — the fake returns deterministic per-domain metrics so
// the dashboard and batteries have a stable surface; real event-derived
// bounce rates are blended in from the sequence store.

import { SPAM_CEILING_PCT, BOUNCE_PAUSE_PCT, BOUNCE_STOP_PCT, MIN_WARMUP_DAYS } from "@/lib/authority/guards";
import { warmupDays, checklistInputFor, evaluateDomain, type DomainStore } from "./domains";
import type { SequenceStore } from "./sequences";
import type { SendingDomain } from "@prisma/client";

export interface DeliverabilityDeps {
  domains: DomainStore;
  sequences: SequenceStore;
}

export type Reputation = "high" | "medium" | "low" | "bad";

export interface DomainDeliverability {
  domainId: string;
  domain: string;
  reputation: Reputation;
  spamRatePct: number;
  spamCeilingPct: number;
  spamOk: boolean;
  bounceRatePct: number;
  bounceStatus: "healthy" | "pause" | "stop";
  warmupDays: number;
  warmupRequiredDays: number;
  warmupOk: boolean;
  checklistFailures: { code: string; message: string }[];
  status: string;
}

/** Deterministic fake spam rate (0.02–0.08%) per seed — well under the ceiling. */
export function fakeSpamRatePct(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return 0.02 + (h % 60) / 1000; // 0.02%–0.079%
}

/** Deterministic fake reputation per domain id. */
function fakeReputation(domainId: string): Reputation {
  let h = 0;
  for (let i = 0; i < domainId.length; i += 1) h = (h * 33 + domainId.charCodeAt(i)) >>> 0;
  return (["high", "high", "medium", "high"] as Reputation[])[h % 4];
}

function bounceStatusFor(pct: number): "healthy" | "pause" | "stop" {
  if (pct > BOUNCE_STOP_PCT) return "stop";
  if (pct >= BOUNCE_PAUSE_PCT) return "pause";
  return "healthy";
}

async function campaignIdsForDomain(workspaceId: string, domainId: string, campaigns: { list(w: string): Promise<{ id: string; sendingDomainId: string | null }[]> }): Promise<string[]> {
  const all = await campaigns.list(workspaceId);
  return all.filter((c) => c.sendingDomainId === domainId).map((c) => c.id);
}

export async function deliverabilityForDomain(
  deps: DeliverabilityDeps & { campaigns: { list(w: string): Promise<{ id: string; sendingDomainId: string | null }[]> } },
  workspaceId: string,
  domain: SendingDomain,
): Promise<DomainDeliverability> {
  const wd = warmupDays({ warmupStartedAt: domain.warmupStartedAt });
  const { failures } = evaluateDomain(domain);
  const campaignIds = await campaignIdsForDomain(workspaceId, domain.id, deps.campaigns);
  // Blend: real bounce rates from campaign events (0 when nothing sent yet).
  let bounceSum = 0;
  for (const cid of campaignIds) bounceSum += await deps.sequences.bounceRatePct(workspaceId, cid);
  const bounceRatePct = campaignIds.length ? bounceSum / campaignIds.length : 0;
  const spamRatePct = fakeSpamRatePct(domain.id);
  return {
    domainId: domain.id,
    domain: domain.domain,
    reputation: domain.isPrimary ? "bad" : fakeReputation(domain.id),
    spamRatePct: Math.round(spamRatePct * 1000) / 1000,
    spamCeilingPct: SPAM_CEILING_PCT,
    spamOk: spamRatePct < SPAM_CEILING_PCT,
    bounceRatePct: Math.round(bounceRatePct * 100) / 100,
    bounceStatus: bounceStatusFor(bounceRatePct),
    warmupDays: wd,
    warmupRequiredDays: MIN_WARMUP_DAYS,
    warmupOk: wd >= MIN_WARMUP_DAYS,
    checklistFailures: failures,
    status: domain.status,
  };
}

export async function deliverabilityForWorkspace(
  deps: DeliverabilityDeps & { campaigns: { list(w: string): Promise<{ id: string; sendingDomainId: string | null }[]> } },
  workspaceId: string,
): Promise<DomainDeliverability[]> {
  const domains = await deps.domains.list(workspaceId);
  const out: DomainDeliverability[] = [];
  for (const d of domains) out.push(await deliverabilityForDomain(deps, workspaceId, d));
  return out;
}
