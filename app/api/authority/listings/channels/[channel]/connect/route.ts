// Marketr — POST /api/authority/listings/channels/:channel/connect
//
// Connect a channel. The tier is authoritative from the taxonomy (channelTier)
// — the client cannot self-declare a more automated tier. Bing starts the
// trusted-partner application flow; Apple starts the guided-claim walkthrough;
// LDE refuses without the feature flag.

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { authorityTablesReady, authorityAudit } from "@/lib/authority/db";
import { createPrismaListingStore } from "@/lib/authority/listings/store";
import { channelTier } from "@/lib/authority/listings/tiers";
import { newBingApplication } from "@/lib/authority/listings/bing";
import { newAppleClaimState, APPLE_CLAIM_STEPS } from "@/lib/authority/listings/apple";
import { ldeFlagEnabled } from "@/lib/authority/listings/lde";
import { connectChannelSchema } from "@/app/api/authority/listings/_schemas";

export const dynamic = "force-dynamic";

interface RouteParams { params: Promise<{ channel: string }> }

export async function POST(req: NextRequest, { params }: RouteParams) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ error: "Authority tables not provisioned yet." }, { status: 503 });
  }
  const { channel } = await params;
  const key = channel.trim().toLowerCase();
  if (!key) return badRequest("Channel is required.");

  let raw: unknown;
  try { raw = await req.json(); } catch { return badRequest("Invalid JSON"); }
  const parsed = connectChannelSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const info = channelTier(key);
    const store = createPrismaListingStore();
    const config: Record<string, unknown> = { ...(parsed.data.config as Record<string, unknown>) };

    if (key === "lde" && !ldeFlagEnabled()) {
      return Response.json({
        error: "The Local Data Exchange prototype is behind a feature flag — enable MARKETR_LDE_PROTOTYPE=1 (Settings → Authority → Listings).",
        flagged: true,
      }, { status: 422 });
    }
    if (key === "bing") {
      // Connecting = starting the trusted-partner application (sandbox first, then production).
      const app = newBingApplication(gate.workspaceId);
      config.bingApplication = { ...app, notes: [...app.notes, "Application started via ShapesOS connect. Email partneronbp@microsoft.com to proceed."] };
    }
    if (key === "apple") {
      // Guided claim — no automation implied.
      const claim = newAppleClaimState(gate.workspaceId);
      config.appleClaim = claim;
      config.appleClaimSteps = APPLE_CLAIM_STEPS;
    }

    const row = await store.channels.upsert({
      workspaceId: gate.workspaceId, channel: key, tier: info.tier, config,
    });
    await store.channels.patch(gate.workspaceId, key, { status: "connected" });

    // Create profile rows for any locations supplied in config (GBP connect).
    const locations = (config.locations ?? []) as { locationRef?: string; nap?: Record<string, unknown>; hours?: Record<string, unknown>; attributes?: Record<string, unknown>; photos?: string[] }[];
    const createdProfiles: string[] = [];
    if (Array.isArray(locations)) {
      for (const loc of locations) {
        if (!loc.locationRef) continue;
        try {
          const p = await store.profiles.create({
            workspaceId: gate.workspaceId, channel: key, locationRef: loc.locationRef,
            nap: loc.nap, hours: loc.hours, attributes: loc.attributes, photos: loc.photos,
          });
          createdProfiles.push(p.id);
        } catch { /* duplicate locationRef — skip */ }
      }
    }

    await authorityAudit.logAsync({
      workspaceId: gate.workspaceId, actor: gate.userId, action: "listing_channel_connected",
      entityType: "listing_channel", entityId: row.id,
      detail: { channel: key, tier: info.tier, profilesCreated: createdProfiles.length },
    }).catch(() => undefined);

    return Response.json({
      channel: key, displayName: info.displayName,
      tier: info.tier, tierLabel: info.tierLabel, capabilityNote: info.capabilityNote,
      status: "connected", createdProfiles,
    });
  } catch (err) {
    return safetyError(err);
  }
}
