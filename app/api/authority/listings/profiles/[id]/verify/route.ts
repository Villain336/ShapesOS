// Marketr — GET /api/authority/listings/profiles/:id/verify
//
// Verification status for a profile: GBP verification is owner-performed
// (postcard/video); the API only reflects it. Also surfaces queued edits and
// the channel's true tier label.

import type { NextRequest } from "next/server";
import { authorityGuard, safetyError } from "@/app/api/authority/_lib";
import { authorityTablesReady } from "@/lib/authority/db";
import { createPrismaListingStore } from "@/lib/authority/listings/store";
import { channelTier } from "@/lib/authority/listings/tiers";
import { GBP_VERIFICATION_STEPS, GBP_APPLICATION_COPY } from "@/lib/authority/listings/gbp";
import { APPLE_REVIEW_REPLIES_COPY } from "@/lib/authority/listings/apple";

export const dynamic = "force-dynamic";

interface RouteParams { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ error: "Authority tables not provisioned yet." }, { status: 503 });
  }
  const { id } = await params;
  try {
    const store = createPrismaListingStore();
    const profile = await store.profiles.get(id, gate.workspaceId);
    if (!profile) return Response.json({ error: "Profile not found in workspace." }, { status: 404 });
    const info = channelTier(profile.channel);
    const queued = await store.jobs.queuedForProfile(gate.workspaceId, profile.id);
    const channel = await store.channels.get(gate.workspaceId, profile.channel);

    return Response.json({
      profile: {
        id: profile.id, channel: profile.channel, locationRef: profile.locationRef,
        verificationStatus: profile.verificationStatus,
        nap: profile.napJson, hours: profile.hoursJson,
        attributes: profile.attributesJson, photos: profile.photosJson,
      },
      tier: info.tier, tierLabel: info.tierLabel, capabilityNote: info.capabilityNote,
      channelStatus: channel?.status ?? "disconnected",
      lastSyncAt: channel?.lastSyncAt ?? null,
      lastVerifiedAt: channel?.lastVerifiedAt ?? null,
      queuedEdits: queued.map((j) => ({ id: j.id, kind: (j.payloadJson as { kind?: string }).kind ?? "unknown", scheduledAt: j.scheduledAt, status: j.status })),
      verification: {
        gbp: profile.channel === "gbp" ? { steps: GBP_VERIFICATION_STEPS, applicationCopy: GBP_APPLICATION_COPY } : undefined,
        appleNote: profile.channel === "apple" ? APPLE_REVIEW_REPLIES_COPY : undefined,
        honest: profile.channel === "gbp"
          ? "Verification is owner-performed; the API only initiates/completes the flow."
          : undefined,
      },
    });
  } catch (err) {
    return safetyError(err);
  }
}
