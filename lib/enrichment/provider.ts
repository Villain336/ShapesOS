// Marketr — prospect enrichment provider abstraction (R6).
//
// Mirrors lib/calls/provider.ts: an interface + fake (tests/dev) + real
// providers behind env switches, with honest not-configured errors.
// This is a WATERFALL enrichment + list-building + research layer over
// pluggable providers — NOT a proprietary contact database.
//
// Provider contract:
// - lookup({ email?, phone?, company?, website?, name? }) → EnrichmentResult
//   (hit flag, normalized firmographics/contact, vendor cost in cents).
// - A provider returns { hit: false } on a clean miss; it throws only on
//   transport/auth/config failures (the waterfall records those as "error").
// - Real providers construct from env and throw
//   EnrichmentProviderNotConfiguredError when their keys are absent.
//
// Verified endpoint shapes (2026-09-24, from each provider's public docs):
// - Apollo:  POST https://api.apollo.io/api/v1/people/match
//            auth:  header `x-api-key: <APOLLO_API_KEY>`
//            body:  JSON { name | first_name/last_name, email, domain,
//                          organization_name, reveal_personal_emails, ... }
//            docs:  https://docs.apollo.io/reference/people-enrichment
// - Hunter:  GET  https://api.hunter.io/v2/email-finder
//                  ?domain=<domain>&first_name=..&last_name=..&api_key=<key>
//            docs:  https://hunter.io/api-documentation/v2#email-finder
// Re-verify these against the docs if lookups start failing — providers
// change their APIs without notice.

import { createHash } from "node:crypto";

export interface EnrichmentCompany {
  name?: string;
  website?: string;
  domain?: string;
  industry?: string;
  employeeCount?: number;
  employeeRange?: string;
  location?: string;
  description?: string;
  technologies?: string[];
  foundedYear?: number;
  linkedinUrl?: string;
}

export interface EnrichmentContact {
  name?: string;
  title?: string;
  email?: string;
  phone?: string;
  seniority?: string;
  department?: string;
  linkedinUrl?: string;
  /** Provider's own confidence (0–100) when the provider reports one. */
  confidence?: number;
}

export interface EnrichmentResult {
  hit: boolean;
  company?: EnrichmentCompany;
  contact?: EnrichmentContact;
  /** Vendor cost for this lookup in USD cents (0 = free/trial/fake). */
  costCents: number;
  raw?: unknown;
}

export interface EnrichmentLookupInput {
  email?: string;
  phone?: string;
  company?: string;
  website?: string;
  /** Contact full name — used by name+domain providers (e.g. Hunter). */
  name?: string;
}

export interface EnrichmentProvider {
  readonly name: string;
  lookup(input: EnrichmentLookupInput): Promise<EnrichmentResult>;
}

export class EnrichmentProviderNotConfiguredError extends Error {
  constructor(provider: string, missing: string) {
    super(`${provider} provider is not configured (missing ${missing})`);
    this.name = "EnrichmentProviderNotConfiguredError";
  }
}

// ---------------------------------------------------------------------------
// Fake provider (tests, dev, and the default in this environment).
// Deterministic fixtures keyed off a hash of the normalized input, so the
// battery can assert on exact outputs. Cost is always 0.
// ---------------------------------------------------------------------------

const FAKE_INDUSTRIES = [
  "SaaS / Software",
  "Marketing & Advertising",
  "Professional Services",
  "Healthcare",
  "Financial Services",
  "Real Estate",
  "E-commerce",
  "Manufacturing",
] as const;

const FAKE_RANGES = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000"] as const;

const FAKE_CITIES = [
  "Austin, TX",
  "Charlotte, NC",
  "Raleigh, NC",
  "Denver, CO",
  "Nashville, TN",
  "Atlanta, GA",
  "Chicago, IL",
  "Phoenix, AZ",
] as const;

const FAKE_TECH = [
  ["HubSpot", "Salesforce", "Slack"],
  ["WordPress", "Shopify", "Klaviyo"],
  ["AWS", "Stripe", "Zendesk"],
  ["Google Workspace", "Asana", "Mailchimp"],
] as const;

function hashInput(input: EnrichmentLookupInput): bigint {
  const key = [input.email, input.phone, input.company, input.website, input.name]
    .map((v) => (v ?? "").trim().toLowerCase())
    .join("|");
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return BigInt(`0x${hex}`);
}

function pick<T>(arr: readonly T[], h: bigint, salt: bigint): T {
  return arr[Number((h + salt) % BigInt(arr.length))];
}

function domainFromWebsite(website: string): string | undefined {
  const m = website
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .replace(/^www\./, "");
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(m) ? m : undefined;
}

function titleCaseDomain(domain: string): string {
  const base = domain.split(".")[0].replace(/[-_]/g, " ");
  return base.replace(/\b\w/g, (c) => c.toUpperCase());
}

export class FakeEnrichmentProvider implements EnrichmentProvider {
  readonly name = "fake";

