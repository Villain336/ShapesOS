// Marketr — Phase 6 O1 outreach engine: prospect discovery + opportunity scoring.
//
// Discovery fixtures: fake SERP "write for us" discovery + fake Hunter.io
// email finding. The real Hunter adapter throws NotConfiguredError without
// HUNTER_API_KEY (fake mode is the default).
// Scoring 0–100: domain quality (40) + topical relevance (40) + traffic (10)
// + outbound-link hygiene (10), with an "accepts guest posts" confidence
// multiplier. Threshold is configurable per campaign (default 60).

import { prisma } from "@/lib/prisma";
import { createId } from "@/lib/media/ids";
import { NotConfiguredError } from "@/lib/authority/fake";
import { fakeProvidersAllowed } from "@/lib/env/secrets";
import type { OutreachProspect, ProspectStatus } from "@prisma/client";

export interface ProspectStore {
  createMany(workspaceId: string, campaignId: string, rows: DiscoveredProspect[]): Promise<OutreachProspect[]>;
  get(id: string, workspaceId: string): Promise<OutreachProspect | null>;
  list(workspaceId: string, campaignId?: string, status?: ProspectStatus): Promise<OutreachProspect[]>;
  update(id: string, workspaceId: string, data: Partial<OutreachProspect>): Promise<OutreachProspect>;
}

export interface DiscoveredProspect {
  domain: string;
  url: string;
  contactName?: string;
  email?: string;
  emailVerified?: boolean;
  qualityScore: number;
  relevanceScore: number;
}

// ---------------------------------------------------------------------------
// Fake SERP discovery fixture
// ---------------------------------------------------------------------------

const FIXTURE_SITES = [
  { domain: "growthmarketing.blog", accepts: 0.95, dr: 58, traffic: 120_000, hygiene: 0.9, relevance: 0.92 },
  { domain: "saasplaybook.io", accepts: 0.9, dr: 44, traffic: 65_000, hygiene: 0.85, relevance: 0.88 },
  { domain: "contentcrafters.co", accepts: 0.98, dr: 37, traffic: 28_000, hygiene: 0.8, relevance: 0.95 },
  { domain: "startupfieldnotes.com", accepts: 0.85, dr: 52, traffic: 90_000, hygiene: 0.75, relevance: 0.8 },
  { domain: "b2bgrowthlab.net", accepts: 0.8, dr: 41, traffic: 40_000, hygiene: 0.88, relevance: 0.85 },
  { domain: "marketingletters.org", accepts: 0.92, dr: 49, traffic: 75_000, hygiene: 0.7, relevance: 0.78 },
  { domain: "indiehacker.press", accepts: 0.75, dr: 33, traffic: 18_000, hygiene: 0.95, relevance: 0.9 },
  { domain: "seostrategist.blog", accepts: 0.88, dr: 46, traffic: 55_000, hygiene: 0.82, relevance: 0.86 },
];

/**
 * Fake SERP discovery for `"write for us" / "guest post" / contributor guidelines`
 * + niche queries. Returns scored fixture prospects (deterministic).
 */
export function fakeSerpDiscovery(query: string, niche: string): Omit<DiscoveredProspect, "email" | "emailVerified" | "contactName">[] {
  void query; // fixture is deterministic; a real SERP adapter would rank by query
  return FIXTURE_SITES.slice(0, 8).map((s) => {
      const qualityScore = Math.round(Math.min(100, (s.dr / 70) * 100 * 0.6 + s.hygiene * 40));
      const relevanceScore = Math.round(s.relevance * 100 * (niche ? 1 : 0.85));
      return {
        domain: s.domain,
        url: `https://${s.domain}/write-for-us`,
        qualityScore: Math.min(100, qualityScore),
        relevanceScore: Math.min(100, relevanceScore),
      };
    });
}

// ---------------------------------------------------------------------------
// Hunter.io email finding (fake default; real throws NotConfiguredError)
// ---------------------------------------------------------------------------

export interface HunterAdapter {
  readonly name: string;
  findEmail(domain: string, firstName?: string, lastName?: string): Promise<{ email: string; verified: boolean; confidence: number }>;
}

/** Fake Hunter: deterministic pattern-based email finding + verification. */
export function createFakeHunterAdapter(): HunterAdapter {
  return {
    name: "fake-hunter",
    async findEmail(domain, firstName, lastName) {
      const local = firstName && lastName
        ? `${firstName.toLowerCase()}.${lastName.toLowerCase()}`
        : "editor";
      return { email: `${local}@${domain}`, verified: true, confidence: 0.87 };
    },
  };
}

/** Resolve the adapter: fake by default; a real key without an implemented
 *  adapter throws the honest NotConfiguredError. */
export function resolveHunterAdapter(cfg: { apiKey?: string | null; fake?: boolean }): HunterAdapter {
  // Phase 11 (conncore): fixture mode is refused in production.
  if ((cfg.fake === true || !cfg.apiKey) && fakeProvidersAllowed()) return createFakeHunterAdapter();
  if (cfg.fake === true || !cfg.apiKey) {
    throw new NotConfiguredError("Hunter.io", "Hunter.io is not connected — fixture prospects are never used in production.");
  }
  throw new NotConfiguredError("Hunter.io", "the real Hunter.io adapter is not implemented in this build — unset HUNTER_API_KEY to use fixture mode.");
}

// ---------------------------------------------------------------------------
// Opportunity scoring (pure, 0–100)
// ---------------------------------------------------------------------------

export interface ScoreInput {
  /** Domain quality 0–100 (DR-style). */
  domainQuality: number;
  /** Topical relevance 0–100 (embedding similarity to client niche). */
  relevance: number;
  /** Monthly traffic estimate. */
  traffic: number;
  /** Outbound-link hygiene 0–1 (1 = clean). */
  hygiene: number;
  /** "Accepts guest posts" signal confidence 0–1. */
  acceptsGuestPosts: number;
}

