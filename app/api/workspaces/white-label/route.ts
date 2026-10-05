// Marketr — white-label workspace config (Phase 13 Wave A, worker 6).
// GET  /api/workspaces/white-label → { whiteLabel: { logoUrl, customDomain, brandColor }, canEdit }
// PUT  /api/workspaces/white-label { customDomain?, brandColor? } → { whiteLabel } (admin+)
//
// Writes the three write-dead Workspace fields (schema §6: white_label_logo_url,
// white_label_custom_domain, white_label_brand_color) that the public review
// pages read. The brand color ALSO mirrors into the workspace's default brand
// kit colors.primary — the theming foundation's single source of truth — so the
// dashboard re-tints through the same CSS vars (--brand-600/700/50) instead of
// forking a second color system. On clear, the kit primary is only reverted to
// the default violet when it still equals the previously synced value (a
// separately-edited kit is never clobbered).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { sanitizeBrandHex, DEFAULT_BRAND_PRIMARY } from "@/lib/brand-theme";
import {
  EntitlementError,
  entitlementDenied,
  entitlementSummary,
  featureUpgradeMessage,
  planHasFeature,
} from "@/lib/billing/entitlements";

export const dynamic = "force-dynamic";

/** Validate a bare custom-domain hostname. DNS provisioning is out of scope —
// the field is validated for format only and labeled honestly in the UI. */
export function validateCustomDomain(value: unknown): { ok: true; domain: string } | { ok: false; reason: string } {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    return { ok: true, domain: "" };
  }
  if (typeof value !== "string") return { ok: false, reason: "Custom domain must be a string." };
  const domain = value.trim().toLowerCase();
  if (domain.length > 253) return { ok: false, reason: "Custom domain is too long." };
  if (/^(https?:)?\/\//.test(domain) || /[\s/?#@:]/.test(domain)) {
    return { ok: false, reason: "Enter just the domain (e.g. reviews.acme.com) — no protocol, path, or port." };
  }
  const label = "(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  if (!new RegExp(`^${label}(?:\\.${label})+$`).test(domain)) {
    return { ok: false, reason: "That doesn't look like a valid domain (e.g. reviews.acme.com)." };
  }
  return { ok: true, domain };
}

/** Mirror a white-label brand color into the default brand kit (the theming
 * source of truth). Passing null reverts the kit primary to the default
 * violet only when the kit still holds the previously synced value. */
async function syncDefaultKitBrand(workspaceId: string, color: string | null, previous: string | null) {
  const kit = await prisma.brandKit.findFirst({
    where: { workspaceId, isDefault: true },
    select: { id: true, colors: true },
  });
  if (color) {
    const colors = { ...((kit?.colors as Record<string, string> | null) ?? {}), primary: color };
    if (kit) {
      await prisma.brandKit.update({ where: { id: kit.id }, data: { colors } });
    } else {
      await prisma.brandKit.create({
        data: { workspaceId, name: "Default kit", colors, fonts: {}, isDefault: true },
      });
    }
    return;
  }
  // Clearing: only revert a kit we previously synced (same primary as the old
  // workspace value). A kit edited separately in Brand kits is left alone.
  if (kit && previous) {
    const current = (kit.colors as Record<string, string> | null)?.primary;
    if (sanitizeBrandHex(current) === sanitizeBrandHex(previous)) {
      await prisma.brandKit.update({
        where: { id: kit.id },
        data: { colors: { ...((kit.colors as Record<string, string> | null) ?? {}), primary: DEFAULT_BRAND_PRIMARY } },
      });
    }
  }
}

function publicLogoUrl(logoPath: string | null, workspaceId: string): string | null {
  return logoPath ? `/api/public/workspaces/${workspaceId}/logo` : null;
}

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const canEdit = (await requireWorkspaceRole(user.id, workspace.id, "admin")) !== null;
  return Response.json({
    whiteLabel: {
      logoUrl: publicLogoUrl(workspace.whiteLabelLogoUrl, workspace.id),
      customDomain: workspace.whiteLabelCustomDomain ?? null,
      brandColor: workspace.whiteLabelBrandColor ?? null,
    },
    canEdit,
    // Phase 4a: what the plan includes, so the UI can disable what it doesn't.
    entitlements: {
      whiteLabel: entitlementSummary(workspace.plan).features.white_label,
      customDomain: entitlementSummary(workspace.plan).features.custom_domain,
    },
  });
}

export async function PUT(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "admin"))) return forbidden();
  // Phase 4a: white-label is a plan entitlement (403 + upgrade prompt).
  if (!planHasFeature(workspace.plan, "white_label")) {
    return entitlementDenied(new EntitlementError(featureUpgradeMessage("white_label"), "white_label"));
  }

  let body: { customDomain?: unknown; brandColor?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data: { whiteLabelCustomDomain?: string | null; whiteLabelBrandColor?: string | null } = {};

  if (body.customDomain !== undefined) {
    const check = validateCustomDomain(body.customDomain);
    if (!check.ok) return Response.json({ error: check.reason }, { status: 400 });
    // Setting (not clearing) a custom domain needs its own entitlement.
    if (check.domain && !planHasFeature(workspace.plan, "custom_domain")) {
      return entitlementDenied(new EntitlementError(featureUpgradeMessage("custom_domain"), "custom_domain"));
    }
    data.whiteLabelCustomDomain = check.domain || null;
  }

  let brandColorSet: string | null | undefined;
  if (body.brandColor !== undefined) {
    if (body.brandColor === null || (typeof body.brandColor === "string" && body.brandColor.trim() === "")) {
      data.whiteLabelBrandColor = null;
      brandColorSet = null;
    } else {
      const clean = sanitizeBrandHex(body.brandColor);
      if (!clean) return Response.json({ error: "Brand color must be a hex color like #1f6feb." }, { status: 400 });
      data.whiteLabelBrandColor = clean;
      brandColorSet = clean;
    }
  }

  if (Object.keys(data).length === 0) {
    return Response.json({ error: "Nothing to update." }, { status: 400 });
  }

  const previous = workspace.whiteLabelBrandColor ?? null;
  const updated = await prisma.workspace.update({ where: { id: workspace.id }, data });

  // One color system: keep the default brand kit (theming source of truth)
  // in lockstep with the workspace's white-label brand color.
  if (brandColorSet !== undefined) {
    await syncDefaultKitBrand(workspace.id, brandColorSet, previous);
  }

  return Response.json({
    whiteLabel: {
      logoUrl: publicLogoUrl(updated.whiteLabelLogoUrl, updated.id),
      customDomain: updated.whiteLabelCustomDomain ?? null,
      brandColor: updated.whiteLabelBrandColor ?? null,
    },
  });
}
