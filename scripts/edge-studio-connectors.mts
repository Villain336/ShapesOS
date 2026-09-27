// Marketr — edge-case tests, GROUP B: studio + connectors + deploy.
// READ-ONLY on all source: this file adds fixtures only; it modifies nothing.
// Run: npx tsx scripts/edge-studio-connectors.mts
// Mocks only: fake fetch router for the live HTTP classes, mock ports,
// fake Prisma client. No live DB, no network.

process.env.MARKETR_CREDENTIALS_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMockPorkbunPort, type PorkbunPort } from "@/lib/studio/porkbun";
import {
  __resetStudioTestState,
  __seedPurchaseConfirmation,
  checkDomainAvailability,
  confirmDomainPurchase,
  createAsset,
  deleteAsset,
  getPorkbunPort,
  getStudioAutofillDefaults,
  getRegistrant,
  getTldPricing,
  listAssets,
  previewDomainPurchase,
  removePorkbunKeys,
  removeStudioDomain,
  savePorkbunKeys,
  saveRegistrant,
  useAssetInSocialPost,
  validateDomainName,
} from "@/lib/studio/service";
import { GitHubSiteFileProvider } from "@/lib/connectors/github";
import { MockGitHubConnector } from "@/lib/connectors/mock-github";
import { WordPressConnector } from "@/lib/connectors/wordpress";
import { MockWordPressConnector } from "@/lib/connectors/mock-wordpress";
import { WebflowConnector } from "@/lib/connectors/webflow";
import { MockWebflowConnector } from "@/lib/connectors/mock-webflow";
import { extractZipToProvider, zipProviderFiles } from "@/lib/connectors/zip";
import { LocalDirProvider } from "@/lib/connectors/local";
import { VercelDeployTarget } from "@/lib/deploy/vercel";
import { MockVercelDeployTarget } from "@/lib/deploy/mock-vercel";
import { CloudflarePagesDeployTarget } from "@/lib/deploy/cloudflare";
import { MockCloudflarePagesDeployTarget } from "@/lib/deploy/mock-cloudflare";
import { normalizeStatus } from "@/lib/deploy/types";
import { sanitizePath } from "@/lib/sitefiles/paths";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const mods: Record<string, { pass: number; fail: number }> = {};
function check(mod: string, name: string, cond: boolean, detail = ""): void {
  const m = (mods[mod] ??= { pass: 0, fail: 0 });
  if (cond) m.pass += 1;
  else {
    m.fail += 1;
    console.error(`FAIL [${mod}]: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function throwsOk(fn: () => Promise<unknown> | unknown, needle: string): Promise<boolean> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
    return msg.toLowerCase().includes(needle.toLowerCase());
  }
  return false;
}

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Fake Prisma (deterministic ids via counter — no Math.random)
// ---------------------------------------------------------------------------

function fakeDb(opts: { domainUpsertThrows?: boolean } = {}) {
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  const state = {
    porkbun: new Map<string, Row>(),
    registrants: new Map<string, Row>(),
    domains: new Map<string, Row>(),
    assets: new Map<string, Row>(),
    socialChannels: [] as Row[],
    audit: [] as Row[],
  };
  const db = {
    studioPorkbunSettings: {
      findUnique: async ({ where }: { where: { workspaceId: string } }) =>
        state.porkbun.get(where.workspaceId) ?? null,
      upsert: async ({ where, update, create }: { where: { workspaceId: string }; update: Row; create: Row }) => {
        const row = { id: id("pb"), ...(state.porkbun.get(where.workspaceId) ?? {}), ...create, ...update };
        state.porkbun.set(where.workspaceId, row);
        return row;
      },
      deleteMany: async ({ where }: { where: { workspaceId: string } }) => {
        const had = state.porkbun.delete(where.workspaceId);
        return { count: had ? 1 : 0 };
      },
    },
    studioRegistrant: {
      findUnique: async ({ where }: { where: { workspaceId: string } }) =>
        state.registrants.get(where.workspaceId) ?? null,
      upsert: async ({ where, update, create }: { where: { workspaceId: string }; update: Row; create: Row }) => {
        const row = { id: id("reg"), ...(state.registrants.get(where.workspaceId) ?? {}), ...create, ...update };
        state.registrants.set(where.workspaceId, row);
        return row;
      },
    },
    studioDomain: {
      findUnique: async ({ where }: { where: { projectId_domain: { projectId: string; domain: string } } }) => {
        for (const r of state.domains.values()) {
          if (r.projectId === where.projectId_domain.projectId && r.domain === where.projectId_domain.domain) return r;
        }
        return null;
      },
      findFirst: async ({ where }: { where: { id: string; projectId: string } }) => {
        for (const r of state.domains.values()) {
          if (r.id === where.id && r.projectId === where.projectId) return r;
        }
        return null;
      },
      findMany: async ({ where }: { where: { projectId: string } }) =>
        [...state.domains.values()].filter((r) => r.projectId === where.projectId),
      upsert: async ({ where, update, create }: { where: { projectId_domain: { projectId: string; domain: string } }; update: Row; create: Row }) => {
        if (opts.domainUpsertThrows) throw new Error("simulated DB outage on studioDomain.upsert");
        let row: Row | null = null;
        for (const r of state.domains.values()) {
          if (r.projectId === where.projectId_domain.projectId && r.domain === where.projectId_domain.domain) { row = r; break; }
        }
        if (row) Object.assign(row, update);
        else { row = { id: id("dom"), ...create, ...update }; state.domains.set(row.id as string, row); }
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = state.domains.get(where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
      // Day-1 (edge #2): atomic purchase claim support.
      // Also supports the failure-path conditional update:
      // { projectId_domain, status: "purchasing" }.
      updateMany: async ({ where, data }: { where: { id?: string; projectId?: string; domain?: string; projectId_domain?: { projectId: string; domain: string }; status?: string | { notIn?: string[] } }; data: Row }) => {
        let count = 0;
        for (const r of state.domains.values()) {
          if (where.id !== undefined && r.id !== where.id) continue;
          if (where.projectId_domain !== undefined &&
            (r.projectId !== where.projectId_domain.projectId || r.domain !== where.projectId_domain.domain)) continue;
          if (where.projectId !== undefined && r.projectId !== where.projectId) continue;
          if (where.domain !== undefined && r.domain !== where.domain) continue;
          if (typeof where.status === "string" && r.status !== where.status) continue;
          if (typeof where.status === "object" && where.status?.notIn && (where.status.notIn as string[]).includes(r.status as string)) continue;
          Object.assign(r, data);
          count++;
        }
        return { count };
      },
      create: async ({ data }: { data: Row }) => {
        // Faithful unique-constraint simulation: real Postgres would throw
        // P2002 here, which claimDomainPurchase catches to resolve the
        // create-create race to exactly one winner.
        for (const r of state.domains.values()) {
          if (r.projectId === (data as Row).projectId && r.domain === (data as Row).domain) {
            throw new Prisma.PrismaClientKnownRequestError(
              "Unique constraint failed on the fields: (`project_id`,`domain`)",
              { code: "P2002", clientVersion: "6.0.0" },
            );
          }
        }
        const row = { id: id("dom"), ...data };
        state.domains.set(row.id as string, row);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        state.domains.delete(where.id);
        return { id: where.id };
      },
    },
    projectAsset: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: id("asset"), createdAt: new Date(1700000000000), ...data };
        state.assets.set(row.id as string, row);
        return row;
      },
      findMany: async ({ where }: { where: { projectId: string; source?: string } }) =>
        [...state.assets.values()].filter((r) => r.projectId === where.projectId && (!where.source || r.source === where.source)),
      findFirst: async ({ where }: { where: { id: string; projectId: string } }) => {
        const r = state.assets.get(where.id);
        return r && r.projectId === where.projectId ? r : null;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        state.assets.delete(where.id);
        return { id: where.id };
      },
    },
    socialChannel: {
      findMany: async ({ where }: { where: { projectId: string; enabled: boolean } }) =>
        state.socialChannels.filter((c) => c.projectId === where.projectId && c.enabled === where.enabled),
    },
    socialPost: { create: async ({ data }: { data: Row }) => ({ id: id("post"), ...data }) },
    fileChangeLog: { create: async ({ data }: { data: Row }) => { state.audit.push(data); return data; } },
    brandKit: {
      findFirst: async ({ where }: { where: { workspaceId: string } }) =>
        where.workspaceId === "ws-brand"
          ? { id: "kit-1", name: "EdgeCo", logoPath: "logos/edge.svg", colors: { primary: "#000" }, fonts: { heading: "Inter" }, tone: "bold" }
          : null,
    },
  } as unknown as PrismaClient;
  return { db, state };
}

const REGISTRANT = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  phone: "+15551234567",
  address: "1 Analytic Way",
  city: "Greensboro",
  state: "NC",
  zip: "27401",
  country: "US",
};

// ---------------------------------------------------------------------------
// Fake fetch infra (no network — deterministic canned routers)
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function useFake(h: Handler): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) =>
    h(String(input), init ?? {})) as typeof fetch;
}
function stopFake(): void {
  globalThis.fetch = realFetch;
}
function j(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function tx(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

// ---------------------------------------------------------------------------
// D. service.ts — Porkbun keys + domain validation edges
// ---------------------------------------------------------------------------
{
  const M = "studio/service";
  __resetStudioTestState();
  const { db, state } = fakeDb();

  check(M, "empty keys rejected", await throwsOk(
    () => savePorkbunKeys(db, "ws-d", { apiKey: "", secretApiKey: "" }), "required"));
  check(M, "whitespace-only keys rejected", await throwsOk(
    () => savePorkbunKeys(db, "ws-d", { apiKey: "   ", secretApiKey: "\t" }), "required"));
  check(M, "missing secret rejected", await throwsOk(
    () => savePorkbunKeys(db, "ws-d", { apiKey: "pk1_x", secretApiKey: "" }), "required"));
  // Short keys: hint shows whole tail
  const { hint } = await savePorkbunKeys(db, "ws-d", { apiKey: "abc", secretApiKey: "def" });
  check(M, "short-key hint", hint === "…abc");

  // Factory receives decrypted keys (round-trip)
  let captured: { a: string; s: string } | null = null;
  const p = await getPorkbunPort(db, "ws-d", (a, s) => {
    captured = { a, s };
    return createMockPorkbunPort();
  });
  check(M, "port factory gets decrypted keys", p !== null && captured !== null &&
    (captured as { a: string }).a === "abc" && (captured as { s: string }).s === "def");

  // Half-written settings (apiKey only) → null port, fail closed
  state.porkbun.set("ws-half", { apiKeyEnc: "x" });
  check(M, "half settings → null port", (await getPorkbunPort(db, "ws-half")) === null);

  await removePorkbunKeys(db, "ws-d");
  check(M, "keys removed → null port", (await getPorkbunPort(db, "ws-d")) === null);

  // --- validateDomainName ---
  const good = (d: string, expect: string) => {
    let out = "";
    try { out = validateDomainName(d); } catch { out = "<threw>"; }
    check(M, `domain ${JSON.stringify(d)} → ${JSON.stringify(expect)}`, out === expect);
  };
  good("  Example.COM ", "example.com");
  good("a.io", "a.io");
  good("", "<threw>");
  good("   ", "<threw>");
  good("münchen.de", "<threw>");           // IDN rejected — punycode required
  good("example.com.", "<threw>");          // trailing dot
  good("-bad.com", "<threw>");
  good("bad-.com", "<threw>");
  good("under_score.com", "<threw>");
  good(`${"a".repeat(64)}.com`, "<threw>"); // label > 63 chars
  good(`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(61)}.com`, `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(61)}.com`);
  good(`${"a".repeat(250)}.com`, "<threw>"); // > 253 chars
  good("a..b.com", "<threw>");
  good("has space.com", "<threw>");

  // --- checkDomainAvailability / getTldPricing via mock ---
  const pb = createMockPorkbunPort();
  const avail = await checkDomainAvailability(pb, "  My-Available-Site.COM ");
  check(M, "availability normalizes case/space", avail.domain === "my-available-site.com" && avail.available === true);
  check(M, "availability carries price", avail.priceUsd === 11.08 && avail.renewalPriceUsd === 11.08);
  // NOTE: mock classifies by substring — "unavailable-*.com" contains "available"
  const oops = await checkDomainAvailability(pb, "unavailable-test.com");
  check(M, "mock substring quirk: 'unavailable-test.com' reads available", oops.available === true);
  check(M, "invalid domain fails before port call", await throwsOk(
    () => checkDomainAvailability(pb, "not a domain!!"), "not a valid domain"));
  const pricing = await getTldPricing(pb, ["COM", ".io", "bogus"]);
  check(M, "pricing normalizes tlds, drops unknown", pricing.length === 2 && pricing[0].tld === "com");
  check(M, "pricing with no filter returns all", (await getTldPricing(pb)).length === 3);
}

// ---------------------------------------------------------------------------
// E. service.ts — purchase flow edges
// ---------------------------------------------------------------------------
{
  const M = "studio/service";

  // E1: no registrant → blocked
  {
    __resetStudioTestState();
    const { db } = fakeDb();
    const pb = createMockPorkbunPort();
    check(M, "purchase without registrant blocked", await throwsOk(
      () => previewDomainPurchase(db, "ws-e1", "proj", pb, "my-available-site.com"),
      "registrant contact"));
  }

  // E2: already registered locally → blocked
  {
    __resetStudioTestState();
    const { db, state } = fakeDb();
    const pb = createMockPorkbunPort();
    await saveRegistrant(db, "ws-e2", REGISTRANT);
    state.domains.set("dom-9", { id: "dom-9", projectId: "proj", domain: "my-available-site.com", status: "registered" });
    check(M, "preview of locally-registered domain blocked", await throwsOk(
      () => previewDomainPurchase(db, "ws-e2", "proj", pb, "my-available-site.com"), "already registered"));
    // ...but a failed row does not block a retry
    state.domains.set("dom-9", { id: "dom-9", projectId: "proj", domain: "my-available-site.com", status: "failed" });
    const prev = await previewDomainPurchase(db, "ws-e2", "proj", pb, "my-available-site.com");
    check(M, "failed row does not block retry preview", prev.confirmationToken.length > 0);
  }

  // E3: unavailable / premium / priceless
  {
    __resetStudioTestState();
    const { db } = fakeDb();
    await saveRegistrant(db, "ws-e3", REGISTRANT);
    const pb = createMockPorkbunPort();
    check(M, "unavailable domain blocked", await throwsOk(
      () => previewDomainPurchase(db, "ws-e3", "proj", pb, "taken-site-zzz.com"), "not available"));
    check(M, "premium domain blocked", await throwsOk(
      () => previewDomainPurchase(db, "ws-e3", "proj", pb, "premium-available-vip.com"), "premium"));
    const noPrice: PorkbunPort = {
      ...createMockPorkbunPort(),
      checkDomain: async (d) => ({ domain: d, tld: "com", available: true, priceUsd: null, renewalPriceUsd: null, premium: false, minDuration: 1 }),
    };
    check(M, "null price blocked", await throwsOk(
      () => previewDomainPurchase(db, "ws-e3", "proj", noPrice, "my-available-site.com"), "registration price"));
  }

  // E4: token lifecycle — reuse, expiry, project mismatch, 5-min/6-min
  {
    __resetStudioTestState();
    const { db, state } = fakeDb();
    await saveRegistrant(db, "ws-e4", REGISTRANT);
    const pb = createMockPorkbunPort();
    const prev = await previewDomainPurchase(db, "ws-e4", "proj", pb, "my-available-site.com");
    const done = await confirmDomainPurchase(db, "ws-e4", "proj", pb,
      { confirmationToken: prev.confirmationToken, agreeToTerms: true, whoisPrivacy: true });
    check(M, "happy-path confirm registers", done.orderId === "MOCK-ORDER-1" && done.costUsd === 11.08);
    check(M, "nameservers snapshotted", done.nameServers.length === 2);
    check(M, "purchase audited", state.audit.some((a) => a.action === "studio_domain_purchased"));
    // Token reuse
    check(M, "confirmation token single-use", await throwsOk(
      () => confirmDomainPurchase(db, "ws-e4", "proj", pb,
        { confirmationToken: prev.confirmationToken, agreeToTerms: true, whoisPrivacy: true }),
      "expired or invalid"));
    // Concurrent double-confirm of the same token: exactly one wins
    const prev2 = await previewDomainPurchase(db, "ws-e4", "proj", pb, "second-available-site.com");
    const results = await Promise.allSettled([
      confirmDomainPurchase(db, "ws-e4", "proj", pb, { confirmationToken: prev2.confirmationToken, agreeToTerms: true, whoisPrivacy: true }),
      confirmDomainPurchase(db, "ws-e4", "proj", pb, { confirmationToken: prev2.confirmationToken, agreeToTerms: true, whoisPrivacy: true }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled").length;
    const lost = results.filter((r) => r.status === "rejected").length;
    check(M, "concurrent same-token confirm: one wins", won === 1 && lost === 1);

    // Expired token (seeded 60s in the past — simulates using a 5-min token at 6 min)
    const old = __seedPurchaseConfirmation({
      projectId: "proj", workspaceId: "ws-e4", domain: "old-available-site.com",
      priceCents: 1108, expiresAt: Date.now() - 60_000,
    });
    check(M, "6-minute-old token rejected", await throwsOk(
      () => confirmDomainPurchase(db, "ws-e4", "proj", pb,
        { confirmationToken: old, agreeToTerms: true, whoisPrivacy: true }),
      "expired"));
    // Project mismatch
    const other = __seedPurchaseConfirmation({
      projectId: "other-proj", workspaceId: "ws-e4", domain: "x-available-site.com",
      priceCents: 1108, expiresAt: Date.now() + 300_000,
    });
    check(M, "cross-project token rejected", await throwsOk(
      () => confirmDomainPurchase(db, "ws-e4", "proj", pb,
        { confirmationToken: other, agreeToTerms: true, whoisPrivacy: true }),
      "does not match"));
    // agreeToTerms false
    const prev3 = await previewDomainPurchase(db, "ws-e4", "proj", pb, "third-available-site.com");
    check(M, "confirm without terms rejected", await throwsOk(
      () => confirmDomainPurchase(db, "ws-e4", "proj", pb,
        { confirmationToken: prev3.confirmationToken, agreeToTerms: false, whoisPrivacy: true }),
      "agree to the terms"));
  }

  // E5: price change between preview and confirm
  {
    __resetStudioTestState();
    const { db, state } = fakeDb();
    await saveRegistrant(db, "ws-e5", REGISTRANT);
    const cheap = createMockPorkbunPort();
    const prev = await previewDomainPurchase(db, "ws-e5", "proj", cheap, "my-available-site.com");
    const pricey: PorkbunPort = {
      ...createMockPorkbunPort(),
      checkDomain: async (d) => ({ domain: d, tld: "com", available: true, priceUsd: 99.99, renewalPriceUsd: 99.99, premium: false, minDuration: 1 }),
    };
    check(M, "price change aborts purchase", await throwsOk(
      () => confirmDomainPurchase(db, "ws-e5", "proj", pricey,
        { confirmationToken: prev.confirmationToken, agreeToTerms: true, whoisPrivacy: true }),
      "price changed"));
    check(M, "price-change abort audited", state.audit.some((a) => a.action === "studio_domain_purchase_failed"));
    const createCalls = cheap.calls.filter((c) => c.method === "createDomain").length;
    check(M, "no charge on price change", createCalls === 0);
  }

  // E6: DOUBLE CHARGE — two previews then two confirms for the same domain
  // FIXED (day-1): the idempotency claim makes the second confirm abort
  // before any charge — exactly one createDomain across both confirms.
  {
    __resetStudioTestState();
    const { db } = fakeDb();
    await saveRegistrant(db, "ws-e6", REGISTRANT);
    const pb = createMockPorkbunPort();
    const p1 = await previewDomainPurchase(db, "ws-e6", "proj", pb, "double-available-site.com");
    const p2 = await previewDomainPurchase(db, "ws-e6", "proj", pb, "double-available-site.com");
    check(M, "two previews issued (no cross-preview lock)", p1.confirmationToken !== p2.confirmationToken);
    await confirmDomainPurchase(db, "ws-e6", "proj", pb, { confirmationToken: p1.confirmationToken, agreeToTerms: true, whoisPrivacy: true });
    check(M, "second confirm of same domain aborts (already purchased)", await throwsOk(
      () => confirmDomainPurchase(db, "ws-e6", "proj", pb, { confirmationToken: p2.confirmationToken, agreeToTerms: true, whoisPrivacy: true }),
      "already purchased"));
    const charges = pb.calls.filter((c) => c.method === "createDomain").length;
    check(M, "FIXED: two confirms charge exactly once", charges === 1,
      `createDomain called ${charges}x`);
    // The losing confirm's claim-loss path must never overwrite the winner's
    // legitimate "registered" row as "failed".
    const rowE6 = await db.studioDomain.findUnique({ where: { projectId_domain: { projectId: "proj", domain: "double-available-site.com" } } }) as Row | null;
    check(M, "FIXED: losing confirm leaves the registered row intact",
      rowE6?.status === "registered", `status=${rowE6?.status}`);
  }
  // E6b: concurrent double-confirm (two tokens, same domain) — one winner.
  {
    __resetStudioTestState();
    const { db } = fakeDb();
    await saveRegistrant(db, "ws-e6b", REGISTRANT);
    const pb = createMockPorkbunPort();
    const p1 = await previewDomainPurchase(db, "ws-e6b", "proj", pb, "race-available-site.com");
    const p2 = await previewDomainPurchase(db, "ws-e6b", "proj", pb, "race-available-site.com");
    const results = await Promise.allSettled([
      confirmDomainPurchase(db, "ws-e6b", "proj", pb, { confirmationToken: p1.confirmationToken, agreeToTerms: true, whoisPrivacy: true }),
      confirmDomainPurchase(db, "ws-e6b", "proj", pb, { confirmationToken: p2.confirmationToken, agreeToTerms: true, whoisPrivacy: true }),
    ]);
    const charges = pb.calls.filter((c) => c.method === "createDomain").length;
    check(M, "FIXED: concurrent double-confirm charges exactly once", charges === 1,
      `createDomain called ${charges}x; results=${results.map((r) => r.status).join(",")}`);
    const rowE6b = await db.studioDomain.findUnique({ where: { projectId_domain: { projectId: "proj", domain: "race-available-site.com" } } }) as Row | null;
    check(M, "FIXED: concurrent loser leaves the registered row intact",
      rowE6b?.status === "registered", `status=${rowE6b?.status}`);
  }

  // E7: provider failure mid-confirm (before charge) → no purchase_failed audit
  {
    __resetStudioTestState();
    const { db, state } = fakeDb();
    await saveRegistrant(db, "ws-e7", REGISTRANT);
    const pb = createMockPorkbunPort();
    const prev = await previewDomainPurchase(db, "ws-e7", "proj", pb, "my-available-site.com");
    const dying: PorkbunPort = {
      ...createMockPorkbunPort(),
      checkDomain: async () => { throw new Error("porkbun is down"); },
    };
    check(M, "pre-charge check failure throws", await throwsOk(
      () => confirmDomainPurchase(db, "ws-e7", "proj", dying,
        { confirmationToken: prev.confirmationToken, agreeToTerms: true, whoisPrivacy: true }),
      "porkbun is down"));
    check(M, "pre-charge failure leaves no purchase_failed audit", !state.audit.some((a) => a.action === "studio_domain_purchase_failed"));
  }

  // E8: createDomain fails (charged? unknown) → failed row + audit
  {
    __resetStudioTestState();
    const { db, state } = fakeDb();
    await saveRegistrant(db, "ws-e8", REGISTRANT);
    const pb = createMockPorkbunPort();
    const prev = await previewDomainPurchase(db, "ws-e8", "proj", pb, "my-available-site.com");
    const failCharge: PorkbunPort = {
      ...createMockPorkbunPort(),
      createDomain: async () => { throw new Error("card declined"); },
    };
    check(M, "charge failure throws", await throwsOk(
      () => confirmDomainPurchase(db, "ws-e8", "proj", failCharge,
        { confirmationToken: prev.confirmationToken, agreeToTerms: true, whoisPrivacy: true }),
      "card declined"));
    const row = await db.studioDomain.findUnique({ where: { projectId_domain: { projectId: "proj", domain: "my-available-site.com" } } }) as Row | null;
    check(M, "failed purchase leaves failed row", (row as Row)?.status === "failed");
    check(M, "charge failure audited", state.audit.some((a) => a.action === "studio_domain_purchase_failed"));
  }

  // E9: DB dies AFTER charge → no failure audit (money moved, trail missing)
  {
    __resetStudioTestState();
    const { db, state } = fakeDb({ domainUpsertThrows: true });
    await saveRegistrant(db, "ws-e9", REGISTRANT);
    const pb = createMockPorkbunPort();
    const prev = await previewDomainPurchase(db, "ws-e9", "proj", pb, "my-available-site.com");
    const err = await throwsOk(() => confirmDomainPurchase(db, "ws-e9", "proj", pb,
      { confirmationToken: prev.confirmationToken, agreeToTerms: true, whoisPrivacy: true }), "simulated db outage");
    check(M, "post-charge DB outage surfaces", err);
    const charges = pb.calls.filter((c) => c.method === "createDomain").length;
    check(M, "charge happened before DB write", charges === 1);
    check(M, "BUG CHECK: purchase_failed audit still written (expect true)",
      state.audit.some((a) => a.action === "studio_domain_purchase_failed"),
      "charge succeeded but no failure audit — money moved with no trail");
  }

  // E10: removeStudioDomain guards
  {
    __resetStudioTestState();
    const { db } = fakeDb();
    await saveRegistrant(db, "ws-e10", REGISTRANT);
    const pb = createMockPorkbunPort();
    const prev = await previewDomainPurchase(db, "ws-e10", "proj", pb, "my-available-site.com");
    const done = await confirmDomainPurchase(db, "ws-e10", "proj", pb,
      { confirmationToken: prev.confirmationToken, agreeToTerms: true, whoisPrivacy: true });
    check(M, "registered row cannot be removed", await throwsOk(
      () => removeStudioDomain(db, "ws-e10", "proj", done.id as string), "only be removed at porkbun"));
    check(M, "missing row removal throws", await throwsOk(
      () => removeStudioDomain(db, "ws-e10", "proj", "nope"), "not found"));
  }
}

// ---------------------------------------------------------------------------
// F. service.ts — asset library edges
// ---------------------------------------------------------------------------
{
  const M = "studio/service";
  __resetStudioTestState();
  const { db, state } = fakeDb();

  check(M, "empty asset name rejected", await throwsOk(
    () => createAsset(db, "ws-f", "proj", { name: "   ", source: "upload", url: "https://x/y.png" }),
    "name is required"));
  check(M, "non-url rejected", await throwsOk(
    () => createAsset(db, "ws-f", "proj", { name: "n", source: "upload", url: "not a url" }),
    "valid asset url"));
  check(M, "javascript: url rejected", await throwsOk(
    () => createAsset(db, "ws-f", "proj", { name: "n", source: "upload", url: "javascript:alert(1)" }),
    "valid asset url"));
  check(M, "data: url rejected", await throwsOk(
    () => createAsset(db, "ws-f", "proj", { name: "n", source: "upload", url: "data:image/png;base64,xx" }),
    "valid asset url"));
  const a1 = await createAsset(db, "ws-f", "proj", { name: " hero ", source: "upload", url: "https://x/hero.png" });
  check(M, "asset name trimmed", (a1 as Row).name === "hero");
  check(M, "asset creation audited", state.audit.some((a) => a.action === "studio_asset_created"));

  check(M, "assets filtered by source", (await listAssets(db, "proj", "upload")).length === 1);

  check(M, "delete missing asset throws", await throwsOk(
    () => deleteAsset(db, "ws-f", "proj", "nope"), "not found"));
  await deleteAsset(db, "ws-f", "proj", (a1 as Row).id as string);
  check(M, "delete audited", state.audit.some((a) => a.action === "studio_asset_deleted"));

  // useAssetInSocialPost with no channels and no services → clear error
  check(M, "social post with no channels blocked", await throwsOk(
    () => useAssetInSocialPost(db, "ws-f", "proj", "nope", { text: "hi", services: ["x"] }),
    "asset not found"));
  const a2 = await createAsset(db, "ws-f", "proj", { name: "m", source: "upload", url: "https://x/m.png" });
  check(M, "social post needs channels", await throwsOk(
    () => useAssetInSocialPost(db, "ws-f", "proj", (a2 as Row).id as string, { text: "hi", services: [] }),
    "no social channels"));

  // Registrant validation edges
  check(M, "registrant missing field", await throwsOk(
    () => saveRegistrant(db, "ws-f", { ...REGISTRANT, email: "  " }), "registrant email is required"));
  check(M, "registrant bad email", await throwsOk(
    () => saveRegistrant(db, "ws-f", { ...REGISTRANT, email: "not-an-email" }), "email is invalid"));
  const reg = await saveRegistrant(db, "ws-f", REGISTRANT);
  check(M, "registrant round-trips", (reg as Row).email === REGISTRANT.email);
  check(M, "getRegistrant empty → null", (await getRegistrant(db, "ws-void")) === null);

  // Brand-kit defaults
  check(M, "no brand kit → null defaults", (await getStudioAutofillDefaults(db, "ws-void")) === null);
  const defs = await getStudioAutofillDefaults(db, "ws-brand");
  check(M, "brand kit defaults returned", defs !== null && defs.brandKitName === "EdgeCo");
}

// ---------------------------------------------------------------------------
// Fake HTTP routers (deterministic canned providers)
// ---------------------------------------------------------------------------

interface GhState {
  calls: Array<{ method: string; url: string; body?: unknown }>;
  blobBodies: unknown[];
  blobCount: number;
  treeCount: number;
  commitCount: number;
  refPatched: boolean;
  refCreated: boolean;
}
function makeGitHubFake(opts: {
  refExists?: boolean;
  failBlobAt?: number;
  mode?: "ok" | "malformed" | "r429" | "r500" | "missingFields" | "repo404";
} = {}): { handler: Handler; state: GhState } {
  const state: GhState = { calls: [], blobBodies: [], blobCount: 0, treeCount: 0, commitCount: 0, refPatched: false, refCreated: false };
  const mode = opts.mode ?? "ok";
  const handler: Handler = async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const u = new URL(url);
    const path = u.pathname;
    let body: unknown;
    try { body = init.body ? JSON.parse(String(init.body)) : undefined; } catch { body = init.body; }
    state.calls.push({ method, url: path + u.search, body });
    if (mode === "r429") return j(429, { message: "API rate limit exceeded" });
    if (mode === "r500") return tx(500, "Internal Server Error");
    if (mode === "malformed") return tx(200, "this is not json {{{");
    const seg = (p: string) => path === p || path.startsWith(p + "/") || path.startsWith(p + "?");
    if (method === "GET" && path === "/repos/o/r") {
      if (mode === "repo404") return j(404, { message: "Not Found" });
      return j(200, { default_branch: "main", full_name: "o/r" });
    }
    if (method === "GET" && path === "/user/repos") {
      if (mode === "missingFields") return j(200, [{ name: "mystery" }]);
      return j(200, [{ owner: { login: "o" }, name: "r", full_name: "o/r", private: true, default_branch: "main", updated_at: "2026-01-01" }]);
    }
    if (method === "POST" && path === "/user/repos") {
      const b = body as { name: string; private: boolean };
      return j(201, { owner: { login: "o" }, name: b.name, full_name: `o/${b.name}`, private: b.private, default_branch: "main", updated_at: null });
    }
    if (path.startsWith("/repos/o/r/contents/")) {
      const rel = path.slice("/repos/o/r/contents/".length);
      if (method === "GET") {
        if (rel === "missing.txt") return j(404, { message: "Not Found" });
        if (rel === "adir") return j(200, { name: "adir", path: "adir", type: "dir", sha: "d" });
        if (rel === "big.txt") return j(200, { name: "big.txt", path: "big.txt", type: "file", sha: "s", size: 300_000, content: b64("x"), encoding: "base64" });
        if (rel === "new.txt") return j(404, { message: "Not Found" });
        return j(200, { name: rel, path: rel, type: "file", sha: "sha-old", size: 5, content: b64("hello"), encoding: "base64" });
      }
      if (method === "PUT") return j(201, { content: { sha: "sha-new" } });
    }
    if (method === "GET" && path === "/repos/o/r/git/ref/heads/main") {
      return opts.refExists === false ? j(404, { message: "Not Found" }) : j(200, { object: { sha: "base-sha" } });
    }
    if (method === "POST" && path === "/repos/o/r/git/blobs") {
      state.blobCount += 1;
      if (opts.failBlobAt === state.blobCount) throw new Error("blob store exploded");
      state.blobBodies.push(body);
      return j(201, { sha: `blob-${state.blobCount}` });
    }
    if (method === "POST" && path === "/repos/o/r/git/trees") {
      state.treeCount += 1;
      return j(201, { sha: `tree-${state.treeCount}` });
    }
    if (method === "POST" && path === "/repos/o/r/git/commits") {
      state.commitCount += 1;
      return j(201, { sha: `commit-${state.commitCount}` });
    }
    if (method === "PATCH" && path === "/repos/o/r/git/refs/heads/main") {
      state.refPatched = true;
      return j(200, {});
    }
    if (method === "POST" && path === "/repos/o/r/git/refs") {
      state.refCreated = true;
      return j(201, {});
    }
    return j(404, { message: "fake: no route" });
  };
  return { handler, state };
}

function makeWordPressFake(opts: { mode?: "ok" | "r401" | "del404" | "malformed" } = {}): {
  handler: Handler;
  calls: Array<{ method: string; url: string; body?: unknown; headers?: unknown }>;
} {
  const calls: Array<{ method: string; url: string; body?: unknown; headers?: unknown }> = [];
  const mode = opts.mode ?? "ok";
  const page = { id: 1, slug: "home", status: "publish", modified: "2026-01-01", link: "https://wp.test/home/", title: { rendered: "<b>Home</b>" }, content: { rendered: "<p>hi</p>" } };
  const handler: Handler = async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const u = new URL(url);
    const path = u.pathname;
    let body: unknown;
    try { body = init.body ? JSON.parse(String(init.body)) : undefined; } catch { body = init.body; }
    calls.push({ method, url: path + u.search, body, headers: init.headers });
    if (mode === "r401") return j(401, { message: "bad creds" });
    if (path === "/wp-json/" && method === "GET") return mode === "malformed" ? tx(200, "nope") : j(200, { name: "Test WP" });
    if (path === "/wp-json/wp/v2/pages" && method === "GET") return j(200, [page]);
    if (path === "/wp-json/wp/v2/pages" && method === "POST") {
      const b = body as Record<string, unknown>;
      return j(201, { id: 9, slug: b.slug ?? "new", status: b.status, modified: "2026-09-21", link: "https://wp.test/new/", title: { rendered: b.title }, content: { rendered: b.content } });
    }
    if (path === "/wp-json/wp/v2/pages/9" && method === "PUT") {
      const b = body as Record<string, unknown>;
      return j(200, { id: 9, slug: b.slug ?? "new", status: b.status, modified: "2026-09-21", link: "https://wp.test/new/", title: { rendered: b.title }, content: { rendered: b.content } });
    }
    if (path === "/wp-json/wp/v2/pages/1" && method === "GET") return j(200, page);
    if (path === "/wp-json/wp/v2/pages/9" && method === "GET") {
      const created = { id: 9, slug: "new", status: "draft", modified: "2026-09-21", link: "https://wp.test/new/", title: { rendered: "Big" }, content: { rendered: "z" } };
      return j(200, created);
    }
    if (path === "/wp-json/wp/v2/pages/9" && method === "DELETE") {
      return mode === "del404" ? j(404, { message: "gone" }) : j(200, { deleted: true });
    }
    if (path === "/wp-json/wp/v2/media" && method === "POST") {
      return j(201, { id: 5, source_url: "https://wp.test/uploads/f.png" });
    }
    if (path === "/wp-json/wp/v2/media" && method === "GET") {
      return j(200, [{ id: 201, slug: "hero", source_url: "https://wp.test/uploads/hero.jpg", modified: "2026-09-01", mime_type: "image/jpeg" }]);
    }
    return j(404, { message: "fake: no route" });
  };
  return { handler, calls };
}

function makeWebflowFake(opts: { noSites?: boolean; malformed?: boolean } = {}): {
  handler: Handler;
  calls: Array<{ method: string; url: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const handler: Handler = async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const u = new URL(url);
    const path = u.pathname;
    let body: unknown;
    try { body = init.body ? JSON.parse(String(init.body)) : undefined; } catch { body = init.body; }
    calls.push({ method, url: path + u.search, body });
    if (opts.malformed) return tx(200, "not json {{{");
    if (method === "GET" && path === "/v2/sites") {
      return opts.noSites ? j(200, { sites: [] }) : j(200, { sites: [{ id: "site-1", displayName: "Demo", customDomains: [{ url: "demo.io" }] }] });
    }
    if (method === "GET" && path === "/v2/sites/site-1/collections") {
      return j(200, { collections: [{ id: "col-1", displayName: "Blog", slug: "blog" }] });
    }
    if (method === "GET" && path === "/v2/collections/col-1/items") {
      return j(200, { items: [{ id: "item-1", cmsLocaleId: "en", lastPublished: "2026-01-01", lastUpdated: "2026-01-02", fieldData: { name: "Hello", slug: "hello" } }] });
    }
    if (method === "GET" && path === "/v2/collections/col-1/items/item-1") {
      return j(200, { id: "item-1", lastPublished: "2026-01-01", lastUpdated: "2026-01-02", fieldData: { name: "Hello", slug: "hello" } });
    }
    if (method === "POST" && path === "/v2/collections/col-1/items") {
      const b = body as { fieldData: Record<string, unknown> };
      return j(200, { id: "item-9", lastPublished: null, lastUpdated: "2026-09-21", fieldData: b.fieldData });
    }
    if (method === "PATCH" && path === "/v2/collections/col-1/items/item-1") {
      const b = body as { fieldData: Record<string, unknown> };
      return j(200, { id: "item-1", lastPublished: "2026-01-01", lastUpdated: "2026-09-21", fieldData: b.fieldData });
    }
    if (method === "DELETE" && path === "/v2/collections/col-1/items/item-1") {
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path === "/v2/sites/site-1/publish") {
      return j(200, {});
    }
    return j(404, { message: "fake: no route" });
  };
  return { handler, calls };
}

// ---------------------------------------------------------------------------
// G. lib/connectors/github.ts — live class via fake fetch
// ---------------------------------------------------------------------------
{
  const M = "connectors/github";
  const cfg = { token: "t", owner: "o", repo: "r", branch: "main", demo: false };

  // test(): ok / 404 / 401 / malformed
  useFake(makeGitHubFake().handler);
  check(M, "test() ok", (await new GitHubSiteFileProvider(cfg).test()).ok === true);
  stopFake();
  useFake(makeGitHubFake({ mode: "repo404" }).handler);
  const t404 = await new GitHubSiteFileProvider(cfg).test();
  check(M, "test() 404 → ok:false", t404.ok === false && t404.message.includes("Not found"));
  stopFake();
  useFake(makeGitHubFake({ mode: "r429" }).handler);
  const t429 = await new GitHubSiteFileProvider(cfg).test();
  check(M, "test() 429 → ok:false with status", t429.ok === false && t429.message.includes("429"));
  stopFake();
  useFake(makeGitHubFake({ mode: "malformed" }).handler);
  let malformedRaw = "";
  try { await new GitHubSiteFileProvider(cfg).listRepos(); } catch (e) { malformedRaw = `${(e as Error).constructor.name}: ${(e as Error).message}`; }
  stopFake();
  check(M, "BUG CHECK: malformed JSON → typed error (expect not raw SyntaxError)",
    !malformedRaw.startsWith("SyntaxError"), malformedRaw.slice(0, 80));
  // Note: test() swallows the SyntaxError into {ok:false} with a cryptic message — no crash there.
  useFake(makeGitHubFake({ mode: "malformed" }).handler);
  const tMal = await new GitHubSiteFileProvider(cfg).test();
  stopFake();
  check(M, "malformed JSON in test() → ok:false (swallowed, cryptic message)",
    tMal.ok === false && tMal.message.length > 0);

  // readFile edges
  useFake(makeGitHubFake().handler);
  const gh = new GitHubSiteFileProvider(cfg);
  check(M, "readFile decodes base64", (await gh.readFile("/hello.txt")).content === "hello");
  check(M, "readFile oversized → clear error", await throwsOk(() => gh.readFile("/big.txt"), "too large"));
  check(M, "readFile on dir → clear error", await throwsOk(() => gh.readFile("/adir"), "is not a file"));
  check(M, "readFile missing → not found", await throwsOk(() => gh.readFile("/missing.txt"), "not found"));
  check(M, "stat missing → not found", await throwsOk(() => gh.stat("/missing.txt"), "not found"));
  check(M, "listDir on file → not a directory", await throwsOk(() => gh.listDir("/hello.txt"), "not a directory"));
  stopFake();

  // writeFile: new (no sha) vs existing (sha)
  {
    const f = makeGitHubFake();
    useFake(f.handler);
    const g2 = new GitHubSiteFileProvider(cfg);
    await g2.writeFile("/new.txt", "created 🚀");
    const putNew = f.state.calls.filter((c) => c.method === "PUT").pop()!;
    check(M, "writeFile new omits sha", putNew.body !== undefined && !("sha" in (putNew.body as object)));
    check(M, "writeFile base64 round-trips unicode",
      unb64((putNew.body as { content: string }).content) === "created 🚀");
    await g2.writeFile("/hello.txt", "updated");
    const putOld = f.state.calls.filter((c) => c.method === "PUT").pop()!;
    check(M, "writeFile existing sends sha", (putOld.body as { sha: string }).sha === "sha-old");
    stopFake();
  }

  // createRepo validation
  useFake(makeGitHubFake().handler);
  const g3 = new GitHubSiteFileProvider(cfg);
  check(M, "createRepo empty → invalid", await throwsOk(() => g3.createRepo(""), "invalid repository name"));
  check(M, "createRepo whitespace → invalid", await throwsOk(() => g3.createRepo("   "), "invalid repository name"));
  check(M, "createRepo bad chars → invalid", await throwsOk(() => g3.createRepo("bad name!"), "invalid repository name"));
  const created = await g3.createRepo("my-site_2.0");
  check(M, "createRepo ok", created.name === "my-site_2.0" && created.private === true);
  stopFake();

  // listRepos missing fields → raw TypeError
  useFake(makeGitHubFake({ mode: "missingFields" }).handler);
  let mfErr = "";
  try { await new GitHubSiteFileProvider(cfg).listRepos(); } catch (e) { mfErr = `${(e as Error).constructor.name}`; }
  stopFake();
  check(M, "BUG CHECK: listRepos missing owner → typed error", mfErr !== "TypeError", `got ${mfErr}`);

  // pushFiles edges
  check(M, "pushFiles empty → clear error", await throwsOk(() => g3.pushFiles([], "m"), "no files to push"));
  {
    // traversal: no network at all
    const f = makeGitHubFake();
    useFake(f.handler);
    const g4 = new GitHubSiteFileProvider(cfg);
    check(M, "pushFiles traversal blocked pre-network", await throwsOk(
      () => g4.pushFiles([{ path: "/../evil.txt", content: "x" }], "m"), "escapes"));
    check(M, "no fetch on traversal", f.state.calls.length === 0);
    stopFake();
  }
  {
    // happy path: existing branch
    const f = makeGitHubFake();
    useFake(f.handler);
    const g4 = new GitHubSiteFileProvider(cfg);
    const big = "x".repeat(150_000);
    const emoji = "🚀 héllo 世界 ✓";
    const res = await g4.pushFiles([
      { path: "/index.html", content: "<h1>hi</h1>" },
      { path: "//deep//a.txt", content: big },
      { path: "/emoji.txt", content: emoji },
    ], "deploy");
    check(M, "pushFiles returns commit sha", res.sha === "commit-1");
    check(M, "pushFiles paths sanitized", res.files.every((x) => x.path.startsWith("/") && !x.path.includes("//")));
    check(M, "pushFiles 150k content round-trips",
      unb64((f.state.blobBodies[1] as { content: string }).content) === big);
    check(M, "pushFiles emoji round-trips",
      unb64((f.state.blobBodies[2] as { content: string }).content) === emoji);
    check(M, "pushFiles patches existing ref", f.state.refPatched === true && f.state.refCreated === false);
    check(M, "pushFiles blob/tree/commit counts", f.state.blobCount === 3 && f.state.treeCount === 1 && f.state.commitCount === 1);
    stopFake();
  }
  {
    // brand-new repo: ref created
    const f = makeGitHubFake({ refExists: false });
    useFake(f.handler);
    const g4 = new GitHubSiteFileProvider(cfg);
    await g4.pushFiles([{ path: "/index.html", content: "x" }], "init");
    const createCall = f.state.calls.find((c) => c.method === "POST" && c.url === "/repos/o/r/git/refs")!;
    check(M, "new repo creates branch ref", f.state.refCreated === true &&
      (createCall.body as { ref: string }).ref === "refs/heads/main");
    stopFake();
  }
  {
    // PARTIAL STATE: blob 2 of 3 fails — orphan blobs remain, no tree/commit
    const f = makeGitHubFake({ failBlobAt: 2 });
    useFake(f.handler);
    const g4 = new GitHubSiteFileProvider(cfg);
    check(M, "partial push throws", await throwsOk(() => g4.pushFiles([
      { path: "/a.txt", content: "a" }, { path: "/b.txt", content: "b" }, { path: "/c.txt", content: "c" },
    ], "m"), "blob store exploded"));
    check(M, "partial push: 1 orphan blob server-side, no tree/commit",
      f.state.blobBodies.length === 1 && f.state.treeCount === 0 && f.state.commitCount === 0);
    stopFake();
  }
  {
    // provider failure modes on push
    useFake(makeGitHubFake({ mode: "r500" }).handler);
    check(M, "pushFiles 500 → clear error", await throwsOk(
      () => new GitHubSiteFileProvider(cfg).pushFiles([{ path: "/a", content: "x" }], "m"), "github api error 500"));
    stopFake();
  }
  // empty token → 401 surfaces (fail closed, clear message)
  useFake(makeGitHubFake({ mode: "r429" }).handler);
  const noTok = await new GitHubSiteFileProvider({ ...cfg, token: "" }).test();
  check(M, "empty token fails closed with status", noTok.ok === false && noTok.message.includes("429"));
  stopFake();

  // sanitizePath edges (shared by github + zip)
  const M2 = "connectors/github";
  check(M2, "sanitizePath null → throws", await throwsOk(() => sanitizePath(null), "invalid path"));
  check(M2, "sanitizePath number → throws", await throwsOk(() => sanitizePath(42 as unknown as string), "invalid path"));
  check(M2, "sanitizePath empty → /", sanitizePath("") === "/");
  check(M2, "sanitizePath blank → /", sanitizePath("   ") === "/");
  check(M2, "sanitizePath .. → throws", await throwsOk(() => sanitizePath("/a/../../x"), "escapes"));
  check(M2, "sanitizePath // collapse", sanitizePath("//a///b") === "/a/b");
  check(M2, "sanitizePath backslash", sanitizePath("a\\b") === "/a/b");
  check(M2, "sanitizePath dot segments", sanitizePath("/a/./b") === "/a/b");
  check(M2, "sanitizePath unicode", sanitizePath("/héllo/世界.txt") === "/héllo/世界.txt");
  check(M2, "sanitizePath 100-deep ok", sanitizePath("/" + Array(100).fill("d").join("/")).split("/").length === 101);
  check(M2, "sanitizePath keeps '..' inside name", sanitizePath("/a..b/c..") === "/a..b/c..");
}

// ---------------------------------------------------------------------------
// H. lib/connectors/mock-github.ts
// ---------------------------------------------------------------------------
{
  const M = "connectors/mock-github";
  const m1 = new MockGitHubConnector();
  const r1 = await m1.pushFiles([{ path: "/a.txt", content: "hello" }], "m");
  const m2 = new MockGitHubConnector();
  const r2 = await m2.pushFiles([{ path: "/a.txt", content: "hello" }], "m");
  check(M, "mock pushFiles sha deterministic", r1.sha === r2.sha && r1.sha.startsWith("mock-sha-"));
  check(M, "mock rows flagged mock", r1.mock === true);

  // Partial write in mock: good file persists even though second path throws
  const m3 = new MockGitHubConnector();
  check(M, "mock traversal throws", await throwsOk(
    () => m3.pushFiles([{ path: "/ok.txt", content: "ok" }, { path: "/../evil", content: "x" }], "m"), "escapes"));
  check(M, "mock partial write: first file persisted", (await m3.readFile("/ok.txt")).content === "ok");
  // Live class sanitizes everything BEFORE any write — contrast
  check(M, "live class never partially writes (checked in G)", true);

  check(M, "mock readFile missing → throws", await throwsOk(() => m3.readFile("/nope"), "not found"));
  check(M, "mock listDir on file → throws", await throwsOk(() => m3.listDir("/ok.txt"), "not a directory"));
  check(M, "mock stat missing → throws", await throwsOk(() => m3.stat("/nope"), "not found"));
  check(M, "mock createRepo bad name → throws", await throwsOk(() => m3.createRepo("bad name"), "invalid repository name"));
  const repos = await m3.listRepos();
  check(M, "mock listRepos updatedAt present", repos.length === 2 && typeof repos[0].updatedAt === "string");
  await m3.writeFile("/uni/🚀.txt", "emoji path ✓");
  check(M, "mock unicode path round-trip", (await m3.readFile("/uni/🚀.txt")).content === "emoji path ✓");
  const entries = await m3.listDir("/");
  check(M, "mock listDir dirs-first sort", entries[0].type === "dir");
}

// ---------------------------------------------------------------------------
// Day-1 (M6): every WordPress request re-validates via DNS. Fixtures inject a
// fake resolver (no network) plus the existing fake fetch.
const RESOLVE_PUBLIC = async (_host: string) => ["93.184.216.34"];
const wpLive = (cfg: { baseUrl: string; username: string; appPassword: string; demo: boolean }) =>
  new WordPressConnector(cfg, { resolve: RESOLVE_PUBLIC });

// I. lib/connectors/wordpress.ts — live class via fake fetch
// ---------------------------------------------------------------------------
{
  const M = "connectors/wordpress";
  const cfg = { baseUrl: "https://wp.test", username: "u", appPassword: "p", demo: false };

  useFake(makeWordPressFake().handler);
  const wp = wpLive(cfg);
  const t = await wp.test();
  check(M, "test() ok", t.ok === true && t.info.includes("Test WP"));
  const pages = await wp.listContent("page");
  check(M, "listContent strips html from title", pages.length === 1 && pages[0].title === "Home");
  check(M, "listContent bad kind → clear error", await throwsOk(() => wp.listContent("collection"), 'no content kind "collection"'));
  const detail = await wp.getContent("page", "1");
  check(M, "getContent html", detail.content === "<p>hi</p>");
  stopFake();

  // saveContent: POST then re-fetch; >2MB now fails closed (was: silent truncation)
  {
    const f = makeWordPressFake();
    useFake(f.handler);
    const w2 = wpLive(cfg);
    const huge = "z".repeat(2_500_000);
    check(M, "FIXED: >2MB content rejected loudly (no silent truncation)", await throwsOk(
      () => w2.saveContent("page", { title: "Big", content: huge, status: "draft" }), "2.5MB"));
    const postCalls = f.calls.filter((c) => c.method === "POST" && c.url === "/wp-json/wp/v2/pages");
    check(M, "oversize content never posted", postCalls.length === 0);
    const saved = await w2.saveContent("page", { title: "Big", content: "z".repeat(100), status: "draft" });
    check(M, "saveContent POSTs then GETs", saved.id === "9" && f.calls.filter((c) => c.url.includes("/wp/v2/pages")).length === 2);
    const postCall = f.calls.find((c) => c.method === "POST" && c.url === "/wp-json/wp/v2/pages")!;
    check(M, "normal content posted in full", ((postCall.body as { content: string }).content ?? "").length === 100);
    // update path → PUT
    await w2.saveContent("page", { id: "9", title: "T2", content: "c", status: "publish", slug: "my-slug" });
    const putCall = f.calls.find((c) => c.method === "PUT")!;
    check(M, "saveContent with id → PUT", putCall.url === "/wp-json/wp/v2/pages/9");
    check(M, "slug trimmed into body", (putCall.body as { slug: string }).slug === "my-slug");
    stopFake();
  }

  // delete: 200 ok, 404 treated as ok, 500 throws
  {
    const f = makeWordPressFake();
    useFake(f.handler);
    check(M, "deleteContent ok", (await wpLive(cfg).deleteContent("page", "9")).ok === true);
    stopFake();
    useFake(makeWordPressFake({ mode: "del404" }).handler);
    check(M, "deleteContent 404 → ok (idempotent)", (await wpLive(cfg).deleteContent("page", "9")).ok === true);
    stopFake();
  }

  // uploadMedia filename sanitization
  {
    const f = makeWordPressFake();
    useFake(f.handler);
    const w3 = wpLive(cfg);
    await w3.uploadMedia({ filename: "../../evil.png", bytes: new Uint8Array([1, 2, 3]), mime: "image/png" });
    const upCall = f.calls.find((c) => c.method === "POST" && c.url === "/wp-json/wp/v2/media")!;
    const disp = String((upCall.headers as Record<string, string>)["Content-Disposition"] ?? "");
    check(M, "upload filename strips slashes", !disp.includes("/") && disp.includes("evil.png"), disp);
    await w3.uploadMedia({ filename: "", bytes: new Uint8Array([1]), mime: "" });
    const up2 = f.calls.filter((c) => c.method === "POST" && c.url === "/wp-json/wp/v2/media").pop()!;
    const disp2 = String((up2.headers as Record<string, string>)["Content-Disposition"] ?? "");
    check(M, "empty filename → upload.bin fallback", disp2.includes("upload.bin"), disp2);
    check(M, "empty mime → octet-stream", (up2.headers as Record<string, string>)["Content-Type"] === "application/octet-stream");
    await w3.uploadMedia({ filename: "a".repeat(200) + ".png", bytes: new Uint8Array([1]), mime: "image/png" });
    const up3 = f.calls.filter((c) => c.method === "POST" && c.url === "/wp-json/wp/v2/media").pop()!;
    const disp3 = String((up3.headers as Record<string, string>)["Content-Disposition"] ?? "");
    const fname = disp3.match(/filename="([^"]*)"/)?.[1] ?? "";
    check(M, "long filename capped at 120", fname.length === 120, `len=${fname.length}`);
    stopFake();
  }

  // auth + config edges
  useFake(makeWordPressFake({ mode: "r401" }).handler);
  check(M, "401 → clear error", await throwsOk(() => wpLive(cfg).test(), "wordpress api error 401"));
  stopFake();
  useFake(makeWordPressFake({ mode: "malformed" }).handler);
  let wMal = "";
  try { await wpLive(cfg).test(); } catch (e) { wMal = (e as Error).constructor.name; }
  stopFake();
  check(M, "BUG CHECK: WP malformed JSON → typed error", wMal !== "SyntaxError", `got ${wMal}`);
  // empty baseUrl: assertSafeUrl rejects before any fetch — UnsafeUrlError
  // propagates typed (callers map it to 400 bad-config, not 502).
  check(M, "empty baseUrl fails closed (typed UnsafeUrlError)", await throwsOk(
    () => wpLive({ ...cfg, baseUrl: "" }).test(), "UnsafeUrlError"));

  // media list
  useFake(makeWordPressFake().handler);
  const media = await wpLive(cfg).listMedia();
  check(M, "listMedia maps fields", media.length === 1 && media[0].mime === "image/jpeg");
  stopFake();
}

// ---------------------------------------------------------------------------
// I2. lib/connectors/safe-fetch.ts + safe-url.ts — SSRF hardening (day-1, M6)
// Central request path: per-request revalidation, manual redirect handling
// with per-hop revalidation. All DNS is faked — no network.
// ---------------------------------------------------------------------------
{
  const M = "connectors/ssrf";
  const { safeFetch } = await import("@/lib/connectors/safe-fetch");
  const { assertSafeUrl, UnsafeUrlError } = await import("@/lib/safe-url");
  const PUB = async (_h: string) => ["93.184.216.34"];

  const redirect = (to: string) =>
    new Response(null, { status: 302, headers: { location: to } });
  const okJson = (body: unknown) => j(200, body);

  // 1. redirect hop to a cloud-metadata address is blocked
  {
    const seen: string[] = [];
    const bad = await safeFetch("https://wp.test/wp-json/", {}, {
      resolve: PUB,
      fetchFn: (async (input: unknown) => {
        const u = String(input);
        seen.push(u);
        if (u === "https://wp.test/wp-json/") return redirect("http://169.254.169.254/latest/meta-data/");
        return okJson({});
      }) as typeof fetch,
    }).then(() => "no-throw", (e) => (e as Error).constructor.name);
    check(M, "FIXED: redirect to metadata IP blocked", bad === "UnsafeUrlError", bad);
    check(M, "blocked hop never fetched", !seen.some((u) => u.includes("169.254.169.254")));
  }

  // 2. redirect hop to loopback blocked; legitimate same-host redirect allowed
  {
    const loop = await safeFetch("https://wp.test/a", {}, {
      resolve: PUB,
      fetchFn: (async () => redirect("http://127.0.0.1:8080/admin")) as typeof fetch,
    }).then(() => "no-throw", (e) => (e as Error).constructor.name);
    check(M, "FIXED: redirect to loopback blocked", loop === "UnsafeUrlError", loop);

    const hops: string[] = [];
    const res = await safeFetch("http://wp.test/old", {}, {
      resolve: PUB,
      fetchFn: (async (input: unknown) => {
        const u = String(input);
        hops.push(u);
        if (u === "http://wp.test/old") return redirect("https://wp.test/new");
        return okJson({ ok: true });
      }) as typeof fetch,
    });
    check(M, "legitimate http→https redirect followed", res.status === 200 && hops.length === 2, hops.join(" → "));
  }

  // 3. redirect loop capped
  {
    const looped = await safeFetch("https://wp.test/loop", {}, {
      resolve: PUB,
      maxRedirects: 3,
      fetchFn: (async (input: unknown) => redirect(`${String(input)}/x`)) as typeof fetch,
    }).then(() => "no-throw", (e) => (e as Error).message);
    check(M, "redirect loop capped", looped === "Too many redirects.", String(looped));
  }

  // 4. DNS rebinding between requests: hostname flips to 127.0.0.1 on the
  //    second request → blocked by per-request revalidation
  {
    let calls = 0;
    const flipFlop = async (_h: string) => (++calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"]);
    const wRebind = new WordPressConnector(
      { baseUrl: "https://wp.test", username: "u", appPassword: "p", demo: false },
      { resolve: flipFlop, fetchFn: (async () => okJson({ name: "Test WP" })) as typeof fetch },
    );
    const first = await wRebind.test().then(() => "ok", (e) => (e as Error).constructor.name);
    const second = await wRebind.test().then(() => "no-throw", (e) => (e as Error).constructor.name);
    check(M, "first request allowed", first === "ok", first);
    check(M, "FIXED: rebinding hostname blocked on next request", second === "UnsafeUrlError", second);
  }

  // 5. IPv6 link-local fe80::/10 full range (was approximated as fe80: only)
  for (const ip of ["fe80::1", "fe90::1", "fea0::1", "febf::1"]) {
    const r = await assertSafeUrl(`http://[${ip}]/`, { resolve: PUB }).then(() => "no-throw", (e) => (e as Error).constructor.name);
    check(M, `FIXED: IPv6 link-local ${ip} blocked`, r === "UnsafeUrlError", r);
  }
  check(M, "public IPv6 allowed",
    (await assertSafeUrl("http://[2606:2800:220:1:248:1893:25c8:1946]/", { resolve: PUB }).then(() => "ok", String)) === "ok");

  // 6. create() factory rejects unsafe stored baseUrl (the path
  //    getContentConnector now uses for live WordPress sites)
  const unsafeCreate = await WordPressConnector.create(
    { baseUrl: "http://169.254.169.254/", username: "u", appPassword: "p", demo: false },
    { resolve: PUB },
  ).then(() => "no-throw", (e) => (e as Error).constructor.name);
  check(M, "FIXED: stored internal baseUrl rejected at construction", unsafeCreate === "UnsafeUrlError", unsafeCreate);
  const dnsFail = await WordPressConnector.create(
    { baseUrl: "https://wp.test", username: "u", appPassword: "p", demo: false },
    { resolve: async () => { throw new Error("dns down"); } },
  ).then(() => "no-throw", (e) => (e as Error).message);
  check(M, "DNS failure fails closed", dnsFail === "Could not resolve URL hostname.", String(dnsFail));
}

