// Marketr — studio service: Canva Connect + Porkbun domains + asset library (milestone 22).
//
// All verification runs against mock ports — never live. Production ports are
// constructed only when real credentials are configured.

import type { PrismaClient } from "@prisma/client";
import { Prisma, type FileChangeAction } from "@prisma/client";
import { randomBytes } from "crypto";
import { emitAlert } from "@/lib/alerts/evaluate";
import { secrets } from "@/lib/secrets";
import { createPost as createSocialPost } from "@/lib/social/service";
import {
  CANVA_SCOPES,
  createCanvaPort,
  type CanvaBrandTemplate,
  type CanvaDesign,
  type CanvaExport,
  type CanvaExportFormat,
  type CanvaFolder,
  type CanvaPort,
} from "./canva";
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
  | "studio_canva_connected"
  | "studio_canva_disconnected"
  | "studio_canva_failed"
  | "studio_canva_refreshed"
  | "studio_canva_exported"
  | "studio_canva_autofilled"
  | "studio_asset_created"
  | "studio_asset_deleted"
  | "studio_creative_created"
  | "studio_creative_versioned"
  | "studio_creative_validated"
  | "studio_creative_ready"
  | "studio_creative_archived"
  | "studio_creative_exported"
  | "studio_porkbun_keys_updated"
  | "studio_registrant_saved"
  | "studio_domain_purchased"
  | "studio_domain_purchase_failed"
  | "studio_domain_removed";

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
// Canva OAuth state machine
// ---------------------------------------------------------------------------

interface PendingOAuth {
  workspaceId: string;
  userId: string;
  expiresAt: number;
}

// In-memory pending OAuth states (10-min TTL). Single-process only —
// multi-instance deployments need a shared store (noted in DEPLOY.md).
const pendingOAuth = new Map<string, PendingOAuth>();

