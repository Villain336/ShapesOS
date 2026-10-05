// ShapesOS — SCIM 2.0 ServiceProviderConfig (RFC 7644 §4). Phase 4a.
// Auth: per-workspace SCIM bearer token (requireScimAuth).

import { requireScimAuth } from "@/lib/scim/auth";
import { scimErrorFrom, scimJson } from "@/lib/scim/http";
import { serviceProviderConfig } from "@/lib/scim/discovery";
import { scimBaseUrl } from "@/lib/scim/base-url";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireScimAuth(req);
    return scimJson(serviceProviderConfig(scimBaseUrl(req)));
  } catch (err) {
    return scimErrorFrom(err);
  }
}
