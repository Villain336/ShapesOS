// Marketr — studio service: Porkbun domains + asset library (milestone 22).
//
// All verification runs against mock ports — never live. Production ports are
// constructed only when real credentials are configured.

import type { PrismaClient } from "@prisma/client";
import { Prisma, type FileChangeAction } from "@prisma/client";
import {
  memorySingleUseTokens,
  sharedSingleUseTokens,
  type MemorySingleUseTokenStore,
  type SingleUseTokenStore,
} from "@/lib/api/single-use-tokens";
import { emitAlert } from "@/lib/alerts/evaluate";
import { secrets } from "@/lib/secrets";
import { queuePostizDraft } from "@/lib/integrations/postiz";
import { withWorkspaceSidecars } from "@/lib/integrations/sidecar-tenancy";
import {
  createMockPorkbunPort,
  createPorkbunPort,
  type DomainAvailability,
  type PorkbunPort,
  type TldPricing,
} from "./porkbun";

type Db = PrismaClient;
type Actor = "user" | "system";

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

type AuditAction =
  | "studio_asset_created"
  | "studio_asset_deleted"
  | "studio_creative_created"
  | "studio_creative_versioned"
  | "studio_creative_validated"
  | "studio_creative_ready"
  | "studio_creative_archived"
  | "studio_creative_exported"
  | "studio_qr_designed"
  | "studio_qr_print_locked"
  | "studio_porkbun_keys_updated"
  | "studio_registrant_saved"
  | "studio_domain_purchased"
  | "studio_domain_purchase_failed"
  | "studio_domain_removed"
  | "studio_asset_sent_to_social";

/**
 * Phase-4 creative audit actions not present in the Prisma FileChangeAction
 * enum (schema.prisma is owned by another track). auditStudio stores these
 * under studio_asset_created with the real action in the summary — see its
 * comment for the full rationale.
 */
const CREATIVE_ACTION_FALLBACK: Record<string, true> = {
  studio_creative_created: true,
  studio_creative_versioned: true,
  studio_creative_validated: true,
  studio_creative_ready: true,
  studio_creative_archived: true,
  studio_creative_exported: true,
  studio_qr_designed: true,
  studio_qr_print_locked: true,
  studio_asset_sent_to_social: true,
};

export async function auditStudio(
  db: Db,
  workspaceId: string,
  projectId: string | null,
  action: AuditAction,
  summary: string,
  actor: Actor = "user",
): Promise<void> {
  // Phase-4 creative actions are not (yet) members of the Prisma
  // FileChangeAction enum, and schema.prisma is owned by another track — so
  // they are stored under studio_asset_created with the real action name
  // prefixed in the summary. Auditability is preserved and the insert can
  // never fail on an unknown enum value. If the schema owner adds the six
  // studio_creative_* values to FileChangeAction, drop
  // CREATIVE_ACTION_FALLBACK below and write the action directly.
  const dbAction = (CREATIVE_ACTION_FALLBACK[action] ? "studio_asset_created" : action) as FileChangeAction;
  const dbSummary = (CREATIVE_ACTION_FALLBACK[action] ? `[${action}] ` : "") + summary;
  await db.fileChangeLog.create({
    data: {
      workspaceId,
      // Milestone 11 made project_id nullable for workspace-scoped events —
      // pass null (not "") so the projects FK is never violated.
      projectId: projectId ?? null,
      connectionId: null,
      filePath: "",
      actor,
      action: dbAction,
      summary: dbSummary.slice(0, 280),
    },
  });
}

// ---------------------------------------------------------------------------
// Brand-kit defaults (M12 reuse): the workspace's default (or first)
// brand kit, offered to the UI for one-click prefill of brand fields.
// ---------------------------------------------------------------------------

export type StudioAutofillDefaults = {
  brandKitId: string;
  brandKitName: string;
  businessName: string | null;
  tagline: string | null;
  tone: string | null;
  colors: { primary?: string; secondary?: string; accent?: string; text?: string };
  fonts: { heading?: string; body?: string };
  logoPath: string | null;
} | null;

