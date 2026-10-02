// Marketr — Funding/VC slice 1 API.
// GET /api/funding/intro-requests — list the tenant's intro requests.
// POST /api/funding/intro-requests — request one intro (editor role).
// Guardrail scaffolding: context-required fields, one request per
// (contact, investor) pair, per-contact 24h rate limit. Single create only —
// there is no bulk endpoint. Full double-opt-in lifecycle lands in
// Connector slice 4.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError, type IntroRequestInput } from "@/lib/funding/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaFundingStore(prisma);
    const rows = await store.listIntroRequests(workspace.id);
    return Response.json({
      introRequests: rows.map((r) => ({
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

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as IntroRequestInput;
    const store = new PrismaFundingStore(prisma);
    const created = await store.createIntroRequest(workspace.id, body);
    return Response.json(created, { status: 201 });
  } catch (e) {
    if (e instanceof FundingError) {
      const status =
        e.code === "rate_limited" ? 429 : e.code === "duplicate_intro_request" ? 409 : 400;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}