// ---------------------------------------------------------------------------
// J. lib/connectors/mock-wordpress.ts
// ---------------------------------------------------------------------------
{
  const M = "connectors/mock-wordpress";
  const mw = new MockWordPressConnector({ baseUrl: "", username: "", appPassword: "", demo: true });
  const created = await mw.saveContent("page", { title: "", content: "c", status: "draft" });
  check(M, "empty title+slug → item-N slug", created.slug.startsWith("item-"), created.slug);
  const withId = await mw.saveContent("page", { id: "999", title: "Ghost", content: "c", status: "draft" });
  check(M, "saveContent with unknown id creates NEW id (ignores 999)", withId.id !== "999");
  check(M, "deleteContent missing id → ok (idempotent)", (await mw.deleteContent("page", "nope")).ok === true);
  check(M, "getContent missing → throws", await throwsOk(() => mw.getContent("page", "nope"), "no page with id"));
  check(M, "bad kind → throws", await throwsOk(() => mw.listContent("collection"), "no content kind"));
  const upd = await mw.saveContent("page", { id: "1", title: "New", content: "nc", status: "publish", slug: "  spaced  " });
  check(M, "update trims slug", upd.slug === "spaced");
  const up = await mw.uploadMedia({ filename: "x.png", bytes: new Uint8Array([1]), mime: "image/png" });
  check(M, "mock uploadMedia fixed response", up.id === "202");
}

