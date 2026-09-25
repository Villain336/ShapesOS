// Marketr — GET /api/media/lift (branded-search lift dashboard data).
//
// ?brandQuery=&baselineStart=&baselineEnd=&flightStart=&flightEnd=
// &boardMetros=a,b&holdoutMetros=c&buyId=
// → { lift, direct, gbp } (directional — see printed caveats on the card).

import type { NextRequest } from "next/server";
import { mediaGuard, badRequest } from "../_lib";
import { getMediaStore } from "@/lib/media/store";
import {
  FakeLiftProvider,
  computeLift,
  computeDirectTrafficLift,
  computeGbpLift,
  type LiftSource,
} from "@/lib/media/lift";

export const dynamic = "force-dynamic";

const SOURCES: LiftSource[] = ["gsc", "gtrends", "ga4", "gbp"];

export async function GET(req: NextRequest) {
  const gate = await mediaGuard("viewer");
  if (gate instanceof Response) return gate;
  const q = req.nextUrl.searchParams;

  const brandQuery = (q.get("brandQuery") ?? "").trim();
  const baselineStart = q.get("baselineStart") ?? "";
  const baselineEnd = q.get("baselineEnd") ?? "";
  const flightStart = q.get("flightStart") ?? "";
  const flightEnd = q.get("flightEnd") ?? "";
  const buyId = (q.get("buyId") ?? "").trim();
  if (!brandQuery || !baselineStart || !baselineEnd || !flightStart || !flightEnd || !buyId) {
    return badRequest("brandQuery, baselineStart/End, flightStart/End and buyId are required");
  }
  const boardMetros = (q.get("boardMetros") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const holdoutMetros = (q.get("holdoutMetros") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!boardMetros.length) return badRequest("boardMetros must list at least one metro");
  const source = (q.get("source") ?? "gsc") as LiftSource;
  if (!SOURCES.includes(source)) return badRequest(`source must be one of ${SOURCES.join(", ")}`);

  try {
    const provider = new FakeLiftProvider(); // fake-data default; live OAuth lands later
    const query = { brandQuery, baselineStart, baselineEnd, flightStart, flightEnd, boardMetros, holdoutMetros };
    const [lift, direct, gbp] = await Promise.all([
      computeLift(provider, query, source),
      computeDirectTrafficLift(provider, query),
      computeGbpLift(provider, query),
    ]);
    // Snapshot the pull so the report card is reproducible.
    await getMediaStore().saveLiftSnapshot({
      workspaceId: gate.workspaceId,
      buyId,
      source,
      baselineJson: { baselineStart, baselineEnd, metros: lift.metros, devices: lift.devices },
      flightJson: { flightStart, flightEnd, direct, gbp },
      holdoutJson: { holdoutMetros, netLiftPct: lift.netLiftPct },
    });
    return Response.json({ lift, direct, gbp, caveats: "See the report card — directional indicators, never causal claims." });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Lift computation failed" }, { status: 400 });
  }
}