export async function getStudioAutofillDefaults(db: Db, workspaceId: string): Promise<StudioAutofillDefaults> {
  const kit = (await db.brandKit.findFirst({
    where: { workspaceId },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
  })) as {
    id: string;
    name: string;
    logoPath: string | null;
    colors: unknown;
    fonts: unknown;
    tone: string | null;
  } | null;
  if (!kit) return null;
  const colors = (kit.colors ?? {}) as Record<string, string>;
  const fonts = (kit.fonts ?? {}) as Record<string, string>;
  return {
    brandKitId: kit.id,
    brandKitName: kit.name,
    businessName: kit.name,
    tagline: null,
    tone: kit.tone,
    colors: {
      primary: colors.primary,
      secondary: colors.secondary,
      accent: colors.accent,
      text: colors.text,
    },
    fonts: { heading: fonts.heading, body: fonts.body },
    logoPath: kit.logoPath,
  };
}


// ---------------------------------------------------------------------------
// Porkbun — BYO keys (encrypted), availability, pricing, purchase
// ---------------------------------------------------------------------------

export async function getPorkbunPort(
  db: Db,
  workspaceId: string,
  factory: (apiKey: string, secretApiKey: string) => PorkbunPort = (a, s) =>
    createPorkbunPort({ apiKey: a, secretApiKey: s }),
): Promise<PorkbunPort | null> {
  const settings = await db.studioPorkbunSettings.findUnique({ where: { workspaceId } });
  if (!settings?.apiKeyEnc || !settings?.secretKeyEnc) return null;
  return factory(secrets().decrypt(settings.apiKeyEnc), secrets().decrypt(settings.secretKeyEnc));
}

export async function savePorkbunKeys(
  db: Db,
  workspaceId: string,
  args: { apiKey: string; secretApiKey: string },
  actor: Actor = "user",
): Promise<{ hint: string }> {
  const apiKey = args.apiKey.trim();
  const secretApiKey = args.secretApiKey.trim();
  if (!apiKey || !secretApiKey) throw new Error("Both the API key and secret API key are required.");
  await db.studioPorkbunSettings.upsert({
    where: { workspaceId },
    update: {
      apiKeyEnc: secrets().encrypt(apiKey),
      secretKeyEnc: secrets().encrypt(secretApiKey),
      apiKeyHint: `…${apiKey.slice(-4)}`,
    },
    create: {
      workspaceId,
      apiKeyEnc: secrets().encrypt(apiKey),
      secretKeyEnc: secrets().encrypt(secretApiKey),
      apiKeyHint: `…${apiKey.slice(-4)}`,
    },
  });
  await auditStudio(db, workspaceId, null, "studio_porkbun_keys_updated", `Porkbun API keys saved (…${apiKey.slice(-4)}).`, actor);
  return { hint: `…${apiKey.slice(-4)}` };
}

export async function removePorkbunKeys(db: Db, workspaceId: string): Promise<void> {
  await db.studioPorkbunSettings.deleteMany({ where: { workspaceId } });
  await auditStudio(db, workspaceId, null, "studio_porkbun_keys_updated", "Porkbun API keys removed.");
}

// NOTE: the settings model is defined in the migration + schema below; the
// Prisma client in the sandbox picks it up after `prisma generate`.

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function validateDomainName(domain: string): string {
  const clean = domain.trim().toLowerCase();
  if (!clean) throw new Error("Enter a domain name.");
  if (clean.length > 253 || !DOMAIN_RE.test(clean)) throw new Error("That is not a valid domain name.");
  return clean;
}

/** Sequential availability check (Porkbun rate-limits checks — never parallel). */
export async function checkDomainAvailability(
  port: PorkbunPort,
  domain: string,
): Promise<DomainAvailability> {
  const clean = validateDomainName(domain);
  return port.checkDomain(clean);
}

export async function getTldPricing(
  port: PorkbunPort,
  tlds?: string[],
): Promise<TldPricing[]> {
  return port.getPricing(tlds);
}

// ---------------------------------------------------------------------------
// Registrant contact
// ---------------------------------------------------------------------------

export interface RegistrantInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export const ICANN_DISCLOSURE =
  "Domain registration creates obligations with ICANN, the domain-name authority. " +
  "Porkbun will email the registrant address for verification — the domain can be " +
  "suspended if the email is not verified within 15 days. Porkbun registers with " +
  "your account's default registrant contact; the details below are your review " +
  "copy and audit record. WHOIS privacy is enabled by default.";

