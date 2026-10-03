// ShapesOS — SCIM 2.0 Users collection (RFC 7644 §3.3, §3.4.2). Phase 4a.
//
// GET  /api/scim/v2/Users?filter=userName eq "a@b.c"&startIndex=1&count=100
// POST /api/scim/v2/Users → 201 + the created User (pending member, viewer)
//
// Auth: per-workspace SCIM bearer token (requireScimAuth, lib/scim/auth.ts).
// The token decides the workspace; nothing in the request can name another.

import { requireScimAuth } from "@/lib/scim/auth";
import { pagination, readScimBody, scimErrorFrom, scimJson } from "@/lib/scim/http";
import { createUser, listUsers } from "@/lib/scim/service";
import { scimBaseUrl } from "@/lib/scim/base-url";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const ctx = await requireScimAuth(req);
    const url = new URL(req.url);
    const page = pagination(url);
    return scimJson(await listUsers(ctx, scimBaseUrl(req), { filter: url.searchParams.get("filter"), ...page }));
  } catch (err) {
    return scimErrorFrom(err);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireScimAuth(req);
    const body = await readScimBody(req);
    const user = await createUser(ctx, scimBaseUrl(req), body);
    return scimJson(user, 201, { location: String((user.meta as { location: string }).location) });
  } catch (err) {
    return scimErrorFrom(err);
  }
}
