// Marketr — GET /api/authority/pr/opportunities
// Opportunity feed: matched + deadline-triaged, same-day urgency flags. Viewer+.

import type { NextRequest } from "next/server";
import { authorityGuard } from "@/app/api/authority/_lib";
import { authorityTablesReady } from "@/lib/authority/db";
import { opportunityFeed } from "@/lib/authority/pr/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ opportunities: [], tablesReady: false });
  }
  const feed = await opportunityFeed(gate.workspaceId);
  return Response.json({ opportunities: feed, tablesReady: true });
}