/** Weighted 0–100 opportunity score. The accepts-guest-posts signal gates:
 *  below 0.5 confidence the score is halved (not worth pitching). */
export function scoreProspect(input: ScoreInput): number {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  const quality = clamp(input.domainQuality, 0, 100) * 0.4;
  const relevance = clamp(input.relevance, 0, 100) * 0.4;
  const traffic = Math.min(100, Math.log10(Math.max(1, input.traffic) + 1) * 22) * 0.1;
  const hygiene = clamp(input.hygiene, 0, 1) * 100 * 0.1;
  let total = quality + relevance + traffic + hygiene;
  if (input.acceptsGuestPosts < 0.5) total *= 0.5;
  return Math.round(clamp(total, 0, 100));
}

// ---------------------------------------------------------------------------
// Discovery + qualification orchestration (store-agnostic)
// ---------------------------------------------------------------------------

export const DEFAULT_QUALIFY_THRESHOLD = 60;

export async function discoverProspects(
  store: ProspectStore,
  opts: { workspaceId: string; campaignId: string; query: string; niche: string; actor: string },
): Promise<OutreachProspect[]> {
  const hunter = resolveHunterAdapter({ fake: true });
  const found = fakeSerpDiscovery(opts.query, opts.niche);
  const rows: DiscoveredProspect[] = [];
  for (const f of found) {
    const contact = await hunter.findEmail(f.domain);
    rows.push({ ...f, contactName: "Editorial Team", email: contact.email, emailVerified: contact.verified });
  }
  return store.createMany(opts.workspaceId, opts.campaignId, rows);
}

/** Qualify a prospect when its combined score meets the campaign threshold. */
export async function qualifyProspect(
  store: ProspectStore,
  opts: { workspaceId: string; prospectId: string; threshold?: number; actor: string },
): Promise<OutreachProspect> {
  const p = await store.get(opts.prospectId, opts.workspaceId);
  if (!p) throw new Error("Prospect not found in workspace.");
  if (p.status !== "new") throw new Error(`Prospect is already ${p.status}; only new prospects can be qualified.`);
  const threshold = opts.threshold ?? DEFAULT_QUALIFY_THRESHOLD;
  const combined = Math.round(p.qualityScore * 0.5 + p.relevanceScore * 0.5);
  if (combined < threshold) {
    throw new Error(`Prospect scored ${combined}; threshold is ${threshold} — not qualified.`);
  }
  return store.update(p.id, opts.workspaceId, { status: "qualified" });
}

// ---------------------------------------------------------------------------
// Prisma store
// ---------------------------------------------------------------------------

export function prismaProspectStore(): ProspectStore {
  async function scoped(id: string, workspaceId: string) {
    const p = await prisma.outreachProspect.findFirst({ where: { id, workspaceId } });
    if (!p) throw new Error("Prospect not found in workspace.");
    return p;
  }
  return {
    async createMany(workspaceId, campaignId, rows) {
      await prisma.outreachProspect.createMany({
        data: rows.map((r) => ({
          id: createId(), workspaceId, campaignId,
          domain: r.domain, url: r.url,
          contactName: r.contactName ?? null, email: r.email ?? null,
          emailVerified: r.emailVerified ?? false,
          qualityScore: r.qualityScore, relevanceScore: r.relevanceScore,
          status: "new",
        })),
      });
      return prisma.outreachProspect.findMany({ where: { workspaceId, campaignId }, orderBy: { createdAt: "desc" }, take: rows.length * 2 });
    },
    get: (id, workspaceId) => prisma.outreachProspect.findFirst({ where: { id, workspaceId } }),
    list: (workspaceId, campaignId, status) =>
      prisma.outreachProspect.findMany({
        where: { workspaceId, ...(campaignId ? { campaignId } : {}), ...(status ? { status } : {}) },
        orderBy: { qualityScore: "desc" },
        take: 200,
      }),
    async update(id, workspaceId, data) {
      await scoped(id, workspaceId);
      return prisma.outreachProspect.update({ where: { id }, data });
    },
  };
}

// ---------------------------------------------------------------------------
// Memory store (battery twin)
// ---------------------------------------------------------------------------

export function createMemoryProspectStore(): ProspectStore {
  const rows = new Map<string, OutreachProspect>();
  function scoped(id: string, workspaceId: string): OutreachProspect {
    const p = rows.get(id);
    if (!p || p.workspaceId !== workspaceId) throw new Error("Prospect not found in workspace.");
    return p;
  }
  return {
    async createMany(workspaceId, campaignId, discovered) {
      const created = discovered.map((r) => ({
        id: createId(), workspaceId, campaignId, domain: r.domain, url: r.url,
        contactName: r.contactName ?? null, email: r.email ?? null,
        emailVerified: r.emailVerified ?? false, qualityScore: r.qualityScore,
        relevanceScore: r.relevanceScore, status: "new" as ProspectStatus, createdAt: new Date(),
      }) satisfies OutreachProspect);
      for (const c of created) rows.set(c.id, c);
      return created;
    },
    async get(id, workspaceId) {
      const p = rows.get(id);
      return p && p.workspaceId === workspaceId ? p : null;
    },
    async list(workspaceId, campaignId, status) {
      return [...rows.values()].filter(
        (p) => p.workspaceId === workspaceId && (!campaignId || p.campaignId === campaignId) && (!status || p.status === status),
      );
    },
    async update(id, workspaceId, data) {
      const cur = scoped(id, workspaceId);
      const next = { ...cur, ...data };
      rows.set(id, next);
      return next;
    },
  };
}
