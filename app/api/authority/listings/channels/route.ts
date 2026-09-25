// Marketr — GET /api/authority/listings/channels
// Channel list with TRUE tier labels (spec §9.10 — mandatory on every channel card).

import type { NextRequest } from "next/server";
import { authorityGuard, safetyError } from "@/app/api/authority/_lib";
import { authorityTablesReady } from "@/lib/authority/db";
import { createPrismaListingStore } from "@/lib/authority/listings/store";
import { CHANNEL_DEFINITIONS, channelTier } from "@/lib/authority/listings/tiers";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ error: "Authority tables not provisioned yet." }, { status: 503 });
  }
  try {
    const store = createPrismaListingStore();
    const connected = await store.channels.list(gate.workspaceId);
    const rows = connected.map((c) => {
      const info = channelTier(c.channel);
      return {
        id: c.id, channel: c.channel, displayName: info.displayName,
        // The true tier label — authoritative from the taxonomy, never user-supplied.
        tier: c.tier, tierLabel: info.tierLabel, capabilityNote: info.capabilityNote,
        canDo: info.canDo, cannotDo: info.cannotDo,
        status: c.status, lastSyncAt: c.lastSyncAt, lastVerifiedAt: c.lastVerifiedAt,
        syncErrors: c.syncErrorsJson, config: c.configJson,
      };
    });
    const catalog = CHANNEL_DEFINITIONS.map((d) => ({
      channel: d.channel, displayName: d.displayName,
      tier: d.tier, tierLabel: channelTier(d.channel).tierLabel,
      capabilityNote: d.capabilityNote, canDo: d.canDo, cannotDo: d.cannotDo,
      connected: connected.some((c) => c.channel === d.channel),
    }));
    return Response.json({ channels: rows, catalog, tablesReady: true });
  } catch (err) {
    return safetyError(err);
  }
}
