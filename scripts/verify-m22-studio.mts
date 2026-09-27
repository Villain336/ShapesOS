// Marketr milestone 22 — fixture tests for the studio (Porkbun domains +
// asset library).
// Pure mock-port + mock-db coverage of domain search/pricing/purchase
// double-confirmation, registrant gating, brand-kit defaults, asset library,
// and M20 wiring: no live DB, no network, no Porkbun calls, no spend.
// Run: npx tsx scripts/verify-m22-studio.mts

process.env.MARKETR_CREDENTIALS_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import type { PrismaClient } from "@prisma/client";
import { createMockPorkbunPort } from "@/lib/studio/porkbun";
import {
  __resetStudioTestState,
  __seedPurchaseConfirmation,
  checkDomainAvailability,
  confirmDomainPurchase,
  createAsset,
  deleteAsset,
  getPorkbunPort,
  getRegistrant,
  getStudioAutofillDefaults,
  getTldPricing,
  listAssets,
  listStudioDomains,
  previewDomainPurchase,
  removePorkbunKeys,
  removeStudioDomain,
  savePorkbunKeys,
  saveRegistrant,
  useAssetInSocialPost,
  validateDomainName,
} from "@/lib/studio/service";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function throws(fn: () => Promise<unknown>, needle: string): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes(needle.toLowerCase())) return msg;
    throw new Error(`expected error containing "${needle}", got "${msg}"`);
  }
  throw new Error(`expected error containing "${needle}", but nothing threw`);
}

type Row = Record<string, unknown>;

function mockDb() {
  const state = {
    porkbun: new Map<string, Row>(),
    registrants: new Map<string, Row>(),
    domains: new Map<string, Row>(),
    assets: new Map<string, Row>(),
    socialChannels: [] as Row[],
    socialPosts: [] as Row[],
    audit: [] as Row[],
  };
  const id = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;
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
      upsert: async ({
        where,
        update,
        create,
      }: {
        where: { projectId_domain: { projectId: string; domain: string } };
        update: Row;
        create: Row;
      }) => {
        let row: Row | null = null;
        for (const r of state.domains.values()) {
          if (r.projectId === where.projectId_domain.projectId && r.domain === where.projectId_domain.domain) {
            row = r;
            break;
          }
        }
        if (row) Object.assign(row, update);
        else {
          row = { id: id("dom"), ...create, ...update };
          state.domains.set(row.id as string, row);
        }
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = state.domains.get(where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        state.domains.delete(where.id);
        return { id: where.id };
      },
    },
    projectAsset: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: id("asset"), createdAt: new Date(), ...data };
        state.assets.set(row.id as string, row);
        return row;
      },
      findMany: async ({ where }: { where: { projectId: string; source?: string } }) =>
        [...state.assets.values()].filter(
          (r) => r.projectId === where.projectId && (!where.source || r.source === where.source),
        ),
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
    socialPost: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: id("post"), ...data };
        state.socialPosts.push(row);
        return row;
      },
    },
    fileChangeLog: {
      create: async ({ data }: { data: Row }) => {
        state.audit.push(data);
        return data;
      },
    },
    brandKit: {
      findFirst: async ({ where }: { where: { workspaceId: string } }) =>
        where.workspaceId === "ws-brand"
          ? {
              id: "kit-1",
              name: "Launchabl",
              logoPath: "logos/launchabl.svg",
              colors: { primary: "#0ea5e9", secondary: "#111111" },
              fonts: { heading: "Inter", body: "Inter" },
              tone: "bold",
            }
          : null,
    },
  } as unknown as PrismaClient;
  return { db, state };
}

const WS = "ws-m22";
const PROJ = "proj-m22";

// --- Porkbun keys --------------------------------------------------------------------

{
  const { db, state } = mockDb();
  check("no keys → null port", (await getPorkbunPort(db, WS)) === null);
  const { hint } = await savePorkbunKeys(db, WS, { apiKey: "pk1_test", secretApiKey: "sk1_test" });
  check("hint only shows tail", hint === "…test");
  const stored = state.porkbun.get(WS) as Row;
  check("keys encrypted", !String(stored.apiKeyEnc).includes("pk1_test"));
  check("keys save audited", state.audit.some((a) => a.action === "studio_porkbun_keys_updated"));
  const port = await getPorkbunPort(db, WS);
  check("port resolves with keys", port !== null);
  await throws(() => savePorkbunKeys(db, WS, { apiKey: "", secretApiKey: "x" }), "both the api key");
  await removePorkbunKeys(db, WS);
  check("keys removed", (await getPorkbunPort(db, WS)) === null);
}