export function createCanvaAuthorizeUrl(
  port: CanvaPort,
  workspaceId: string,
  userId: string,
  opts: { clientId: string; redirectUri: string },
): { url: string; state: string } {
  if (!opts.clientId) throw new Error("CANVA_CLIENT_ID is not configured.");
  const state = randomBytes(24).toString("hex");
  pendingOAuth.set(state, {
    workspaceId,
    userId,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  const url = port.authorizeUrl({
    clientId: opts.clientId,
    redirectUri: opts.redirectUri,
    scopes: CANVA_SCOPES,
    state,
  });
  return { url, state };
}

function consumeOAuthState(state: string): PendingOAuth {
  const pending = pendingOAuth.get(state);
  pendingOAuth.delete(state);
  if (!pending) throw new Error("OAuth state expired or invalid — restart the connect flow.");
  if (pending.expiresAt < Date.now()) throw new Error("OAuth state expired — restart the connect flow.");
  return pending;
}

export async function handleCanvaCallback(
  db: Db,
  port: CanvaPort,
  params: {
    state: string;
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    // The currently signed-in user: must match the user who started the flow.
    expectedUserId: string;
  },
): Promise<{ workspaceId: string; userId: string }> {
  const pending = consumeOAuthState(params.state);
  // Bind the callback to the user who started the OAuth flow — a signed-in
  // user who did not start it cannot attach a Canva account to the workspace.
  if (pending.userId !== params.expectedUserId) {
    throw new Error("This Canva connection was started by a different user — restart the connect flow.");
  }
  let tokens;
  try {
    tokens = await port.exchangeCode({
      clientId: params.clientId,
      clientSecret: params.clientSecret,
      redirectUri: params.redirectUri,
      code: params.code,
    });
  } catch (err) {
    await auditStudio(db, pending.workspaceId, null, "studio_canva_connected", "Canva connect failed at token exchange.", "system");
    throw err;
  }
  const profile = await port.getProfile(tokens.accessToken).catch(() => null);
  await db.studioCanvaAccount.upsert({
    where: { workspaceId: pending.workspaceId },
    update: {
      canvaUserId: profile?.id ?? null,
      accessTokenEnc: secrets().encrypt(tokens.accessToken),
      refreshTokenEnc: secrets().encrypt(tokens.refreshToken),
      tokenExpiresAt: new Date(Date.now() + Math.max(0, tokens.expiresInSeconds - 60) * 1000),
      scopes: tokens.scopes.join(" "),
    },
    create: {
      workspaceId: pending.workspaceId,
      canvaUserId: profile?.id ?? null,
      accessTokenEnc: secrets().encrypt(tokens.accessToken),
      refreshTokenEnc: secrets().encrypt(tokens.refreshToken),
      tokenExpiresAt: new Date(Date.now() + Math.max(0, tokens.expiresInSeconds - 60) * 1000),
      scopes: tokens.scopes.join(" "),
    },
  });
  await auditStudio(db, pending.workspaceId, null, "studio_canva_connected", "Canva account connected.", "user");
  return { workspaceId: pending.workspaceId, userId: pending.userId };
}

export async function getCanvaStatus(db: Db, workspaceId: string) {
  const acct = await db.studioCanvaAccount.findUnique({ where: { workspaceId } });
  if (!acct) return { connected: false as const };
  return {
    connected: true as const,
    canvaUserId: acct.canvaUserId,
    scopes: acct.scopes.split(" ").filter(Boolean),
    connectedAt: acct.connectedAt.toISOString(),
    expiresAt: acct.tokenExpiresAt.toISOString(),
  };
}

/**
 * Resolve a valid access token, refreshing 5 minutes before expiry.
 * Returns null when no account is connected.
 */
export async function getValidCanvaToken(
  db: Db,
  workspaceId: string,
  port: CanvaPort,
  client: { clientId: string; clientSecret: string },
): Promise<string | null> {
  const acct = await db.studioCanvaAccount.findUnique({ where: { workspaceId } });
  if (!acct) return null;
  const margin = 5 * 60 * 1000;
  if (acct.tokenExpiresAt.getTime() - Date.now() > margin) {
    return secrets().decrypt(acct.accessTokenEnc);
  }
  try {
    const tokens = await port.refreshToken({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      refreshToken: secrets().decrypt(acct.refreshTokenEnc),
    });
    await db.studioCanvaAccount.update({
      where: { workspaceId },
      data: {
        accessTokenEnc: secrets().encrypt(tokens.accessToken),
        refreshTokenEnc: secrets().encrypt(tokens.refreshToken),
        tokenExpiresAt: new Date(Date.now() + Math.max(0, tokens.expiresInSeconds - 60) * 1000),
        scopes: tokens.scopes.length > 0 ? tokens.scopes.join(" ") : acct.scopes,
      },
    });
    await auditStudio(db, workspaceId, null, "studio_canva_refreshed", "Canva token refreshed.", "system");
    return tokens.accessToken;
  } catch (err) {
    // Refresh failed — the connection is stale; user must reconnect.
    await auditStudio(db, workspaceId, null, "studio_canva_failed", "Canva token refresh failed; reconnect required.", "system");
    try {
      await emitAlert({
        workspaceId,
        projectId: null,
        trigger: "studio_canva_failed",
        severity: "warn",
        title: "Canva token refresh failed",
        body: err instanceof Error ? err.message : "Refresh failed",
        dedupKey: `studio_canva_failed:refresh:${workspaceId}`,
      });
    } catch {
      // alert failures never break the flow
    }
    throw new Error("Canva token refresh failed — reconnect the account in studio settings.");
  }
}

export async function disconnectCanva(
  db: Db,
  workspaceId: string,
  port?: CanvaPort,
): Promise<void> {
  // Best-effort token revocation before local deletion. Canva does not
  // document a public OAuth revocation endpoint, so this may be a no-op on
  // some accounts — the local delete is the source of truth either way.
  if (port) {
    try {
      const acct = await db.studioCanvaAccount.findUnique({ where: { workspaceId } });
      if (acct) {
        await port.revokeToken({
          clientId: process.env.CANVA_CLIENT_ID ?? "",
          accessToken: secrets().decrypt(acct.accessTokenEnc),
        });
      }
    } catch {
      // Revocation is best-effort; a failed revoke must not block disconnect.
    }
  }
  await db.studioCanvaAccount.deleteMany({ where: { workspaceId } });
  await auditStudio(db, workspaceId, null, "studio_canva_disconnected", "Canva account disconnected.", "user");
}

// ---------------------------------------------------------------------------
// Canva designs / exports / autofill (server-side; require a valid token)
// ---------------------------------------------------------------------------

export async function listStudioDesigns(
  db: Db,
  workspaceId: string,
  port: CanvaPort,
  client: { clientId: string; clientSecret: string },
  opts?: { query?: string; folderId?: string },
): Promise<CanvaDesign[]> {
  const token = await getValidCanvaToken(db, workspaceId, port, client);
  if (!token) throw new Error("No Canva account connected — connect Canva in the studio first.");
  try {
    const { designs } = await port.listDesigns(token, { query: opts?.query, folderId: opts?.folderId, limit: 50 });
    return designs;
  } catch (err) {
    await fireCanvaAlert(db, workspaceId, "list designs", err);
    throw err;
  }
}

export async function listStudioFolders(
  db: Db,
  workspaceId: string,
  port: CanvaPort,
  client: { clientId: string; clientSecret: string },
): Promise<CanvaFolder[]> {
  const token = await getValidCanvaToken(db, workspaceId, port, client);
  if (!token) throw new Error("No Canva account connected — connect Canva in the studio first.");
  try {
    return await port.listFolders(token);
  } catch (err) {
    await fireCanvaAlert(db, workspaceId, "list folders", err);
    throw err;
  }
}

/** Import a design's thumbnail + metadata directly into the asset library
 *  (no export needed). The thumbnail is a Canva-hosted preview, not a
 *  production asset — noted in the row metadata. */
export async function importCanvaDesignAsAsset(
  db: Db,
  workspaceId: string,
  projectId: string,
  port: CanvaPort,
  client: { clientId: string; clientSecret: string },
  designId: string,
) {
  const token = await getValidCanvaToken(db, workspaceId, port, client);
  if (!token) throw new Error("No Canva account connected — connect Canva in the studio first.");
  const design = await port.getDesign(token, designId).catch((err) => {
    throw new Error(`Could not load Canva design: ${err instanceof Error ? err.message : "unknown"}`);
  });
  if (!design.thumbnailUrl) throw new Error("This design has no thumbnail to import.");
  return createAsset(db, workspaceId, projectId, {
    name: design.title || "Canva design",
    source: "canva",
    url: design.thumbnailUrl,
    mimeType: "image/png",
    canvaDesignId: design.id,
    metadata: {
      designId: design.id,
      designType: design.designType,
      kind: "thumbnail",
      note: "Canva-hosted preview thumbnail, not a full-resolution export.",
      editUrl: design.editUrl,
    },
  });
}

export async function listStudioBrandTemplates(
  db: Db,
  workspaceId: string,
  port: CanvaPort,
  client: { clientId: string; clientSecret: string },
): Promise<{ templates: CanvaBrandTemplate[]; planLimited: boolean }> {
  const token = await getValidCanvaToken(db, workspaceId, port, client);
  if (!token) throw new Error("No Canva account connected — connect Canva in the studio first.");
  try {
    const templates = await port.listBrandTemplates(token);
    // Empty list can mean "no templates" OR "plan lacks brandtemplate scopes" —
    // surface it honestly so the UI can show the plan-limitation notice.
    return { templates, planLimited: templates.length === 0 };
  } catch (err) {
    await fireCanvaAlert(db, workspaceId, "list brand templates", err);
    throw err;
  }
}

export async function autofillStudioTemplate(
  db: Db,
  workspaceId: string,
  projectId: string,
  port: CanvaPort,
  client: { clientId: string; clientSecret: string },
  args: {
    brandTemplateId: string;
    data: Record<string, { type: "text" | "image"; text?: string; assetId?: string }>;
  },
): Promise<{ designId: string }> {
  if (!args.brandTemplateId) throw new Error("Select a brand template.");
  if (!args.data || Object.keys(args.data).length === 0) throw new Error("Provide autofill data.");
  const token = await getValidCanvaToken(db, workspaceId, port, client);
  if (!token) throw new Error("No Canva account connected — connect Canva in the studio first.");
  try {
    const { designId } = await port.autofill(token, args.brandTemplateId, args.data);
    await auditStudio(db, workspaceId, projectId, "studio_canva_autofilled", `Brand template autofilled → design ${designId}.`);
    return { designId };
  } catch (err) {
    await fireCanvaAlert(db, workspaceId, "autofill brand template", err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Brand-kit defaults (M12 reuse) for Canva brand-template autofill.
// Brand-template datasets are arbitrary per template, so there is no
// universal automatic mapping: this returns the workspace's default (or
// first) brand kit and the UI offers one-click prefill of text/image fields
// whose names look like business-name, tagline, or logo slots.
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

export async function startStudioExport(
  db: Db,
  workspaceId: string,
  port: CanvaPort,
  client: { clientId: string; clientSecret: string },
  args: { designId: string; format: CanvaExportFormat },
): Promise<{ exportId: string }> {
  if (!args.designId) throw new Error("Select a design.");
  const token = await getValidCanvaToken(db, workspaceId, port, client);
  if (!token) throw new Error("No Canva account connected — connect Canva in the studio first.");
  try {
    return await port.startExport(token, args.designId, args.format);
  } catch (err) {
    await fireCanvaAlert(db, workspaceId, "export design", err);
    throw err;
  }
}

export async function pollStudioExport(
  db: Db,
  workspaceId: string,
  port: CanvaPort,
  client: { clientId: string; clientSecret: string },
  exportId: string,
): Promise<CanvaExport> {
  const token = await getValidCanvaToken(db, workspaceId, port, client);
  if (!token) throw new Error("No Canva account connected — connect Canva in the studio first.");
  return port.getExport(token, exportId);
}

async function fireCanvaAlert(db: Db, workspaceId: string, op: string, err: unknown) {
  const message = err instanceof Error ? err.message : "Unknown error";
  await auditStudio(db, workspaceId, null, "studio_canva_failed", `Canva ${op} failed: ${message.slice(0, 120)}`, "system");
  try {
    await emitAlert({
      workspaceId,
      projectId: null,
      trigger: "studio_canva_failed",
      severity: "warn",
      title: `Canva ${op} failed`,
      body: message,
      dedupKey: `studio_canva_failed:${op}:${workspaceId}`,
    });
  } catch {
    // alert failures never break the flow
  }
}

/** Production Canva port — real HTTPS. Requires CANVA_CLIENT_ID/SECRET. */
export function getProductionCanvaPort(): CanvaPort {
  return createCanvaPort();
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

// Single-use confirmation tokens (5-min TTL). Single-process only — noted in DEPLOY.md.
const purchaseConfirmations = new Map<string, PurchaseConfirmation>();

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

  const token = randomBytes(24).toString("hex");
  purchaseConfirmations.set(token, {
    projectId,
    workspaceId,
    domain: clean,
    priceCents: Math.round(availability.priceUsd * 100),
    expiresAt: Date.now() + 5 * 60 * 1000,
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
  const confirmation = purchaseConfirmations.get(args.confirmationToken);
  purchaseConfirmations.delete(args.confirmationToken);
  if (!confirmation) throw new Error("Confirmation token expired or invalid — restart the purchase.");
  if (confirmation.expiresAt < Date.now()) throw new Error("Confirmation token expired — restart the purchase.");
  if (confirmation.projectId !== projectId || confirmation.workspaceId !== workspaceId) {
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

export type AssetSource = "canva" | "upload" | "generated";

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
    canvaDesignId?: string;
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
      canvaDesignId: args.canvaDesignId ?? null,
    },
  });
  await auditStudio(db, workspaceId, projectId, "studio_asset_created", `Asset added: ${name} (${args.source}).`, actor);
  return row;
}

/** Import a Canva export into the project asset library. */
export async function importCanvaExportAsAsset(
  db: Db,
  workspaceId: string,
  projectId: string,
  args: { name: string; downloadUrl: string; designId: string; format: string; mimeType?: string },
  actor: Actor = "user",
) {
  return createAsset(
    db,
    workspaceId,
    projectId,
    {
      name: args.name,
      source: "canva",
      url: args.downloadUrl,
      mimeType: args.mimeType ?? undefined,
      metadata: { designId: args.designId, exportFormat: args.format, importedAt: new Date().toISOString() },
      canvaDesignId: args.designId,
    },
    actor,
  );
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

/** Wire an asset into the M20 social studio as post media. When no services are
 * passed, the project's enabled channels are used; errors clearly if none. */
export async function useAssetInSocialPost(
  db: Db,
  workspaceId: string,
  projectId: string,
  assetId: string,
  args: { text: string; services: string[] },
  actor: Actor = "user",
) {
  const asset = await db.projectAsset.findFirst({ where: { id: assetId, projectId } });
  if (!asset) throw new Error("Asset not found.");
  let services = args.services;
  if (services.length === 0) {
    const channels = await db.socialChannel.findMany({
      where: { projectId, enabled: true },
      select: { service: true },
    });
    services = channels.map((c) => c.service);
  }
  if (services.length === 0) {
    throw new Error("No social channels are connected for this project — connect one in the social studio first.");
  }
  return createSocialPost(
    db,
    workspaceId,
    projectId,
    {
      content: { text: args.text, media: [{ url: asset.url, mimeType: asset.mimeType ?? undefined }] },
      services,
    },
    actor,
  );
}

/** Test-only: clear in-memory OAuth/purchase state between fixture runs. */
export function __resetStudioTestState() {
  pendingOAuth.clear();
  purchaseConfirmations.clear();
}

/** Test-only: seed a confirmation token (mirrors previewDomainPurchase). */
export function __seedPurchaseConfirmation(input: PurchaseConfirmation): string {
  const token = randomBytes(24).toString("hex");
  purchaseConfirmations.set(token, input);
  return token;
}

// Keep the mock import referenced so tree-shaking/CI don't flag it unused;
// production code paths select the real port.
export const __mockPorkbunPortFactory = createMockPorkbunPort;
