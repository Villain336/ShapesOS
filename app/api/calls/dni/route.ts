// Marketr — Calls API: DNI number resolution.
// GET /api/calls/dni?workspace=<id>&source=<source> — PUBLIC BY DESIGN
// (runs in a visitor's browser via the snippet), rate-limited. Only
// exposes phone numbers the business already publishes.

import { prisma } from "@/lib/prisma";
import { InMemoryRateLimiter } from "@/lib/mcp/rateLimit";
import { resolveDniNumber } from "@/lib/calls/dni";
import { clientIpFromHeaders } from "@/lib/api/client-ip";

const limiter = new InMemoryRateLimiter();

/** Test seam. */
export function resetDniLimiter(): void {
  limiter.reset();
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const workspaceId = (sp.get("workspace") ?? "").trim().slice(0, 64);
  const source = (sp.get("source") ?? "").trim().slice(0, 160);
  if (!workspaceId) {
    return Response.json({ error: "workspace is required" }, { status: 400 });
  }
  const ip = clientIpFromHeaders(req.headers) ?? "unknown";
  const rl = await limiter.check(`dni:${workspaceId}:${ip}`, 60, 60_000);
  if (!rl.allowed) {
    return Response.json({ error: "Too many requests" }, { status: 429 });
  }
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true },
  });
  if (!workspace) return Response.json({ error: "Not found" }, { status: 404 });

  const number = await resolveDniNumber(workspaceId, source);
  return Response.json({ number: number?.e164 ?? null, campaign: number?.campaign ?? null, source: source || null });
}
