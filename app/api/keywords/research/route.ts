// Marketr — standalone keyword research API.
// POST /api/keywords/research  { projectId, seedKeyword, locationCode?, limit? }
// → { report, charged, eventId, credits }
// One charge of "keyword_research" per successful task (day-bucketed
// idempotency — T13). Cap-denied workspaces get 402 with the
// plain-language message and zero execution.

import { requireUser } from "@/lib/session";
import { requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { researchKeywords } from "@/lib/keywords/research";
import { ActionError } from "@/lib/serp/analyze";
import { CREDIT_COSTS } from "@/lib/metering/credits";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    projectId?: string;
    seedKeyword?: string;
    locationCode?: number;
    limit?: number;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Authorization gate (visible to the M11 static scan): editor+ on the
  // project. The lib repeats this check for the MCP path — defense in depth.
  if (!body.projectId) {
    return Response.json({ error: "projectId is required." }, { status: 400 });
  }
  if (!(await requireProjectRole(user.id, body.projectId, "editor"))) {
    return forbidden();
  }

  try {
    const { report, charged, eventId } = await researchKeywords({
      userId: user.id,
      projectId: body.projectId ?? "",
      seedKeyword: body.seedKeyword ?? "",
      locationCode: body.locationCode,
      limit: body.limit,
      actorId: user.id,
    });
    return Response.json({
      report,
      charged,
      eventId,
      credits: CREDIT_COSTS.keyword_research.credits,
    });
  } catch (err) {
    if (err instanceof ActionError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json({ error: "Keyword research failed." }, { status: 500 });
  }
}
