// ShapesOS — SCIM 2.0 Groups collection (RFC 7644 §3.3, §3.4.2). Phase 4a.
//
// Groups map to workspace roles: the displayName must name admin, editor or
// viewer (e.g. "ShapesOS Admins"); members get the highest role among their
// groups. GET supports `displayName eq "…"` / `externalId eq "…"` filters and
// excludedAttributes=members.
// Auth: per-workspace SCIM bearer token (requireScimAuth).

import { requireScimAuth } from "@/lib/scim/auth";
import { pagination, readScimBody, scimErrorFrom, scimJson } from "@/lib/scim/http";
import { createGroup, listGroups } from "@/lib/scim/service";
import { scimBaseUrl } from "@/lib/scim/base-url";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const ctx = await requireScimAuth(req);
    const url = new URL(req.url);
    const excluded = (url.searchParams.get("excludedAttributes") ?? "").toLowerCase().split(",").map((s) => s.trim());
    return scimJson(
      await listGroups(ctx, scimBaseUrl(req), {
        filter: url.searchParams.get("filter"),
        ...pagination(url),
        excludeMembers: excluded.includes("members"),
      }),
    );
  } catch (err) {
    return scimErrorFrom(err);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireScimAuth(req);
    const group = await createGroup(ctx, scimBaseUrl(req), await readScimBody(req));
    return scimJson(group, 201, { location: String((group.meta as { location: string }).location) });
  } catch (err) {
    return scimErrorFrom(err);
  }
}