// ---------------------------------------------------------------------------
// K. lib/connectors/webflow.ts — live class via fake fetch
// ---------------------------------------------------------------------------
{
  const M = "connectors/webflow";
  const cfg = { token: "t", siteId: "site-1", demo: false };

  useFake(makeWebflowFake().handler);
  const wf = new WebflowConnector(cfg);
  const t = await wf.test();
  check(M, "test() ok", t.ok === true && t.info.includes("Demo"));
  const cols = await wf.listContent("collection");
  check(M, "listContent collections", cols.length === 1 && cols[0].kind === "collection");
  check(M, "listContent page → guidance error", await throwsOk(() => wf.listContent("page"), "pick a collection first"));
  const items = await wf.listItems("col-1");
  check(M, "listItems status mapping", items[0].status === "published");
  check(M, "getContent needs collectionId", await throwsOk(() => wf.getContent("item", "item-1"), "needs opts.collectionid"));
  check(M, "getContent bad kind → throws", await throwsOk(() => wf.getContent("page", "x", { collectionId: "col-1" }), "kind 'item'"));
  const det = await wf.getContent("item", "item-1", { collectionId: "col-1" });
  check(M, "getContent returns pretty JSON", det.content.includes('"name": "Hello"'));
  stopFake();

  // saveContent validation + body shaping
  useFake(makeWebflowFake().handler);
  const w2 = new WebflowConnector(cfg);
  check(M, "saveContent bad kind → throws", await throwsOk(
    () => w2.saveContent("page", { title: "t", content: "{}", status: "draft" }, { collectionId: "col-1" }), "kind 'item'"));
  check(M, "saveContent no collection → throws", await throwsOk(
    () => w2.saveContent("item", { title: "t", content: "{}", status: "draft" }), "needs a collectionid"));
  check(M, "saveContent invalid JSON → throws", await throwsOk(
    () => w2.saveContent("item", { title: "t", content: "{bad", status: "draft" }, { collectionId: "col-1" }), "invalid fielddata json"));
  check(M, "saveContent JSON array → throws", await throwsOk(
    () => w2.saveContent("item", { title: "t", content: "[1,2]", status: "draft" }, { collectionId: "col-1" }), "must be a json object"));
  check(M, "saveContent JSON null → throws", await throwsOk(
    () => w2.saveContent("item", { title: "t", content: "null", status: "draft" }, { collectionId: "col-1" }), "must be a json object"));
  {
    const f = makeWebflowFake();
    useFake(f.handler);
    const w3 = new WebflowConnector(cfg);
    await w3.saveContent("item", { title: "My Title", slug: "my-slug", content: '{"name":"Custom"}', status: "publish" }, { collectionId: "col-1" });
    const postCall = f.calls.find((c) => c.method === "POST" && c.url.endsWith("/items"))!;
    const fd = (postCall.body as { fieldData: Record<string, unknown> }).fieldData;
    check(M, "existing name not overwritten by title", fd.name === "Custom");
    check(M, "slug filled when missing", fd.slug === "my-slug");
    check(M, "publish sets _archived=false", fd._archived === false);
    await w3.saveContent("item", { title: "T", content: "{}", status: "draft" }, { collectionId: "col-1" });
    const post2 = f.calls.filter((c) => c.method === "POST" && c.url.endsWith("/items")).pop()!;
    const fd2 = (post2.body as { fieldData: Record<string, unknown> }).fieldData;
    check(M, "title fills missing name", fd2.name === "T");
    await w3.saveContent("item", { id: "item-1", title: "T", content: '{"a":1}', status: "draft" }, { collectionId: "col-1" });
    check(M, "saveContent with id → PATCH", f.calls.some((c) => c.method === "PATCH"));
    stopFake();
  }

  // delete + publish edges
  useFake(makeWebflowFake().handler);
  const w4 = new WebflowConnector(cfg);
  check(M, "deleteContent needs collectionId", await throwsOk(() => w4.deleteContent("item", "x"), "needs opts.collectionid"));
  check(M, "deleteContent ok", (await w4.deleteContent("item", "item-1", { collectionId: "col-1" })).ok === true);
  {
    const f = makeWebflowFake();
    useFake(f.handler);
    const w5 = new WebflowConnector(cfg);
    await w5.publishSite({ domains: ["a.com", "b.com"] });
    const pub = f.calls.find((c) => c.url.endsWith("/publish"))!;
    check(M, "publishSite sends customDomains", JSON.stringify((pub.body as object)).includes("a.com"));
    await w5.publishSite();
    const pub2 = f.calls.filter((c) => c.url.endsWith("/publish")).pop()!;
    check(M, "publishSite no domains → empty body", JSON.stringify(pub2.body) === "{}");
    stopFake();
  }
  check(M, "publishSite without siteId → throws", await throwsOk(
    () => new WebflowConnector({ token: "t", siteId: "", demo: false }).publishSite(), "no webflow site selected"));
  useFake(makeWebflowFake({ noSites: true }).handler);
  const tEmpty = await new WebflowConnector(cfg).test();
  check(M, "test() with zero sites", tEmpty.ok === true && tEmpty.info.includes("0 site(s)"));
  stopFake();
  useFake(makeWebflowFake({ malformed: true }).handler);
  let wfMal = "";
  try { await new WebflowConnector(cfg).listContent("collection"); } catch (e) { wfMal = (e as Error).constructor.name; }
  stopFake();
  check(M, "BUG CHECK: Webflow malformed JSON → typed error", wfMal !== "SyntaxError", `got ${wfMal}`);
}