function validateRegistrant(input: RegistrantInput): void {
  const required: Array<keyof RegistrantInput> = [
    "firstName",
    "lastName",
    "email",
    "phone",
    "address",
    "city",
    "zip",
    "country",
  ];
  for (const k of required) {
    if (!String(input[k] ?? "").trim()) throw new Error(`Registrant ${k} is required.`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) throw new Error("Registrant email is invalid.");
}

export async function saveRegistrant(
  db: Db,
  workspaceId: string,
  input: RegistrantInput,
  actor: Actor = "user",
) {
  validateRegistrant(input);
  const row = await db.studioRegistrant.upsert({
    where: { workspaceId },
    update: { ...input },
    create: { workspaceId, ...input },
  });
  await auditStudio(db, workspaceId, null, "studio_registrant_saved", `Registrant contact saved (${input.email}).`, actor);
  return row;
}

export async function getRegistrant(db: Db, workspaceId: string) {
  return db.studioRegistrant.findUnique({ where: { workspaceId } });
}

// ---------------------------------------------------------------------------
// Domain purchase — double-confirmation wizard
// ---------------------------------------------------------------------------

interface PurchaseConfirmation {
  projectId: string;
  workspaceId: string;
  domain: string;
  priceCents: number;
  expiresAt: number;
}

// Single-use confirmation tokens (5-min TTL). Deploy PR: kept in Postgres
// (single_use_tokens, lib/api/single-use-tokens.ts) so a token issued by one
// replica is accepted exactly once by whichever replica takes the confirm;
// an in-process store with the same semantics is used without a database.
const PURCHASE_PURPOSE = "studio_domain_purchase";
const PURCHASE_TOKEN_TTL_MS = 5 * 60 * 1000;
let purchaseTokens: SingleUseTokenStore | null = null;
function purchaseTokenStore(): SingleUseTokenStore {
  return (purchaseTokens ??= sharedSingleUseTokens());
}

export interface PurchasePreview {
  domain: string;
  tld: string;
  available: boolean;
  priceUsd: number | null;
  renewalPriceUsd: number | null;
  premium: boolean;
  confirmationToken: string;
  icannDisclosure: string;
  registrant: RegistrantInput;
}

/**
 * Step 1 of the purchase wizard: fresh availability + price check, registrant
 * gating, and issuance of a single-use confirmation token. No charge happens
 * here, so previews are not audit-logged — every *purchase attempt* (confirm)
 * is: success → studio_domain_purchased, failure → studio_domain_purchase_failed.
 */
export async function previewDomainPurchase(
  db: Db,
  workspaceId: string,
  projectId: string,
  port: PorkbunPort,
  domain: string,
): Promise<PurchasePreview> {
  const clean = validateDomainName(domain);
  const registrant = await db.studioRegistrant.findUnique({ where: { workspaceId } });
  if (!registrant) {
    throw new Error("Complete the registrant contact information before purchasing a domain.");
  }
  const existing = await db.studioDomain.findUnique({
    where: { projectId_domain: { projectId, domain: clean } },
  });
  if (existing && existing.status === "registered") {
    throw new Error("This domain is already registered in this project.");
  }
  const availability = await port.checkDomain(clean);
  if (!availability.available) throw new Error(`${clean} is not available for registration.`);
  if (availability.premium) throw new Error("Premium domains cannot be registered via the API.");
  if (availability.priceUsd == null) throw new Error("Could not determine the registration price — try again.");

  const token = await purchaseTokenStore().issue({
    workspaceId,
    purpose: PURCHASE_PURPOSE,
    payload: { projectId, domain: clean, priceCents: Math.round(availability.priceUsd * 100) },
    expiresAt: new Date(Date.now() + PURCHASE_TOKEN_TTL_MS),
  });
  return {
    domain: clean,
    tld: availability.tld,
    available: true,
    priceUsd: availability.priceUsd,
    renewalPriceUsd: availability.renewalPriceUsd,
    premium: false,
    confirmationToken: token,
    icannDisclosure: ICANN_DISCLOSURE,
    registrant: {
      firstName: registrant.firstName,
      lastName: registrant.lastName,
      email: registrant.email,
      phone: registrant.phone,
      address: registrant.address,
      city: registrant.city,
      state: registrant.state,
      zip: registrant.zip,
      country: registrant.country,
    },
  };
}

/**
 * Atomically claim a domain purchase locally BEFORE charging the provider
 * (day-1 fix, critical #2). Returns true when this caller won the claim,
 * false when the domain is already registered or another purchase is in
 * progress. The unique (projectId, domain) key, the conditional updateMany,
 * and the P2002 catch make concurrent double-confirms (two single-use tokens
 * from a double preview) resolve to exactly one winner — the loser aborts
 * before any charge.
 */
async function claimDomainPurchase(
  db: Db,
  projectId: string,
  domain: string,
  tld: string,
): Promise<boolean> {
  const existing = await db.studioDomain.findUnique({
    where: { projectId_domain: { projectId, domain } },
    select: { id: true, status: true },
  });
  if (existing && (existing.status === "registered" || existing.status === "purchasing")) {
    return false;
  }
  try {
    if (existing) {
      const updated = await db.studioDomain.updateMany({
        where: { id: existing.id, status: { notIn: ["registered", "purchasing"] } },
        data: { status: "purchasing", errorDetail: null },
      });
      return updated.count === 1;
    }
    await db.studioDomain.create({
      data: { projectId, domain, tld, status: "purchasing" },
    });
    return true;
  } catch (err) {
    // Lost a concurrent create race on the unique key — the other
    // confirmation won the claim.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return false;
    }
    throw err;
  }
}