  async lookup(input: EnrichmentLookupInput): Promise<EnrichmentResult> {
    const hasSignal = [input.email, input.phone, input.company, input.website].some(
      (v) => (v ?? "").trim().length > 0,
    );
    if (!hasSignal) return { hit: false, costCents: 0 };

    const h = hashInput(input);
    const domain =
      (input.website ? domainFromWebsite(input.website) : undefined) ??
      (input.email?.includes("@") ? input.email.split("@")[1].toLowerCase() : undefined);
    const companyName =
      input.company?.trim() ||
      (domain ? `${titleCaseDomain(domain)} Inc` : "Acme Holdings");

    const range = pick(FAKE_RANGES, h, BigInt(1));
    const [lo, hi] = range.split("-").map(Number);
    const employeeCount = lo + Number(h % BigInt(Math.max(1, hi - lo)));

    const company: EnrichmentCompany = {
      name: companyName,
      website: input.website?.trim() || (domain ? `https://${domain}` : undefined),
      domain,
      industry: pick(FAKE_INDUSTRIES, h, BigInt(2)),
      employeeCount,
      employeeRange: range,
      location: pick(FAKE_CITIES, h, BigInt(3)),
      description: `${companyName} is a ${range}-employee ${pick(
        FAKE_INDUSTRIES,
        h,
        BigInt(2),
      ).toLowerCase()} company based in ${pick(FAKE_CITIES, h, BigInt(3))}.`,
      technologies: [...pick(FAKE_TECH, h, BigInt(4))],
      foundedYear: 2005 + Number(h % BigInt(19)),
    };

    const contact: EnrichmentContact | undefined = input.name?.trim()
      ? {
          name: input.name.trim(),
          title: pick(
            ["VP Marketing", "Head of Sales", "CEO", "Marketing Director", "Founder", "COO"] as const,
            h,
            BigInt(5),
          ),
          email: input.email?.trim() || (domain ? `${input.name.trim().split(/\s+/)[0].toLowerCase()}@${domain}` : undefined),
          phone: input.phone?.trim() || `+1${String(BigInt(2000000000) + (h % BigInt(8000000000)))}`,
          seniority: pick(["c_suite", "vp", "director", "manager"] as const, h, BigInt(6)),
          department: pick(["marketing", "sales", "executive", "operations"] as const, h, BigInt(7)),
        }
      : undefined;

    return { hit: true, company, contact, costCents: 0, raw: { fixture: true, seed: h.toString(16) } };
  }
}

// ---------------------------------------------------------------------------
// Apollo (real). Env: APOLLO_API_KEY. Not exercised without a key.
// ---------------------------------------------------------------------------

const APOLLO_BASE = "https://api.apollo.io/api/v1";

export class ApolloProvider implements EnrichmentProvider {
  readonly name = "apollo";
  private apiKey: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const key = (env.APOLLO_API_KEY ?? "").trim();
    if (!key) throw new EnrichmentProviderNotConfiguredError("apollo", "APOLLO_API_KEY");
    this.apiKey = key;
  }

  async lookup(input: EnrichmentLookupInput): Promise<EnrichmentResult> {
    // Apollo's People Enrichment matches on name / email / domain. It does
    // not do phone-number lookups, so a phone-only input is a clean miss.
    const domain =
      (input.website ? domainFromWebsite(input.website) : undefined) ??
      (input.email?.includes("@") ? input.email.split("@")[1].toLowerCase() : undefined);
    const hasMatchable =
      Boolean(input.name?.trim() || input.email?.trim() || domain || input.company?.trim());
    if (!hasMatchable) return { hit: false, costCents: 0 };

    const body: Record<string, unknown> = {
      reveal_personal_emails: true,
    };
    if (input.name?.trim()) body.name = input.name.trim();
    if (input.email?.trim()) body.email = input.email.trim();
    if (domain) body.domain = domain;
    if (input.company?.trim()) body.organization_name = input.company.trim();

    let res: Response;
    try {
      res = await fetch(`${APOLLO_BASE}/people/match`, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Apollo request failed: ${err instanceof Error ? err.message : err}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("Apollo rejected the API key (401/403) — check APOLLO_API_KEY.");
    }
    if (res.status === 429) {
      throw new Error("Apollo rate limit hit (429) — back off and retry.");
    }
    const json = (await res.json().catch(() => ({}))) as {
      person?: Record<string, unknown> | null;
      organization?: Record<string, unknown> | null;
    };
    if (!res.ok || !json.person) {
      // No match (Apollo returns 200 with person: null on a clean miss).
      return { hit: false, costCents: 0, raw: { status: res.status } };
    }
    const p = json.person;
    const org = (json.organization ?? p.organization ?? {}) as Record<string, unknown>;
    const person = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() ? v : undefined;

    return {
      hit: true,
      company: {
        name: person(org.name) ?? input.company?.trim(),
        website: person(org.website_url),
        domain: person(org.primary_domain) ?? domain,
        industry: person(org.industry),
        employeeCount: typeof org.estimated_num_employees === "number" ? org.estimated_num_employees : undefined,
        location: person(org.city)
          ? `${person(org.city)}${person(org.state) ? `, ${person(org.state)}` : ""}`
          : person(org.country),
        description: person(org.short_description),
        technologies: Array.isArray(org.technologies) ? org.technologies.map(String) : undefined,
        foundedYear: typeof org.founded_year === "number" ? org.founded_year : undefined,
        linkedinUrl: person(org.linkedin_url),
      },
      contact: {
        name: person(p.name),
        title: person(p.title),
        email: person(p.email),
        phone: person(p.sanitized_phone) ?? person(p.phone_number),
        seniority: person(p.seniority),
        department: person(
          Array.isArray(p.departments) ? (p.departments as unknown[])[0] : p.departments,
        ),
        linkedinUrl: person(p.linkedin_url),
      },
      // Apollo bills in Apollo credits (1–9 per matched person), not dollars.
      // costCents stays 0 here; the credit usage is on your Apollo invoice.
      // See https://docs.apollo.io/docs/api-pricing
      costCents: 0,
      raw: { match_confidence: p.match_confidence ?? null },
    };
  }
}