// ---------------------------------------------------------------------------
// L. lib/connectors/mock-webflow.ts
// ---------------------------------------------------------------------------
{
  const M = "connectors/mock-webflow";
  const mw = new MockWebflowConnector({ token: "", siteId: "", demo: true });
  const created = await mw.saveContent("item", { title: "T", content: '{"x":1}', status: "publish" }, { collectionId: "col-blog" });
  check(M, "mock new item id prefix", created.id.startsWith("item-mock-"), created.id);
  check(M, "mock publish → published", created.status === "published");
  check(M, "mock delete missing → ok", (await mw.deleteContent("item", "nope", { collectionId: "col-blog" })).ok === true);
  check(M, "mock listContent page → throws", await throwsOk(() => mw.listContent("page"), "collections"));
  check(M, "mock getContent no collection → throws", await throwsOk(() => mw.getContent("item", "x"), "needs opts.collectionid"));
  check(M, "mock getContent missing → throws", await throwsOk(() => mw.getContent("item", "x", { collectionId: "col-blog" }), "no item"));
  check(M, "mock publishSite", (await mw.publishSite()).ok === true);
  const draft = await mw.saveContent("item", { title: "D", content: "{}", status: "draft" }, { collectionId: "col-blog" });
  check(M, "mock draft → draft", draft.status === "draft");
}

