// Marketr — standalone SERP analysis API.
// POST /api/serp/analyze  { projectId, keyword, locationCode?, device? }
// → { analysis, charged, eventId, credits }
// One charge of "serp_analysis" per successful pull (day-bucketed
// idempotency — T13). Cap-denied workspaces get 402 with the
// plain-language message and zero execution.

import { requireUser } from "@/lib/session";
import { requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { analyzeSerp, ActionError } from "@/lib/serp/analyze";
import { CREDIT_COSTS } from "@/lib/metering/credits";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    projectId?: string;
    keyword?: string;
    locationCode?: number;
    device?: "desktop" | "mobile";
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
    const { analysis, charged, eventId } = await analyzeSerp({
      userId: user.id,
      projectId: body.projectId ?? "",
      keyword: body.keyword ?? "",
      locationCode: body.locationCode,
      device: body.device,
      actorId: user.id,
    });
    return Response.json({
      analysis,
      charged,
      eventId,
      credits: CREDIT_COSTS.serp_analysis.credits,
    });
  } catch (err) {
    if (err instanceof ActionError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json({ error: "SERP analysis failed." }, { status: 500 });
  }
}
