// ShapesOS — SCIM 2.0 Group resource (RFC 7644 §3.4.1, §3.5, §3.6). Phase 4a.
//
// GET / PUT / PATCH (members add/remove/replace, displayName) / DELETE.
// Member ids must be users of the token's workspace (another workspace's id
// is a 400). Membership changes re-rank roles; owners are never changed.
// Auth: per-workspace SCIM bearer token (requireScimAuth).

import { requireScimAuth } from "@/lib/scim/auth";
import { readScimBody, scimErrorFrom, scimJson } from "@/lib/scim/http";
import { deleteGroup, getGroup, patchGroup, replaceGroup } from "@/lib/scim/service";
import { scimBaseUrl } from "@/lib/scim/base-url";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  try {
    const ctx = await requireScimAuth(req);
    const { id } = await params;
    return scimJson(await getGroup(ctx, scimBaseUrl(req), id));
  } catch (err) {
    return scimErrorFrom(err);
  }
}

export async function PUT(req: Request, { params }: Params) {
  try {
    const ctx = await requireScimAuth(req);
    const { id } = await params;
    return scimJson(await replaceGroup(ctx, scimBaseUrl(req), id, await readScimBody(req)));
  } catch (err) {
    return scimErrorFrom(err);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const ctx = await requireScimAuth(req);
    const { id } = await params;
    return scimJson(await patchGroup(ctx, scimBaseUrl(req), id, await readScimBody(req)));
  } catch (err) {
    return scimErrorFrom(err);
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const ctx = await requireScimAuth(req);
    const { id } = await params;
    await deleteGroup(ctx, id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return scimErrorFrom(err);
  }
}
