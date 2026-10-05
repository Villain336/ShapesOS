// ShapesOS — SCIM 2.0 ResourceTypes (RFC 7644 §4). Phase 4a.
// Auth: per-workspace SCIM bearer token (requireScimAuth).

import { requireScimAuth } from "@/lib/scim/auth";
import { listResponse, scimErrorFrom, scimJson } from "@/lib/scim/http";
import { resourceTypes } from "@/lib/scim/discovery";
import { scimBaseUrl } from "@/lib/scim/base-url";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireScimAuth(req);
    const types = resourceTypes(scimBaseUrl(req));
    return scimJson(listResponse(types, types.length, 1));
  } catch (err) {
    return scimErrorFrom(err);
  }
}
