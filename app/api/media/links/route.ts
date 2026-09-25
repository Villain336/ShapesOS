// Marketr — POST /api/media/links (per-placement QR/pURL creation).
//
// { placementRef, slug?, destinationUrl, buyId?, utm?, domain? }
// → { link, publicUrl, placementGuidance }
// The response carries the OAAA dwell-time placement guidance (planner copy).

import type { NextRequest } from "next/server";
import { z } from "zod";
import { mediaGuard, badRequest } from "../_lib";
import { getMediaStore } from "@/lib/media/store";
import { resolveLinkEngine, PLACEMENT_GUIDANCE } from "@/lib/media/links";

export const dynamic = "force-dynamic";

const CreateLinkSchema = z.object({
  placementRef: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(2).max(64).optional(),
  destinationUrl: z.string().trim().url().max(2048),
  buyId: z.string().trim().min(1).max(64).optional(),
  utm: z.record(z.string(), z.string()).optional(),
  domain: z.string().trim().min(3).max(128).optional(),
});

export async function POST(req: NextRequest) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = CreateLinkSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const engine = resolveLinkEngine(getMediaStore(), {
      domain: parsed.data.domain,
      dubBaseUrl: process.env.DUB_BASE_URL ?? null,
    });
    const link = await engine.createLink({
      workspaceId: gate.workspaceId,
      buyId: parsed.data.buyId ?? null,
      placementRef: parsed.data.placementRef,
      slug: parsed.data.slug,
      destinationUrl: parsed.data.destinationUrl,
      utm: parsed.data.utm,
      domain: parsed.data.domain,
    });
    return Response.json({
      link,
      publicUrl: engine.publicUrl(link),
      placementGuidance: PLACEMENT_GUIDANCE,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Link creation failed";
    const status = msg.includes("already taken") ? 409 : 400;
    return Response.json({ error: msg }, { status });
  }
}
