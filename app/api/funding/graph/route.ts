// Marketr — Funding/VC slice 1 API.
// GET /api/funding/graph — the tenant's funding graph: contacts (Boardy the
// preloaded starter contact first), the active round's target investor
// profile, and intro requests. First read initializes the graph: Boardy is
// inserted idempotently — never duplicated on re-run.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaFundingStore(prisma);
    const { contact: starter } = await store.ensureStarterContact(workspace.id);
    const [contacts, round, introRequests] = await Promise.all([
      store.listContacts(workspace.id),
      store.getActiveRound(workspace.id),
      store.listIntroRequests(workspace.id),
    ]);
    return Response.json({
      starterContactId: starter.id,
      contacts,
      round,
      introRequests: introRequests.map((r) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        founderAsk: r.founderAsk,
        requestedAt: r.requestedAt,
        contactName: r.contact.name,
        investorName: r.investor.name,
      })),
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
