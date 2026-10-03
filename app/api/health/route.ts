// ShapesOS — GET /api/health: readiness (Phase 4a observability).
// Public by design (load balancers, the compose healthcheck and uptime
// monitors call it without a session); read-only, and the body carries status
// words, counts and a latency only (lib/observability/health.ts).
//   200 { status: "ok", … }           database reachable, migrations applied
//   503 { status: "unavailable", … }  database down/slow, or migrations pending/failed

import { readiness } from "@/lib/observability/health";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const report = await readiness();
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function HEAD(): Promise<Response> {
  const report = await readiness();
  return new Response(null, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
