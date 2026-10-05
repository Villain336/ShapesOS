// ShapesOS — Phase 1: durable outreach webhook idempotency
// (outreach_webhook_events, unique (provider, event_id)).

import { prisma } from "@/lib/prisma";
import type { WebhookEventStore } from "./webhooks";

export function prismaWebhookEventStore(): WebhookEventStore {
  return {
    async claim({ provider, eventId, workspaceId, type }) {
      try {
        await prisma.outreachWebhookEvent.create({ data: { provider, eventId, workspaceId, type } });
        return true;
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") return false; // already processed
        throw e;
      }
    },
    async release(provider, eventId) {
      await prisma.outreachWebhookEvent.deleteMany({ where: { provider, eventId } });
    },
  };
}
