// Marketr — Wave 2 context.dev slice 5: brand-kit sync.
//
// Pulls a Context.dev brand profile for a domain, diffs it against a
// BrandKit, and holds the diff for editor approval. NOTHING touches the live
// kit until approveBrandSync runs — Marketr's theming (BrandTheme reads the
// workspace's default kit on every server render) then refreshes on its own,
// so no separate theming step is needed.
//
// Governance mirrors the other slices: the brand fetch is budget-gated
// BEFORE the vendor (10 credits), the API key never leaks into errors, and
// failed proposals are stored as failed rows for audit, never dropped.

import type { Prisma } from "@prisma/client";
import { storeLogo } from "@/lib/brand-logo";
import { prisma } from "@/lib/prisma";
import { createContextDevClient, ContextDevError, type BrandProfile } from "./client";
import { contextDevCreditsFor } from "./costs";
import { checkAndReserve } from "./budget-store";
import { resolveContextDevKey } from "./keys";
import { extractDomain } from "./sources";
import { sanitizeBrandHex } from "@/lib/brand-theme";

export class BrandSyncError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BrandSyncError";
    this.code = code;
  }
}

export interface BrandDiffEntry {
  field: "name" | "colors.primary" | "colors.secondary" | "fonts.heading" | "fonts.body" | "logo";
  current: string | null;
  proposed: string | null;
}