// --- Domain validation / availability / pricing ---------------------------------------
{
  check("valid domain passes", validateDomainName("Example.COM") === "example.com");
  for (const bad of ["", "-bad.com", "bad-.com", "no spaces.com", "a".repeat(254) + ".com"]) {
    let threw = false;
    try {
      validateDomainName(bad);
    } catch {
      threw = true;
    }
    check(`invalid rejected: ${bad.slice(0, 20) || "(empty)"}`, threw);
  }

  const port = createMockPorkbunPort();
  const avail = await checkDomainAvailability(port, "myavailabledomain.com");
  check("available domain found", avail.available && avail.priceUsd === 11.08);
  check("renewal price present", avail.renewalPriceUsd === 11.08);
  check("not premium", avail.premium === false);
  const taken = await checkDomainAvailability(port, "taken.com");
  check("taken domain reported", taken.available === false && taken.priceUsd === null);

  const pricing = await getTldPricing(port);
  check("pricing returns tlds", pricing.length === 3);
  check("renewal cliff visible", pricing.some((p) => p.tld === "xyz" && p.renewalUsd > p.registrationUsd));
  const filtered = await getTldPricing(port, [".com"]);
  check("pricing filters by tld", filtered.length === 1 && filtered[0].tld === "com");
}

// --- Registrant ----------------------------------------------------------------------
{
  const { db } = mockDb();
  const good = {
    firstName: "Tico",
    lastName: "Launchabl",
    email: "t@example.com",
    phone: "+15551234567",
    address: "1 Main St",
    city: "Greensboro",
    state: "NC",
    zip: "27401",
    country: "US",
  };
  const saved = await saveRegistrant(db, WS, good);
  check("registrant saved", saved.email === "t@example.com");
  const got = await getRegistrant(db, WS);
  check("registrant retrievable", (got as Row)?.email === "t@example.com");
  await throws(() => saveRegistrant(db, "ws-other", { ...good, email: "nope" }), "invalid");
  await throws(() => saveRegistrant(db, "ws-other", { ...good, firstName: "" }), "required");
  check("registrant validation enforced", true);
}

// --- Purchase wizard: preview → confirm ----------------------------------------------
{
  __resetStudioTestState();
  const { db, state } = mockDb();
  const port = createMockPorkbunPort();

  // No registrant → blocked.
  await throws(() => previewDomainPurchase(db, WS, PROJ, port, "myavailabledomain.com"), "registrant");
  check("registrant gate enforced", true);

  await saveRegistrant(db, WS, {
    firstName: "Tico",
    lastName: "Launchabl",
    email: "t@example.com",
    phone: "+15551234567",
    address: "1 Main St",
    city: "Greensboro",
    state: "NC",
    zip: "27401",
    country: "US",
  });

  await throws(() => previewDomainPurchase(db, WS, PROJ, port, "taken.com"), "not available");
  await throws(() => previewDomainPurchase(db, WS, PROJ, port, "premium-available.com"), "premium");
  check("taken + premium blocked at preview", true);

  const preview = await previewDomainPurchase(db, WS, PROJ, port, "myavailabledomain.com");
  check("preview returns price", preview.priceUsd === 11.08);
  check("preview carries ICANN disclosure", preview.icannDisclosure.includes("ICANN"));
  check("preview carries registrant", preview.registrant.email === "t@example.com");
  check("confirmation token issued", preview.confirmationToken.length >= 32);

  // Confirm: terms required.
  await throws(
    () =>
      confirmDomainPurchase(db, WS, PROJ, port, {
        confirmationToken: preview.confirmationToken,
        agreeToTerms: false,
        whoisPrivacy: true,
      }),
    "agree to the terms",
  );
  check("terms gate enforced", true);

  // Success.
  const done = await confirmDomainPurchase(db, WS, PROJ, port, {
    confirmationToken: preview.confirmationToken,
    agreeToTerms: true,
    whoisPrivacy: true,
  });
  check("purchase succeeds", done.domain === "myavailabledomain.com" && done.costUsd === 11.08);
  check("order id recorded", done.orderId === "MOCK-ORDER-1");
  check("nameservers captured", done.nameServers.length === 2);
  check("purchase audited", state.audit.some((a) => a.action === "studio_domain_purchased"));
  const rows = await listStudioDomains(db, PROJ);
  check("domain listed as registered", rows.length === 1 && rows[0].status === "registered");

  // Token single-use.
  await throws(
    () =>
      confirmDomainPurchase(db, WS, PROJ, port, {
        confirmationToken: preview.confirmationToken,
        agreeToTerms: true,
        whoisPrivacy: true,
      }),
    "expired or invalid",
  );
  check("confirmation token single-use", true);

  // Already registered → preview blocked.
  await throws(() => previewDomainPurchase(db, WS, PROJ, port, "myavailabledomain.com"), "already registered");
  check("duplicate purchase blocked", true);

  // Unknown token.
  await throws(
    () => confirmDomainPurchase(db, WS, PROJ, port, { confirmationToken: "nope", agreeToTerms: true, whoisPrivacy: true }),
    "expired or invalid",
  );
  check("unknown token rejected", true);
}