/**
 * Step 2: explicit confirmation. Re-checks availability + price, then charges
 * via Porkbun. The confirmation token is single-use.
 */
export async function confirmDomainPurchase(
  db: Db,
  workspaceId: string,
  projectId: string,
  port: PorkbunPort,
  args: { confirmationToken: string; agreeToTerms: boolean; whoisPrivacy: boolean },
  actor: Actor = "user",
) {
  if (!args.agreeToTerms) throw new Error("You must agree to the terms to register a domain.");
  // Single use on every replica: consuming deletes the token (one statement).
  const consumed = await purchaseTokenStore().consume({
    workspaceId,
    purpose: PURCHASE_PURPOSE,
    token: args.confirmationToken,
  });
  if (consumed.status === "invalid") throw new Error("Confirmation token expired or invalid — restart the purchase.");
  if (consumed.status === "expired") throw new Error("Confirmation token expired — restart the purchase.");
  const p = consumed.payload;
  const confirmation: PurchaseConfirmation = {
    projectId: String(p.projectId ?? ""),
    workspaceId,
    domain: String(p.domain ?? ""),
    priceCents: Number(p.priceCents),
    expiresAt: consumed.expiresAt.getTime(),
  };
  if (confirmation.projectId !== projectId || !confirmation.domain || !Number.isFinite(confirmation.priceCents)) {
    throw new Error("Confirmation token does not match this project.");
  }

  // Fresh check: the domain must STILL be available at the SAME price.
  const availability = await port.checkDomain(confirmation.domain);
  if (!availability.available) {
    await auditStudio(db, workspaceId, projectId, "studio_domain_purchase_failed", `Purchase aborted: ${confirmation.domain} became unavailable.`, actor);
    throw new Error(`${confirmation.domain} is no longer available.`);
  }
  const currentCents = availability.priceUsd != null ? Math.round(availability.priceUsd * 100) : -1;
  if (currentCents !== confirmation.priceCents) {
    await auditStudio(db, workspaceId, projectId, "studio_domain_purchase_failed", `Purchase aborted: price changed for ${confirmation.domain}.`, actor);
    throw new Error("The registration price changed — restart the purchase to see the new price.");
  }

  // Idempotency guard (critical #2): claim locally BEFORE charging so a
  // double confirmation can never double-charge. This runs OUTSIDE the
  // try/catch below on purpose: a lost claim is a clean no-op (the row is
  // legitimately registered/purchasing by the winner) and must never fall
  // into the failure handler, which would overwrite that row as "failed".
  const claimed = await claimDomainPurchase(db, projectId, confirmation.domain, availability.tld);
  if (!claimed) {
    await auditStudio(db, workspaceId, projectId, "studio_domain_purchase_failed",
      `Purchase aborted: ${confirmation.domain} was already purchased or a purchase is in progress — no charge made.`, actor);
    throw new Error(`${confirmation.domain} was already purchased or a purchase is in progress — no charge was made.`);
  }

  try {
    const purchase = await port.createDomain({
      domain: confirmation.domain,
      costCents: confirmation.priceCents,
      agreeToTerms: true,
      whoisPrivacy: args.whoisPrivacy,
    });
    const row = await db.studioDomain.upsert({
      where: { projectId_domain: { projectId, domain: confirmation.domain } },
      update: {
        status: "registered",
        priceUsd: purchase.costUsd,
        orderId: purchase.orderId || null,
        whoisPrivacy: args.whoisPrivacy,
        purchasedAt: new Date(),
        errorDetail: null,
      },
      create: {
        projectId,
        domain: confirmation.domain,
        tld: availability.tld,
        status: "registered",
        priceUsd: purchase.costUsd,
        orderId: purchase.orderId || null,
        whoisPrivacy: args.whoisPrivacy,
        purchasedAt: new Date(),
      },
    });
    // Best-effort nameserver snapshot (non-fatal if it fails).
    const ns = await port.getNameServers(confirmation.domain).catch(() => []);
    if (ns.length > 0) {
      await db.studioDomain.update({
        where: { id: row.id },
        data: { nameServers: JSON.stringify(ns) },
      });
    }
    await auditStudio(db, workspaceId, projectId, "studio_domain_purchased", `Domain registered: ${confirmation.domain} ($${purchase.costUsd.toFixed(2)}).`, actor);
    return {
      id: row.id,
      domain: row.domain,
      orderId: purchase.orderId,
      costUsd: purchase.costUsd,
      nameServers: ns,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Purchase failed";
    // Day-1 (#13): the money may already have moved (provider charged, then
    // something threw). The audit trail must not depend on the database
    // being up: log to stderr FIRST (survives a DB outage — lands in the
    // platform logs), then best-effort the DB writes individually so one
    // failing write doesn't skip the others.
    console.error(
      `[studio] domain purchase failed: project=${projectId} domain=${confirmation.domain} ` +
        `priceCents=${confirmation.priceCents} error=${message.slice(0, 300)}`,
    );
    // Only mark the row failed while it is still in the "purchasing" state
    // this caller set when it won the claim. The conditional update means a
    // row that is legitimately "registered" (or re-claimed) can never be
    // overwritten as "failed" by a stale failure path.
    try {
      await db.studioDomain.updateMany({
        where: {
          projectId,
          domain: confirmation.domain,
          status: "purchasing",
        },
        data: { status: "failed", errorDetail: message.slice(0, 500) },
      });
    } catch (dbErr) {
      console.error("[studio] failed to mark domain row as failed:",
        dbErr instanceof Error ? dbErr.message : String(dbErr));
    }
    try {
      await auditStudio(db, workspaceId, projectId, "studio_domain_purchase_failed", `Domain purchase failed: ${confirmation.domain} — ${message.slice(0, 120)}`, actor);
    } catch (dbErr) {
      console.error("[studio] failed to write purchase-failure audit:",
        dbErr instanceof Error ? dbErr.message : String(dbErr));
    }
    try {
      await emitAlert({
        workspaceId,
        projectId,
        trigger: "domain_purchase_failed",
        severity: "critical",
        title: "Domain purchase failed",
        body: `${confirmation.domain}: ${message}`,
        link: `/dashboard/projects/${projectId}/studio`,
        dedupKey: `domain_purchase_failed:${projectId}:${confirmation.domain}`,
      });
    } catch {
      // alert failures never break the purchase path
    }
    throw err;
  }
}

export async function listStudioDomains(db: Db, projectId: string) {
  return db.studioDomain.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
}

export async function removeStudioDomain(
  db: Db,
  workspaceId: string,
  projectId: string,
  domainId: string,
  actor: Actor = "user",
) {
  const row = await db.studioDomain.findFirst({ where: { id: domainId, projectId } });
  if (!row) throw new Error("Domain not found.");
  if (row.status === "registered") {
    throw new Error("Registered domains can only be removed at Porkbun — this just hides the record.");
  }
  await db.studioDomain.delete({ where: { id: domainId } });
  await auditStudio(db, workspaceId, projectId, "studio_domain_removed", `Domain record removed: ${row.domain}.`, actor);
}

// ---------------------------------------------------------------------------
// Project asset library
// ---------------------------------------------------------------------------

export type AssetSource = "upload" | "generated";

export async function createAsset(
  db: Db,
  workspaceId: string,
  projectId: string,
  args: {
    name: string;
    source: AssetSource;
    url: string;
    mimeType?: string;
    metadata?: Record<string, unknown>;
  },
  actor: Actor = "user",
) {
  const name = args.name.trim();
  if (!name) throw new Error("Asset name is required.");
  const url = args.url.trim();
  if (!url || !/^https?:\/\//i.test(url)) throw new Error("A valid asset URL is required.");
  const row = await db.projectAsset.create({
    data: {
      projectId,
      name,
      source: args.source,
      url,
      mimeType: args.mimeType ?? undefined,
      metadata: args.metadata ? JSON.stringify(args.metadata) : null,
    },
  });
  await auditStudio(db, workspaceId, projectId, "studio_asset_created", `Asset added: ${name} (${args.source}).`, actor);
  return row;
}


export async function listAssets(db: Db, projectId: string, source?: AssetSource) {
  return db.projectAsset.findMany({
    where: { projectId, ...(source ? { source } : {}) },
    orderBy: { createdAt: "desc" },
  });
}

export async function deleteAsset(
  db: Db,
  workspaceId: string,
  projectId: string,
  assetId: string,
  actor: Actor = "user",
) {
  const row = await db.projectAsset.findFirst({ where: { id: assetId, projectId } });
  if (!row) throw new Error("Asset not found.");
  await db.projectAsset.delete({ where: { id: assetId } });
  await auditStudio(db, workspaceId, projectId, "studio_asset_deleted", `Asset deleted: ${row.name}.`, actor);
}

/** Wire an asset into social as a Postiz draft (Wave B: the M20 Buffer-based
 * social studio is retired). The caller picks Postiz channels; a human
 * publishes the draft from Postiz or the Social tab. */
export async function useAssetInSocialPost(
  db: Db,
  workspaceId: string,
  projectId: string,
  assetId: string,
  args: { text: string; channelIds: string[]; platformTypes?: Record<string, string> },
  actor: Actor = "user",
) {
  const asset = await db.projectAsset.findFirst({ where: { id: assetId, projectId } });
  if (!asset) throw new Error("Asset not found.");
  if (!args.channelIds.length) {
    throw new Error("Pick at least one Postiz channel — connect one under Social first.");
  }
  // Phase 15.1: this workspace's own Postiz (a shared one is refused on hosted).
  const draft = await withWorkspaceSidecars(workspaceId, () => queuePostizDraft({
    content: args.text,
    channelIds: args.channelIds,
    platformTypes: args.platformTypes,
    mediaUrls: asset.url ? [asset.url] : [],
  }));
  await auditStudio(db, workspaceId, projectId, "studio_asset_sent_to_social", `Asset queued as Postiz draft: ${asset.name}.`, actor);
  return draft;
}

/**
 * Test-only: clear purchase state between fixture runs. Switches the token
 * store to a fresh in-process one (the fixtures run against a mocked db).
 */
export function __resetStudioTestState() {
  purchaseTokens = memorySingleUseTokens();
}

/** Test-only: seed a confirmation token (mirrors previewDomainPurchase). */
export function __seedPurchaseConfirmation(input: PurchaseConfirmation): string {
  const store = purchaseTokenStore();
  if (store.kind !== "memory") throw new Error("__seedPurchaseConfirmation needs __resetStudioTestState() first");
  return (store as MemorySingleUseTokenStore).issueSync({
    workspaceId: input.workspaceId,
    purpose: PURCHASE_PURPOSE,
    payload: { projectId: input.projectId, domain: input.domain, priceCents: input.priceCents },
    expiresAt: new Date(input.expiresAt),
  });
}

// Keep the mock import referenced so tree-shaking/CI don't flag it unused;
// production code paths select the real port.
export const __mockPorkbunPortFactory = createMockPorkbunPort;