export interface BrandKitSnapshot {
  name: string;
  colors: Record<string, unknown>;
  fonts: Record<string, unknown>;
  logoPath: string | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Pure: diff a Context.dev brand profile against a kit snapshot (null = the
 * sync will create a new kit, so every proposed field is "new"). Only valid
 * hex colors participate — vendor garbage never reaches the diff.
 */
export function diffBrandKit(
  current: BrandKitSnapshot | null,
  profile: BrandProfile,
): BrandDiffEntry[] {
  const diff: BrandDiffEntry[] = [];
  const validColors = (profile.colors ?? [])
    .map((c) => sanitizeBrandHex(c))
    .filter((c): c is string => c !== null);
  const fonts = (profile.fonts ?? []).filter((f) => typeof f === "string" && f.trim());

  const push = (
    field: BrandDiffEntry["field"],
    cur: string | null,
    proposed: string | null,
  ) => {
    if (proposed === null) return;
    if (cur !== null && cur.toLowerCase() === proposed.toLowerCase()) return;
    diff.push({ field, current: cur, proposed });
  };

  push("name", current ? str(current.name) : null, profile.name?.trim() || null);
  push("colors.primary", current ? str(current.colors.primary) : null, validColors[0] ?? null);
  push(
    "colors.secondary",
    current ? str(current.colors.secondary) : null,
    validColors[1] ?? null,
  );
  push("fonts.heading", current ? str(current.fonts.heading) : null, fonts[0]?.trim() ?? null);
  push(
    "fonts.body",
    current ? str(current.fonts.body) : null,
    (fonts[1] ?? fonts[0])?.trim() ?? null,
  );
  push("logo", current?.logoPath ?? null, profile.logos?.[0]?.url ?? null);
  return diff;
}

export interface ProposeBrandSyncInput {
  domain: string;
  brandKitId?: string;
}

async function resolveTargetKit(
  workspaceId: string,
  brandKitId: string | undefined,
) {
  if (brandKitId) {
    const kit = await prisma.brandKit.findFirst({ where: { id: brandKitId, workspaceId } });
    if (!kit) throw new BrandSyncError("BAD_KIT", "Target brand kit not found");
    return kit;
  }
  return prisma.brandKit.findFirst({ where: { workspaceId, isDefault: true } });
}

function toSnapshot(kit: {
  name: string;
  colors: unknown;
  fonts: unknown;
  logoPath: string | null;
} | null): BrandKitSnapshot | null {
  if (!kit) return null;
  return {
    name: kit.name,
    colors: asRecord(kit.colors),
    fonts: asRecord(kit.fonts),
    logoPath: kit.logoPath,
  };
}

/** Fetch a brand profile and hold the diff for approval. Never applies. */
export async function proposeBrandSync(
  workspaceId: string,
  input: ProposeBrandSyncInput,
  fetchImpl: typeof fetch = fetch,
) {
  const domain = extractDomain(input.domain); // fail closed on bad URL/domain
  const kit = await resolveTargetKit(workspaceId, input.brandKitId);

  const fail = async (code: string, message: string): Promise<never> => {
    await prisma.brandSync.create({
      data: {
        workspaceId,
        brandKitId: kit?.id ?? null,
        domain,
        status: "failed",
        profileJson: {},
        diffJson: [],
        error: message,
      },
    });
    throw new BrandSyncError(code, message);
  };

  // Budget gate BEFORE the vendor.
  const gate = await checkAndReserve(workspaceId, contextDevCreditsFor("brand_retrieve"));
  if (gate.decision !== "allow") {
    await fail("BUDGET_EXCEEDED", gate.reason);
  }

  let apiKey: string;
  try {
    ({ apiKey } = await resolveContextDevKey(workspaceId));
  } catch (err) {
    await fail("NO_KEY", err instanceof Error ? err.message : "No Context.dev key connected");
  }

  let profile: BrandProfile;
  try {
    const client = createContextDevClient({ apiKey: apiKey! }, fetchImpl);
    profile = await client.getBrandByDomain(domain);
  } catch (err) {
    const message =
      err instanceof ContextDevError
        ? `Context.dev ${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : "Brand fetch failed";
    await fail("VENDOR_ERROR", message);
  }

  const diff = diffBrandKit(toSnapshot(kit), profile!);
  return prisma.brandSync.create({
    data: {
      workspaceId,
      brandKitId: kit?.id ?? null,
      domain,
      status: diff.length ? "pending_approval" : "unchanged",
      profileJson: profile! as unknown as Prisma.InputJsonValue,
      diffJson: diff as unknown as Prisma.InputJsonValue,
      creditsUsed: contextDevCreditsFor("brand_retrieve"),
    },
  });
}

/** Largest logo the sync downloads (the upload route allows 2 MB). */
const LOGO_MAX_BYTES = 5 * 1024 * 1024;
const LOGO_CONTENT_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "image/avif": "avif",
};

/**
 * Best-effort logo download into the shared blob store (namespace "logos",
 * <workspaceId>/<kitId>.<ext> — the same place uploaded logos live, so every
 * replica serves it). Returns the blob ref for BrandKit.logoPath. Never throws.
 */
async function downloadLogo(
  workspaceId: string,
  kitId: string,
  logoUrl: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    let res: Response;
    try {
      res = await fetchImpl(logoUrl, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok || !res.body) return null;
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    const ext =
      LOGO_CONTENT_TYPES[contentType] ??
      logoUrl.split("?")[0].split(".").pop()?.toLowerCase().match(/^(png|jpe?g|svg|webp|avif)$/)?.[0] ??
      "png";
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > LOGO_MAX_BYTES) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) return null;
    return await storeLogo(workspaceId, `${kitId}.${ext === "jpeg" ? "jpg" : ext}`, bytes);
  } catch {
    return null;
  }
}

/** Apply an approved diff to the target kit (creating it when needed). */
export async function approveBrandSync(
  workspaceId: string,
  syncId: string,
  fetchImpl: typeof fetch = fetch,
) {
  const sync = await prisma.brandSync.findFirst({
    where: { id: syncId, workspaceId },
    include: { brandKit: true },
  });
  if (!sync) throw new BrandSyncError("NOT_FOUND", "Brand sync proposal not found");
  if (sync.status !== "pending_approval") {
    throw new BrandSyncError("BAD_STATE", `Sync is ${sync.status}, not pending approval`);
  }

  const profile = sync.profileJson as unknown as BrandProfile;
  const diff = sync.diffJson as unknown as BrandDiffEntry[];
  const nowIso = new Date().toISOString();

  let kit = sync.brandKit;
  if (!kit) {
    const hasDefault = await prisma.brandKit.findFirst({
      where: { workspaceId, isDefault: true },
      select: { id: true },
    });
    kit = await prisma.brandKit.create({
      data: {
        workspaceId,
        name: profile?.name?.trim() || sync.domain,
        colors: {},
        fonts: {},
        metadata: {},
        isDefault: !hasDefault,
      },
    });
  }

  const colors = asRecord(kit.colors);
  const fonts = asRecord(kit.fonts);
  const metadata = asRecord(kit.metadata);
  let name = kit.name;
  let logoUrl: string | null = null;

  for (const entry of diff) {
    switch (entry.field) {
      case "name":
        if (entry.proposed) name = entry.proposed;
        break;
      case "colors.primary":
        if (entry.proposed) colors.primary = entry.proposed;
        break;
      case "colors.secondary":
        if (entry.proposed) colors.secondary = entry.proposed;
        break;
      case "fonts.heading":
        if (entry.proposed) fonts.heading = entry.proposed;
        break;
      case "fonts.body":
        if (entry.proposed) fonts.body = entry.proposed;
        break;
      case "logo":
        logoUrl = entry.proposed;
        break;
    }
  }

  let logoPath: string | undefined;
  if (logoUrl) {
    const downloaded = await downloadLogo(workspaceId, kit.id, logoUrl, fetchImpl);
    if (downloaded) logoPath = downloaded;
  }

  const updatedKit = await prisma.brandKit.update({
    where: { id: kit.id },
    data: {
      name,
      colors: colors as unknown as Prisma.InputJsonValue,
      fonts: fonts as unknown as Prisma.InputJsonValue,
      metadata: {
        ...metadata,
        provenance: {
          source: "contextdev",
          domain: sync.domain,
          syncedAt: nowIso,
          ...(logoUrl && !logoPath ? { logoDownloadFailed: logoUrl } : {}),
        },
      } as unknown as Prisma.InputJsonValue,
      ...(logoPath ? { logoPath } : {}),
    },
  });

  const updated = await prisma.brandSync.update({
    where: { id: sync.id },
    data: { status: "applied", brandKitId: kit.id, decidedAt: new Date() },
  });
  // Theming refresh is automatic: BrandTheme reads the workspace's default
  // kit on every server render, so the updated colors take effect on the
  // next dashboard load with no separate step.
  return { sync: updated, kit: updatedKit };
}

export async function rejectBrandSync(workspaceId: string, syncId: string) {
  const sync = await prisma.brandSync.findFirst({ where: { id: syncId, workspaceId } });
  if (!sync) throw new BrandSyncError("NOT_FOUND", "Brand sync proposal not found");
  if (sync.status !== "pending_approval") {
    throw new BrandSyncError("BAD_STATE", `Sync is ${sync.status}, not pending approval`);
  }
  return prisma.brandSync.update({
    where: { id: sync.id },
    data: { status: "rejected", decidedAt: new Date() },
  });
}

export async function listBrandSyncs(workspaceId: string, limit = 50) {
  return prisma.brandSync.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { brandKit: { select: { id: true, name: true, isDefault: true } } },
  });
}