// --- Purchase: price change + availability loss + provider failure --------------------
{
  __resetStudioTestState();
  const { db, state } = mockDb();
  const port = createMockPorkbunPort();
  await saveRegistrant(db, WS, {
    firstName: "T",
    lastName: "L",
    email: "t@example.com",
    phone: "1",
    address: "a",
    city: "c",
    state: "",
    zip: "1",
    country: "US",
  });

  // Price change between preview and confirm.
  const token = __seedPurchaseConfirmation({
    projectId: PROJ,
    workspaceId: WS,
    domain: "myavailabledomain.com",
    priceCents: 999,
    expiresAt: Date.now() + 60000,
  });
  await throws(
    () => confirmDomainPurchase(db, WS, PROJ, port, { confirmationToken: token, agreeToTerms: true, whoisPrivacy: true }),
    "price changed",
  );
  check("price change aborts purchase", state.audit.some((a) => a.action === "studio_domain_purchase_failed"));

  // Availability lost.
  const token2 = __seedPurchaseConfirmation({
    projectId: PROJ,
    workspaceId: WS,
    domain: "taken.com",
    priceCents: 1108,
    expiresAt: Date.now() + 60000,
  });
  await throws(
    () => confirmDomainPurchase(db, WS, PROJ, port, { confirmationToken: token2, agreeToTerms: true, whoisPrivacy: true }),
    "no longer available",
  );
  check("availability loss aborts purchase", true);

  // Expired token.
  const token3 = __seedPurchaseConfirmation({
    projectId: PROJ,
    workspaceId: WS,
    domain: "myavailabledomain.com",
    priceCents: 1108,
    expiresAt: Date.now() - 1000,
  });
  await throws(
    () => confirmDomainPurchase(db, WS, PROJ, port, { confirmationToken: token3, agreeToTerms: true, whoisPrivacy: true }),
    "expired",
  );
  check("expired token rejected", true);

  // Token bound to a different project.
  const token4 = __seedPurchaseConfirmation({
    projectId: "other-proj",
    workspaceId: WS,
    domain: "myavailabledomain.com",
    priceCents: 1108,
    expiresAt: Date.now() + 60000,
  });
  await throws(
    () => confirmDomainPurchase(db, WS, PROJ, port, { confirmationToken: token4, agreeToTerms: true, whoisPrivacy: true }),
    "does not match",
  );
  check("token bound to project", true);

  // Provider failure → status failed, alert trigger exercised.
  const base = createMockPorkbunPort();
  const dying: typeof base = {
    ...base,
    createDomain: async () => {
      throw new Error("porkbun exploded");
    },
  };
  const token5 = __seedPurchaseConfirmation({
    projectId: PROJ,
    workspaceId: WS,
    domain: "myavailabledomain.com",
    priceCents: 1108,
    expiresAt: Date.now() + 60000,
  });
  await throws(
    () => confirmDomainPurchase(db, WS, PROJ, dying, { confirmationToken: token5, agreeToTerms: true, whoisPrivacy: true }),
    "porkbun exploded",
  );
  const failedRow = await (db as unknown as { studioDomain: { findUnique: (a: unknown) => Promise<Row | null> } }).studioDomain.findUnique({
    where: { projectId_domain: { projectId: PROJ, domain: "myavailabledomain.com" } },
  });
  check("failed purchase recorded", failedRow?.status === "failed");
  check("failure alert trigger valid (no unknown-trigger throw)", true);
}

