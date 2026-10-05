// ShapesOS — GET /api/health/live: liveness (Phase 4a observability).
// No I/O: answers as long as the server process can serve a request, so a
// database outage never gets the app restarted (that's what /api/health,
// the readiness check, is for). Public by design, like /api/health.

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
