// Marketr — POST /api/authority/listings/profiles (editor)
// Create a listing profile row for a channel (needed before syncing).

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { authorityTablesReady } from "@/lib/authority/db";
import { createPrismaListingStore } from "@/lib/authority/listings/store";
import { createProfileSchema } from "@/app/api/authority/listings/_schemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ error: "Authority tables not provisioned yet." }, { status: 503 });
  }
  let raw: unknown;
  try { raw = await req.json(); } catch { return badRequest("Invalid JSON"); }
  const parsed = createProfileSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
  try {
    const store = createPrismaListingStore();
    const profile = await store.profiles.create({
      workspaceId: gate.workspaceId,
      channel: parsed.data.channel.trim().toLowerCase(),
      locationRef: parsed.data.locationRef,
      nap: parsed.data.nap, hours: parsed.data.hours,
      attributes: parsed.data.attributes, photos: parsed.data.photos,
    });
    return Response.json({ profile });
  } catch (err) {
    return safetyError(err);
  }
}