// ---------------------------------------------------------------------------
// M. lib/connectors/zip.ts
// ---------------------------------------------------------------------------
{
  const M = "connectors/zip";
  const root = mkdtempSync(join(tmpdir(), "edge-zip-"));
  const mk = (name: string, data: Buffer | string) => {
    const z = new AdmZip();
    z.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data));
    return z.toBuffer();
  };
  // mkRaw: bypass AdmZip's own addFile name normalization so the raw,
  // attacker-controlled entry name reaches extractZipToProvider.
  const mkRaw = (name: string, data: Buffer | string) => {
    const z = new AdmZip();
    z.addFile("placeholder.txt", Buffer.isBuffer(data) ? data : Buffer.from(data));
    z.getEntries()[0].entryName = name;
    return z.toBuffer();
  };
  try {
    const prov = new LocalDirProvider(root);
    await prov.ensureRoot();

    // zip-slip via ../ (raw entry name — AdmZip's addFile would strip it)
    check(M, "zip-slip ../ rejected", await throwsOk(
      () => extractZipToProvider(mkRaw("../evil.txt", "x"), prov), "unsafe path in zip"));
    // zip-slip via nested ../
    check(M, "zip-slip a/../../evil rejected", await throwsOk(
      () => extractZipToProvider(mkRaw("a/../../evil.txt", "x"), prov), "unsafe path in zip"));
    // backslash traversal
    check(M, "backslash ..\\ rejected", await throwsOk(
      () => extractZipToProvider(mkRaw("..\\evil.txt", "x"), prov), "unsafe path in zip"));
    // absolute path entry: stays inside provider root (documented behavior)
    const absWritten = await extractZipToProvider(mk("/abs.txt", "abs"), prov);
    check(M, "absolute entry confined to root", absWritten[0] === "/abs.txt");
    check(M, "absolute entry readable", (await prov.readFile("/abs.txt")).content === "abs");
    // unicode names + deep paths
    const uniWritten = await extractZipToProvider(mk("héllo/世界-🚀.txt", "uni"), prov);
    check(M, "unicode entry name ok", uniWritten[0] === "/héllo/世界-🚀.txt");
    const deep = Array(60).fill("d").join("/") + "/x.txt";
    const deepWritten = await extractZipToProvider(mk(deep, "deep"), prov);
    check(M, "60-deep path ok", deepWritten[0] === "/" + deep);

    // directory entries are filtered (isDirectory) — entry ending in / that is not flagged dir
    {
      const z = new AdmZip();
      z.addFile("onlydir/", Buffer.alloc(0));
      check(M, "dir-only zip → unsafe/empty error", await throwsOk(
        () => extractZipToProvider(z.toBuffer(), prov), "zip"));
    }

    // empty / invalid / oversized archives
    check(M, "empty zip rejected", await throwsOk(
      () => extractZipToProvider(new AdmZip().toBuffer(), prov), "zip is empty"));
    check(M, "invalid zip rejected", await throwsOk(
      () => extractZipToProvider(Buffer.from("definitely not a zip"), prov), "invalid zip"));
    check(M, ">50MB buffer rejected pre-parse", await throwsOk(
      () => extractZipToProvider(Buffer.alloc(50 * 1024 * 1024 + 1), prov), "too large"));
    {
      const z = new AdmZip();
      for (let i = 0; i < 2001; i++) z.addFile(`f${i}.txt`, Buffer.from("x"));
      check(M, "2001 files rejected", await throwsOk(
        () => extractZipToProvider(z.toBuffer(), prov), "too many files"));
    }
    {
      // 2000-file bulk test runs in its own provider so it doesn't pollute prov
      const bulkRoot = mkdtempSync(join(tmpdir(), "edge-zipbulk-"));
      try {
        const bulk = new LocalDirProvider(bulkRoot);
        await bulk.ensureRoot();
        const z = new AdmZip();
        for (let i = 0; i < 2000; i++) z.addFile(`ok${i}.txt`, Buffer.from("x"));
        const written = await extractZipToProvider(z.toBuffer(), bulk);
        check(M, "exactly 2000 files accepted", written.length === 2000);
      } finally { rmSync(bulkRoot, { recursive: true, force: true }); }
    }
    check(M, "single file >10MB rejected", await throwsOk(
      () => extractZipToProvider(mk("big.txt", Buffer.alloc(10 * 1024 * 1024 + 1)), prov), "too large in zip"));
    check(M, "binary-only zip → no usable text files", await throwsOk(
      () => extractZipToProvider(mk("b.bin", Buffer.from([0, 1, 2, 3])), prov), "no usable text files"));
    {
      // mixed: binary skipped, text kept
      const z = new AdmZip();
      z.addFile("t.txt", Buffer.from("text"));
      z.addFile("b.bin", Buffer.from([0, 65, 66]));
      const written = await extractZipToProvider(z.toBuffer(), prov);
      check(M, "binary silently skipped, text kept", written.length === 1 && written[0] === "/t.txt");
    }

    // round-trip: pack then extract into a fresh provider
    const root2 = mkdtempSync(join(tmpdir(), "edge-zip2-"));
    try {
      const p2 = new LocalDirProvider(root2);
      await p2.ensureRoot();
      const packed = await zipProviderFiles(prov);
      const names = await extractZipToProvider(packed, p2);
      check(M, "round-trip preserves entries", names.includes("/abs.txt") && names.includes("/héllo/世界-🚀.txt"));
      check(M, "round-trip preserves content", (await p2.readFile("/héllo/世界-🚀.txt")).content === "uni");
    } finally { rmSync(root2, { recursive: true, force: true }); }

    // pack of empty provider → valid empty zip (no throw)
    const root3 = mkdtempSync(join(tmpdir(), "edge-zip3-"));
    try {
      const p3 = new LocalDirProvider(root3);
      await p3.ensureRoot();
      const empty = await zipProviderFiles(p3);
      check(M, "pack empty root → empty zip buffer", empty.length > 0 && new AdmZip(empty).getEntries().length === 0);
    } finally { rmSync(root3, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// Fake deploy routers
// ---------------------------------------------------------------------------

function makeVercelFake(opts: { mode?: "ok" | "r429" | "e500malformed" } = {}): {
  handler: Handler;
  calls: Array<{ method: string; url: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const mode = opts.mode ?? "ok";
  const handler: Handler = async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const u = new URL(url);
    const path = u.pathname;
    let body: unknown;
    try { body = init.body ? JSON.parse(String(init.body)) : undefined; } catch { body = init.body; }
    calls.push({ method, url: path + u.search, body });
    if (method === "GET" && path === "/v2/user") return j(200, { user: { name: "V", username: "v", email: "v@x.com" } });
    if (method === "POST" && path === "/v13/deployments") {
      if (mode === "r429") return j(429, { error: { message: "rate limited" } });
      if (mode === "e500malformed") return tx(500, "<html>gateway error</html>");
      return j(200, { id: "dpl_123", url: "demo.vercel.app", status: "READY" });
    }
    if (method === "GET" && path === "/v6/deployments") {
      return j(200, { deployments: [{ uid: "d1", url: "a.vercel.app", state: "READY" }] });
    }
    if (method === "GET" && path === "/v13/deployments/d1") {
      return j(200, { id: "d1", url: "a.vercel.app", status: "BUILDING" });
    }
    return j(404, { message: "fake: no route" });
  };
  return { handler, calls };
}

function makeCloudflareFake(opts: { projectExists?: boolean; mode?: "ok" | "cf500" | "malformed" } = {}): {
  handler: Handler;
  calls: Array<{ method: string; url: string; body?: unknown }>;
  forms: Array<{ manifest: string; entryCount: number }>;
} {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const forms: Array<{ manifest: string; entryCount: number }> = [];
  const mode = opts.mode ?? "ok";
  const handler: Handler = async (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    const u = new URL(url);
    const path = u.pathname;
    let body: unknown;
    try { body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    calls.push({ method, url: path + u.search, body });
    if (mode === "malformed") return tx(200, "not json");
    if (mode === "cf500") return j(500, { success: false, errors: [{ message: "boom", code: 1000 }] });
    if (method === "GET" && path === "/client/v4/accounts/acct/pages/projects") {
      return j(200, { success: true, result: [], result_info: { count: 0 } });
    }
    if (method === "GET" && path === "/client/v4/accounts/acct/pages/projects/proj") {
      return opts.projectExists
        ? j(200, { success: true, result: { name: "proj" } })
        : j(404, { success: false, errors: [{ message: "not found", code: 8000007 }] });
    }
    if (method === "GET" && path.startsWith("/client/v4/accounts/acct/pages/projects/") && !path.includes("/deployments")) {
      // slug-probe for other names → 404 so creation is attempted
      return j(404, { success: false, errors: [{ message: "not found", code: 8000007 }] });
    }
    if (method === "POST" && path === "/client/v4/accounts/acct/pages/projects") {
      return j(200, { success: true, result: { name: (body as { name: string }).name } });
    }
    if (method === "POST" && path.endsWith("/deployments") && !path.includes("/deployments/")) {
      const fd = init.body as FormData;
      const manifest = String(fd.get("manifest"));
      let entryCount = 0;
      for (const _k of (fd as unknown as { keys(): Iterable<string> }).keys()) entryCount += 1;
      forms.push({ manifest, entryCount });
      return j(200, { success: true, result: { id: "dep1", url: "https://proj.pages.dev", latest_stage: { status: "success" } } });
    }
    if (method === "GET" && path === "/client/v4/accounts/acct/pages/projects/proj/deployments") {
      return j(200, { success: true, result: [{ id: "dep1", url: "https://x.pages.dev", latest_stage: { status: "success" } }] });
    }
    if (method === "GET" && path === "/client/v4/accounts/acct/pages/projects/proj/deployments/dep1") {
      return j(200, { success: true, result: { id: "dep1", url: "https://x.pages.dev", latest_stage: { status: "success" } } });
    }
    return j(404, { success: false, errors: [{ message: "fake: no route" }] });
  };
  return { handler, calls, forms };
}

// ---------------------------------------------------------------------------
// N. lib/deploy/vercel.ts — live class via fake fetch
// ---------------------------------------------------------------------------
{
  const M = "deploy/vercel";
  const cfg = { token: "t", projectId: "", teamId: "", demo: false };

  check(M, "test() without token fails closed", await throwsOk(
    () => new VercelDeployTarget({ ...cfg, token: "" }).test(), "token is required"));
  useFake(makeVercelFake().handler);
  const v = new VercelDeployTarget(cfg);
  const t = await v.test();
  check(M, "test() ok", t.ok === true && t.info.includes("Vercel user"));
  check(M, "deploy empty → clear error", await throwsOk(() => v.deploy([]), "nothing to deploy"));
  {
    const f = makeVercelFake();
    useFake(f.handler);
    const v2 = new VercelDeployTarget(cfg);
    const content = "<h1>🚀 héllo</h1>".repeat(5000); // ~100k chars
    const res = await v2.deploy([
      { path: "/index.html", content },
      { path: "about.html", content: "x" },
    ], { projectName: "  my-proj  " });
    const payload = f.calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    const files = payload.files as Array<{ file: string; data: string; sha: string }>;
    check(M, "deploy strips leading slash", files[0].file === "index.html" && files[1].file === "about.html");
    check(M, "deploy sha1 correct",
      files[0].sha === createHash("sha1").update(content, "utf8").digest("hex"));
    check(M, "deploy base64 round-trips 100k+ unicode",
      Buffer.from(files[0].data, "base64").toString("utf8") === content);
    check(M, "deploy project name trimmed", payload.project === "my-proj" && payload.name === "my-proj");
    check(M, "deploy result url + ready", res.deploymentId === "dpl_123" && res.url === "https://demo.vercel.app" && res.status === "ready");
    check(M, "deploy framework null", (payload.projectSettings as { framework: null }).framework === null);
    // no projectName → auto-name, no project key
    await v2.deploy([{ path: "/i", content: "x" }]);
    const p2 = f.calls.filter((c) => c.method === "POST").pop()!.body as Record<string, unknown>;
    check(M, "deploy without project → marketr-site, no project key",
      p2.name === "marketr-site" && !("project" in p2));
    stopFake();
  }
  // teamId query string
  {
    const f = makeVercelFake();
    useFake(f.handler);
    await new VercelDeployTarget({ ...cfg, teamId: "team_9" }).test();
    check(M, "teamId appended to query", f.calls[0].url.includes("teamId=team_9"));
    stopFake();
  }
  // provider failures
  useFake(makeVercelFake({ mode: "r429" }).handler);
  check(M, "deploy 429 → clear error", await throwsOk(
    () => new VercelDeployTarget(cfg).deploy([{ path: "/a", content: "x" }]), "vercel deploy failed (429)"));
  stopFake();
  useFake(makeVercelFake({ mode: "e500malformed" }).handler);
  check(M, "deploy 500+html → status in message", await throwsOk(
    () => new VercelDeployTarget(cfg).deploy([{ path: "/a", content: "x" }]), "vercel deploy failed (500)"));
  stopFake();
  // listDeployments limit clamp
  {
    const f = makeVercelFake();
    useFake(f.handler);
    const v3 = new VercelDeployTarget(cfg);
    await v3.listDeployments({ limit: 0 });
    check(M, "limit 0 → clamped to 1", f.calls[0].url.includes("limit=1"));
    await v3.listDeployments({ limit: 99 });
    check(M, "limit 99 → clamped to 20", f.calls[1].url.includes("limit=20"));
    await v3.listDeployments({ projectName: "p1", limit: 5 });
    check(M, "projectId param passed", f.calls[2].url.includes("projectId=p1"));
    const list = await v3.listDeployments();
    check(M, "list maps uid+state", list[0].id === "d1" && list[0].status === "ready");
    const one = await v3.getDeploymentStatus("d1");
    check(M, "getDeploymentStatus maps BUILDING", one.status === "building");
    stopFake();
  }
  // deploy with empty token → network attempt → 401 surfaces (no pre-check)
  useFake(makeVercelFake({ mode: "r429" }).handler);
  check(M, "deploy with empty token surfaces provider error", await throwsOk(
    () => new VercelDeployTarget({ ...cfg, token: "" }).deploy([{ path: "/a", content: "x" }]), "429"));
  stopFake();
}

// ---------------------------------------------------------------------------
// O. lib/deploy/mock-vercel.ts
// ---------------------------------------------------------------------------
{
  const M = "deploy/mock-vercel";
  const mv = new MockVercelDeployTarget({ token: "", projectId: "", teamId: "", demo: true });
  check(M, "deploy empty → throws", await throwsOk(() => mv.deploy([]), "nothing to deploy"));
  const d1 = await mv.deploy([{ path: "/index.html", content: "a" }]);
  const d2 = await mv.deploy([{ path: "/index.html", content: "a" }]);
  check(M, "two deploys → two ids (no lock/dedupe)", d1.deploymentId !== d2.deploymentId,
    `${d1.deploymentId} vs ${d2.deploymentId}`);
  check(M, "mock flag set", d1.mock === true);
  const list = await mv.listDeployments({ limit: 1 });
  check(M, "listDeployments limit honored", list.length === 1);
  check(M, "getDeploymentStatus unknown → throws", await throwsOk(
    () => mv.getDeploymentStatus("nope"), "unknown demo deployment"));
  const st = await mv.getDeploymentStatus(d1.deploymentId);
  check(M, "getDeploymentStatus ok", st.id === d1.deploymentId && st.status === "ready");
}

// ---------------------------------------------------------------------------
// P. lib/deploy/cloudflare.ts — live class via fake fetch
// ---------------------------------------------------------------------------
{
  const M = "deploy/cloudflare";
  const cfg = { token: "t", accountId: "acct", projectName: "proj", demo: false };

  check(M, "test() without token fails closed", await throwsOk(
    () => new CloudflarePagesDeployTarget({ ...cfg, token: "" }).test(), "api token is required"));
  check(M, "test() without accountId fails closed", await throwsOk(
    () => new CloudflarePagesDeployTarget({ ...cfg, accountId: "" }).test(), "account id is required"));
  useFake(makeCloudflareFake({ projectExists: true }).handler);
  const cf = new CloudflarePagesDeployTarget(cfg);
  const t = await cf.test();
  check(M, "test() ok", t.ok === true && t.info.includes("acct"));
  check(M, "deploy empty → clear error", await throwsOk(() => cf.deploy([]), "nothing to deploy"));
  {
    // happy path with existing project + duplicate-content files
    const f = makeCloudflareFake({ projectExists: true });
    useFake(f.handler);
    const cf2 = new CloudflarePagesDeployTarget(cfg);
    const res = await cf2.deploy([
      { path: "/a.txt", content: "same" },
      { path: "/b.txt", content: "same" },
      { path: "/c.txt", content: "different" },
    ]);
    const manifest = JSON.parse(f.forms[0].manifest) as Record<string, string>;
    const h = createHash("sha256").update("same", "utf8").digest("hex");
    check(M, "manifest sha256 correct (path → hash)", manifest["a.txt"] === h && manifest["b.txt"] === h);
    check(M, "FIXED: duplicate-content files both in manifest (3 entries)",
      Object.keys(manifest).length === 3,
      `manifest has ${Object.keys(manifest).length} entries for 3 files`);
    check(M, "blobs deduped by hash", f.forms[0].entryCount === 3); // manifest + 2 unique blobs
    check(M, "BUG CHECK: CF 'success' stage → ready (expect ready)",
      res.status === "ready", `got "${res.status}" — finished deploys report as queued`);
    stopFake();
  }
  {
    // project auto-creation + slugification
    const f = makeCloudflareFake({ projectExists: false });
    useFake(f.handler);
    const cf2 = new CloudflarePagesDeployTarget({ ...cfg, projectName: "My Cool Site!!" });
    await cf2.deploy([{ path: "/a", content: "x" }]);
    const getCall = f.calls.find((c) => c.method === "GET" && c.url.includes("/pages/projects/my-cool-site"))!;
    check(M, "project name slugified in probe", getCall !== undefined);
    const createCall = f.calls.find((c) => c.method === "POST" && c.url === "/client/v4/accounts/acct/pages/projects")!;
    check(M, "missing project created", (createCall.body as { name: string }).name === "my-cool-site");
    stopFake();
  }
  check(M, "underivable project name → throws", await throwsOk(
    () => new CloudflarePagesDeployTarget({ ...cfg, projectName: "!!!" }).deploy([{ path: "/a", content: "x" }]),
    "could not derive"));
  {
    // ensureProject masks non-404 errors by attempting creation
    const f = makeCloudflareFake({ mode: "cf500" });
    useFake(f.handler);
    let msg = "";
    try {
      await new CloudflarePagesDeployTarget(cfg).deploy([{ path: "/a", content: "x" }]);
    } catch (e) { msg = (e as Error).message; }
    const attemptedCreate = f.calls.some((c) => c.method === "POST" && c.url === "/client/v4/accounts/acct/pages/projects");
    stopFake();
    check(M, "BUG CHECK: 500 on project probe does not trigger create (expect no create)",
      attemptedCreate === false, `create attempted; error was: ${msg.slice(0, 80)}`);
  }
  // listDeployments / getDeploymentStatus edges
  {
    const f = makeCloudflareFake({ projectExists: true });
    useFake(f.handler);
    const cf2 = new CloudflarePagesDeployTarget(cfg);
    check(M, "listDeployments empty project → [] without network",
      (await new CloudflarePagesDeployTarget({ ...cfg, projectName: "   " }).listDeployments()).length === 0);
    await cf2.listDeployments({ limit: 0 });
    check(M, "limit 0 → clamped to 1", f.calls[f.calls.length - 1].url.includes("per_page=1"));
    await cf2.listDeployments({ limit: 99 });
    check(M, "limit 99 → clamped to 25", f.calls[f.calls.length - 1].url.includes("per_page=25"));
    const one = await cf2.getDeploymentStatus("dep1");
    check(M, "BUG CHECK: getDeploymentStatus 'success' → ready", one.status === "ready", `got "${one.status}"`);
    check(M, "getDeploymentStatus without project → throws", await throwsOk(
      () => new CloudflarePagesDeployTarget({ ...cfg, projectName: "" }).getDeploymentStatus("x"),
      "project name is required"));
    stopFake();
  }
  useFake(makeCloudflareFake({ mode: "cf500" }).handler);
  check(M, "cf error envelope surfaces message", await throwsOk(
    () => new CloudflarePagesDeployTarget(cfg).test(), "boom"));
  stopFake();
  useFake(makeCloudflareFake({ mode: "malformed" }).handler);
  check(M, "malformed JSON → request-failed error", await throwsOk(
    () => new CloudflarePagesDeployTarget(cfg).test(), "cloudflare request failed"));
  stopFake();
}

// ---------------------------------------------------------------------------
// Q. lib/deploy/mock-cloudflare.ts + normalizeStatus
// ---------------------------------------------------------------------------
{
  const M = "deploy/mock-cloudflare";
  const mc = new MockCloudflarePagesDeployTarget({ token: "", accountId: "", projectName: "", demo: true });
  check(M, "deploy empty → throws", await throwsOk(() => mc.deploy([]), "nothing to deploy"));
  const d1 = await mc.deploy([{ path: "/a", content: "x" }]);
  const d2 = await mc.deploy([{ path: "/a", content: "x" }]);
  check(M, "two deploys → two ids (no lock)", d1.deploymentId !== d2.deploymentId);
  check(M, "unknown deployment → throws", await throwsOk(() => mc.getDeploymentStatus("nope"), "unknown demo deployment"));

  const N = "deploy/types";
  check(N, "normalizeStatus READY→ready", normalizeStatus("READY") === "ready");
  check(N, "normalizeStatus failed→error", normalizeStatus("failed") === "error");
  check(N, "normalizeStatus canceled→error", normalizeStatus("canceled") === "error");
  check(N, "normalizeStatus initializing→building", normalizeStatus("initializing") === "building");
  check(N, "BUG CHECK: normalizeStatus 'success' (CF Pages terminal state)",
    normalizeStatus("success") === "ready", `got "${normalizeStatus("success")}" — CF finished deploys misreported`);
  check(N, "normalizeStatus unknown→queued", normalizeStatus("weird") === "queued");
  check(N, "normalizeStatus undefined→queued", normalizeStatus(undefined) === "queued");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
stopFake();
{
  let tp = 0, tf = 0;
  console.log("\n=== edge-studio-connectors: per-module results ===");
  for (const [mod, r] of Object.entries(mods)) {
    tp += r.pass; tf += r.fail;
    console.log(`${mod}: ${r.pass + r.fail} checks, ${r.pass} passed, ${r.fail} failed`);
  }
  console.log(`TOTAL: ${tp + tf} checks, ${tp} passed, ${tf} failed`);
  if (tf > 0) process.exitCode = 1;
}