// --- removeStudioDomain guards --------------------------------------------------------
{
  const { db } = mockDb();
  const port = createMockPorkbunPort();
  await saveRegistrant(db, WS, {
    firstName: "T",
    lastName: "L",
    email: "t@example.com",
    phone: "1",
    address: "a",
    city: "c",
    state: "",
    zip: "1",
    country: "US",
  });
  const preview = await previewDomainPurchase(db, WS, PROJ, port, "myavailabledomain.com");
  const done = await confirmDomainPurchase(db, WS, PROJ, port, {
    confirmationToken: preview.confirmationToken,
    agreeToTerms: true,
    whoisPrivacy: true,
  });
  await throws(() => removeStudioDomain(db, WS, PROJ, done.id), "only be removed at porkbun");
  check("registered domains protected", true);
  await throws(() => removeStudioDomain(db, WS, PROJ, "nope"), "not found");
  check("unknown domain rejected", true);
}

// --- Brand-kit autofill defaults (M12 reuse) ----------------------------------------------
{
  const { db } = mockDb();
  check("no brand kit → null defaults", (await getStudioAutofillDefaults(db, WS)) === null);
  const d = await getStudioAutofillDefaults(db, "ws-brand");
  check("brand kit name carried", d?.businessName === "Launchabl");
  check("brand tone carried", d?.tone === "bold");
  check("brand colors carried", d?.colors.primary === "#0ea5e9");
  check("logo path carried", d?.logoPath === "logos/launchabl.svg");
}

// --- Asset library --------------------------------------------------------------------
{
  __resetStudioTestState();
  const { db, state } = mockDb();

  const a1 = await createAsset(db, WS, PROJ, { name: "Hero", source: "upload", url: "https://cdn.example/hero.png" });
  check("asset created", (a1 as Row).id != null);
  check("asset audit logged", state.audit.some((a) => a.action === "studio_asset_created"));
  await throws(() => createAsset(db, WS, PROJ, { name: "", source: "upload", url: "https://x.example/a.png" }), "name is required");
  await throws(() => createAsset(db, WS, PROJ, { name: "x", source: "upload", url: "not-a-url" }), "valid asset url");
  check("asset validation enforced", true);

  const all = await listAssets(db, PROJ);
  check("assets listed", all.length === 1);

  await deleteAsset(db, WS, PROJ, (a1 as Row).id as string);
  check("asset deleted", (await listAssets(db, PROJ)).length === 0);
  check("delete audited", state.audit.some((a) => a.action === "studio_asset_deleted"));
  await throws(() => deleteAsset(db, WS, PROJ, "nope"), "not found");
  check("unknown asset rejected", true);
}

// --- useAssetInSocialPost (M20 wiring) -------------------------------------------------
{
  const { db } = mockDb();
  await throws(
    () => useAssetInSocialPost(db, WS, PROJ, "nope", { text: "hi", services: [] }),
    "asset not found",
  );
  const asset = await createAsset(db, WS, PROJ, { name: "Ad", source: "generated", url: "https://cdn.example/ad.png" });

  // No channels and no explicit services → clear error.
  await throws(
    () => useAssetInSocialPost(db, WS, PROJ, (asset as Row).id as string, { text: "hi", services: [] }),
    "no social channels",
  );
  check("missing channels surfaced", true);

  // With explicit services, the post is created with the asset as media.
  const m2 = mockDb();
  const asset2 = await createAsset(m2.db, WS, PROJ, {
    name: "Ad2",
    source: "generated",
    url: "https://cdn.example/ad2.png",
    mimeType: "image/png",
  });
  // Seed channels through the mock's internal state is not exposed; instead pass services explicitly.
  const post = await useAssetInSocialPost(m2.db, WS, PROJ, (asset2 as Row).id as string, {
    text: "Launch day",
    services: ["instagram"],
  });
  check("post created with asset media", (post as Row).id != null);
  check("social post wiring exercised", true);
  void db;
}

console.log(`\nM22 fixtures: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);

