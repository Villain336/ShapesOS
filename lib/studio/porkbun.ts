// Marketr — Porkbun API v3 port (milestone 22).
//
// API surface (verified against the Porkbun v3 OpenAPI spec, Sept 2026):
//   Base:   https://api.porkbun.com/api/json/v3
//   Auth:   headers X-API-Key / X-Secret-API-Key (body auth also accepted).
//   POST /domain/checkDomain/{domain} → { status, response: { avail: "yes"|"no",
//     price, regularPrice, premium, minDuration, additional: { renewal: { price } } } }
//   POST /pricing/get → { status, pricing: { <tld>: { registration, renewal, transfer } } }
//     — the ONLY endpoint that needs no auth.
//   POST /domain/create/{domain} → synchronous registration. Body: { cost
//     (integer pennies, MUST equal current price), agreeToTerms: "yes",
//     whoisPrivacy?: bool, dryRun?: true }.
//   GET /domain/listAll?start=N → { status, domains: [{ domain, tld, status,
//     createDate, expireDate, securityLock, whoisPrivacy, autoRenew }] }
// Caveats (documented, not resolved here):
//   1. Registrations use the ACCOUNT's default registrant contact — the API
//      takes NO contact fields. Marketr still collects registrant info for
//      review + ICANN disclosure, and the purchase is blocked until it is
//      complete (server-side).
//   2. Premium domains cannot be registered via the API.
//   3. At least one prior registration and verified account email+phone are
//      required before /domain/create works on a fresh account.
//   4. Default rate limit: 1 availability check / 10s / account (429 carries
//      Retry-After). The service never fans out bulk checks in parallel.
//   5. Purchases are real money. ICANN verification obligations apply to the
//      registrant email — the UI must disclose this before purchase.
//   6. Porkbun sandbox keys (pk1_sb_/sk1_sb_) exist for safe end-to-end
//      testing — first live verification should use the sandbox, not a
//      production purchase.

export const PORKBUN_API_BASE = "https://api.porkbun.com/api/json/v3";

export interface DomainAvailability {
  domain: string;
  tld: string;
  available: boolean;
  priceUsd: number | null;
  renewalPriceUsd: number | null;
  premium: boolean;
  minDuration: number;
}

export interface TldPricing {
  tld: string;
  registrationUsd: number;
  renewalUsd: number;
  transferUsd: number;
}

export interface PorkbunDomain {
  domain: string;
  tld: string;
  status: string;
  createDate: string | null;
  expireDate: string | null;
  whoisPrivacy: boolean;
  autoRenew: boolean;
  nameServers: string[];
}

export interface DomainPurchase {
  domain: string;
  orderId: string;
  costUsd: number;
  balanceAfterUsd: number | null;
}

export interface PorkbunKeys {
  apiKey: string;
  secretApiKey: string;
}

/** Injectable port — production API wrapper or MockPorkbunPort for tests. */
export interface PorkbunPort {
  /** Single-domain availability check (rate-limited by Porkbun — call sparingly). */
  checkDomain(domain: string): Promise<DomainAvailability>;
  /** Public TLD pricing (no auth required by Porkbun; port handles auth anyway). */
  getPricing(tlds?: string[]): Promise<TldPricing[]>;
  /** List domains in the Porkbun account. */
  listDomains(start?: number): Promise<{ domains: PorkbunDomain[]; total: number }>;
  /** Synchronous registration. dryRun validates without charging. */
  createDomain(params: {
    domain: string;
    costCents: number;
    agreeToTerms: boolean;
    whoisPrivacy: boolean;
    dryRun?: boolean;
  }): Promise<DomainPurchase>;
  /** Get nameservers for a registered domain. */
  getNameServers(domain: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Production wrapper — real HTTPS calls. Used only when real keys are
// configured. All verification in this milestone runs against MockPorkbunPort.
// ---------------------------------------------------------------------------

function porkbunHeaders(keys: PorkbunKeys): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-API-Key": keys.apiKey,
    "X-Secret-API-Key": keys.secretApiKey,
  };
}