// ---------------------------------------------------------------------------
// Hunter (real). Env: HUNTER_API_KEY. Email finder by name + domain.
// ---------------------------------------------------------------------------

export class HunterProvider implements EnrichmentProvider {
  readonly name = "hunter";
  private apiKey: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const key = (env.HUNTER_API_KEY ?? "").trim();
    if (!key) throw new EnrichmentProviderNotConfiguredError("hunter", "HUNTER_API_KEY");
    this.apiKey = key;
  }

  async lookup(input: EnrichmentLookupInput): Promise<EnrichmentResult> {
    // Hunter's Email Finder needs a domain + a person name. Anything else is
    // a clean miss for this provider (no wasted credits).
    const domain =
      (input.website ? domainFromWebsite(input.website) : undefined) ??
      (input.email?.includes("@") ? input.email.split("@")[1].toLowerCase() : undefined);
    const parts = (input.name ?? "").trim().split(/\s+/).filter(Boolean);
    if (!domain || parts.length < 2) return { hit: false, costCents: 0 };

    const params = new URLSearchParams({
      domain,
      first_name: parts[0],
      last_name: parts.slice(1).join(" "),
      api_key: this.apiKey,
    });
    let res: Response;
    try {
      res = await fetch(`https://api.hunter.io/v2/email-finder?${params.toString()}`);
    } catch (err) {
      throw new Error(`Hunter request failed: ${err instanceof Error ? err.message : err}`);
    }
    if (res.status === 401) {
      throw new Error("Hunter rejected the API key (401) — check HUNTER_API_KEY.");
    }
    if (res.status === 429) {
      throw new Error("Hunter rate limit hit (429) — back off and retry.");
    }
    const json = (await res.json().catch(() => ({}))) as {
      data?: {
        email?: string;
        score?: number;
        position?: string;
        company?: string;
        verification?: { status?: string };
      };
      errors?: Array<{ details?: string }>;
    };
    if (!res.ok) {
      const detail = json.errors?.[0]?.details ?? `HTTP ${res.status}`;
      throw new Error(`Hunter API error: ${detail}`);
    }
    const email = json.data?.email?.trim();
    if (!email) return { hit: false, costCents: 0, raw: { score: json.data?.score ?? null } };

    return {
      hit: true,
      company: {
        name: json.data?.company?.trim() || input.company?.trim(),
        domain,
        website: `https://${domain}`,
      },
      contact: {
        name: input.name?.trim(),
        email,
        title: json.data?.position?.trim() || undefined,
        confidence: typeof json.data?.score === "number" ? json.data.score : undefined,
      },
      // Hunter bills in Hunter credits (1 per email-finder request), not
      // dollars. costCents stays 0; usage is on your Hunter invoice.
      costCents: 0,
      raw: {
        score: json.data?.score ?? null,
        verification: json.data?.verification?.status ?? null,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Chain resolution.
// ---------------------------------------------------------------------------

export type EnrichmentProviderName = "fake" | "apollo" | "hunter";

/**
 * Ordered provider chain from the environment. ENRICHMENT_PROVIDERS is a
 * comma-separated list, e.g. "apollo,hunter,fake". Unknown names throw
 * loudly (a typo must never silently re-order the waterfall). A provider
 * whose env keys are missing throws EnrichmentProviderNotConfiguredError
 * at construction — the caller (waterfall) treats that as a hard error, not
 * a silent skip, so misconfiguration is visible.
 */
export function getEnrichmentProviders(
  env: NodeJS.ProcessEnv = process.env,
): EnrichmentProvider[] {
  const raw = (env.ENRICHMENT_PROVIDERS ?? "fake").trim().toLowerCase();
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return [new FakeEnrichmentProvider()];
  return names.map((n): EnrichmentProvider => {
    switch (n as EnrichmentProviderName) {
      case "fake":
        return new FakeEnrichmentProvider();
      case "apollo":
        return new ApolloProvider(env);
      case "hunter":
        return new HunterProvider(env);
      default:
        throw new Error(
          `Unknown enrichment provider "${n}" (ENRICHMENT_PROVIDERS). Valid: fake, apollo, hunter.`,
        );
    }
  });
}