async function porkbunFetch(
  keys: PorkbunKeys,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${PORKBUN_API_BASE}${path}`, {
    method: "POST",
    headers: porkbunHeaders(keys),
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (json.status !== "SUCCESS") {
    const msg = typeof json.message === "string" ? json.message : `Porkbun API error on ${path}`;
    const err = new Error(msg);
    (err as { statusCode?: number }).statusCode = res.status;
    throw err;
  }
  return json;
}

function tldOf(domain: string): string {
  const parts = domain.toLowerCase().split(".");
  return parts.length > 1 ? parts.slice(1).join(".") : "";
}

export function createPorkbunPort(keys: PorkbunKeys): PorkbunPort {
  return {
    async checkDomain(domain) {
      const json = await porkbunFetch(keys, `/domain/checkDomain/${encodeURIComponent(domain)}`, {});
      const r = (json.response ?? {}) as Record<string, unknown>;
      const additional = (r.additional ?? {}) as Record<string, unknown>;
      const renewal = (additional.renewal ?? {}) as Record<string, unknown>;
      return {
        domain: domain.toLowerCase(),
        tld: tldOf(domain),
        available: r.avail === "yes",
        priceUsd: r.price != null ? Number(r.price) : null,
        renewalPriceUsd: renewal.price != null ? Number(renewal.price) : null,
        premium: r.premium === "yes",
        minDuration: Number(r.minDuration ?? 1),
      };
    },
    async getPricing(tlds) {
      const json = await porkbunFetch(keys, "/pricing/get", tlds ? { tlds } : {});
      const pricing = (json.pricing ?? {}) as Record<string, Record<string, string>>;
      return Object.entries(pricing).map(([tld, p]) => ({
        tld,
        registrationUsd: Number(p.registration ?? 0),
        renewalUsd: Number(p.renewal ?? 0),
        transferUsd: Number(p.transfer ?? 0),
      }));
    },
    async listDomains(start = 0) {
      const res = await fetch(`${PORKBUN_API_BASE}/domain/listAll?start=${start}`, {
        method: "GET",
        headers: porkbunHeaders(keys),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (json.status !== "SUCCESS") throw new Error("Porkbun domain list failed.");
      const domains = (json.domains ?? []) as Array<Record<string, unknown>>;
      return {
        domains: domains.map((d) => ({
          domain: String(d.domain),
          tld: String(d.tld ?? tldOf(String(d.domain))),
          status: String(d.status ?? ""),
          createDate: d.createDate != null ? String(d.createDate) : null,
          expireDate: d.expireDate != null ? String(d.expireDate) : null,
          whoisPrivacy: d.whoisPrivacy === "1" || d.whoisPrivacy === true,
          autoRenew: d.autoRenew === "1" || d.autoRenew === true,
          nameServers: Array.isArray(d.nameServers) ? d.nameServers.map(String) : [],
        })),
        total: Number(json.total ?? domains.length),
      };
    },
    async createDomain({ domain, costCents, agreeToTerms, whoisPrivacy, dryRun }) {
      if (!agreeToTerms) throw new Error("You must agree to the terms to register a domain.");
      const json = await porkbunFetch(keys, `/domain/create/${encodeURIComponent(domain)}`, {
        cost: costCents,
        agreeToTerms: "yes",
        whoisPrivacy,
        ...(dryRun ? { dryRun: true } : {}),
      });
      if (dryRun) {
        // DryRunPreviewResponse — validate the preview without charging.
        return {
          domain,
          orderId: "",
          costUsd: costCents / 100,
          balanceAfterUsd: null,
        };
      }
      return {
        domain,
        orderId: String(json.orderId ?? ""),
        costUsd: Number(json.cost ?? costCents) / 100,
        balanceAfterUsd: json.balance != null ? Number(json.balance) : null,
      };
    },
    async getNameServers(domain) {
      const json = await porkbunFetch(keys, `/dns/retrieve/${encodeURIComponent(domain)}`, {});
      const ns = (json.ns ?? []) as unknown[];
      if (Array.isArray(ns)) return ns.map(String);
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Mock port — deterministic, zero network. All M22 verification runs on it.
// ---------------------------------------------------------------------------

export interface MockPorkbunOptions {
  failNext?: number;
  failMessage?: string;
}

export function createMockPorkbunPort(opts: MockPorkbunOptions = {}): PorkbunPort & {
  calls: Array<{ method: string; args: unknown }>;
} {
  const calls: Array<{ method: string; args: unknown }> = [];
  const maybeFail = (method: string) => {
    if ((opts.failNext ?? 0) > 0) {
      opts.failNext = (opts.failNext ?? 0) - 1;
      throw new Error(opts.failMessage ?? `Mock Porkbun failure in ${method}`);
    }
  };

  return {
    calls,
    async checkDomain(domain) {
      calls.push({ method: "checkDomain", args: { domain } });
      maybeFail("checkDomain");
      const d = domain.toLowerCase();
      const tld = tldOf(d);
      // Deterministic: fixtures containing "available" are available;
      // fixtures containing "premium" are registry-premium names.
      const available = d.includes("available");
      const premium = d.includes("premium");
      return {
        domain: d,
        tld,
        available,
        priceUsd: available ? 11.08 : null,
        renewalPriceUsd: available ? 11.08 : null,
        premium,
        minDuration: 1,
      };
    },
    async getPricing(tlds) {
      calls.push({ method: "getPricing", args: { tlds } });
      maybeFail("getPricing");
      const base: TldPricing[] = [
        { tld: "com", registrationUsd: 11.08, renewalUsd: 11.08, transferUsd: 11.08 },
        { tld: "io", registrationUsd: 28.12, renewalUsd: 51.8, transferUsd: 51.8 },
        { tld: "xyz", registrationUsd: 2.04, renewalUsd: 12.98, transferUsd: 12.98 },
      ];
      if (!tlds || tlds.length === 0) return base;
      const set = new Set(tlds.map((t) => t.toLowerCase().replace(/^\./, "")));
      return base.filter((p) => set.has(p.tld));
    },
    async listDomains(_start = 0) {
      calls.push({ method: "listDomains", args: {} });
      return {
        domains: [
          {
            domain: "mock-example.com",
            tld: "com",
            status: "ACTIVE",
            createDate: "2025-01-01",
            expireDate: "2027-01-01",
            whoisPrivacy: true,
            autoRenew: true,
            nameServers: ["ns1.mock.example", "ns2.mock.example"],
          },
        ],
        total: 1,
      };
    },
    async createDomain({ domain, costCents, agreeToTerms, whoisPrivacy, dryRun }) {
      calls.push({ method: "createDomain", args: { domain, costCents, agreeToTerms, whoisPrivacy, dryRun } });
      maybeFail("createDomain");
      if (!agreeToTerms) throw new Error("You must agree to the terms to register a domain.");
      const d = domain.toLowerCase();
      if (d.includes("premium")) throw new Error("Premium domains cannot be registered via the API.");
      return {
        domain: d,
        orderId: dryRun ? "" : "MOCK-ORDER-1",
        costUsd: costCents / 100,
        balanceAfterUsd: 990.0,
      };
    },
    async getNameServers(domain) {
      calls.push({ method: "getNameServers", args: { domain } });
      return ["ns1.mock.example", "ns2.mock.example"];
    },
  };
}
