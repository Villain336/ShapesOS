// ShapesOS — SCIM 2.0 User resource (RFC 7644 §3.4.1, §3.5, §3.6). Phase 4a.
//
// GET    → the User
// PUT    → replace (attributes left out are cleared; active defaults true)
// PATCH  → PatchOp; `active=false` deprovisions the membership at once
// DELETE → removes the membership (204)
// Owners can't be changed or removed over SCIM (403 mutability).
// Auth: per-workspace SCIM bearer token (requireScimAuth); an id from another
// workspace is 404.

import { requireScimAuth } from "@/lib/scim/auth";
import { readScimBody, scimErrorFrom, scimJson } from "@/lib/scim/http";
import { deleteUser, getUser, patchUser, replaceUser } from "@/lib/scim/service";
import { scimBaseUrl } from "@/lib/scim/base-url";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  try {
    const ctx = await requireScimAuth(req);
    const { id } = await params;
    return scimJson(await getUser(ctx, scimBaseUrl(req), id));
  } catch (err) {
    return scimErrorFrom(err);
  }
}

export async function PUT(req: Request, { params }: Params) {
  try {
    const ctx = await requireScimAuth(req);
    const { id } = await params;
    return scimJson(await replaceUser(ctx, scimBaseUrl(req), id, await readScimBody(req)));
  } catch (err) {
    return scimErrorFrom(err);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const ctx = await requireScimAuth(req);
    const { id } = await params;
    return scimJson(await patchUser(ctx, scimBaseUrl(req), id, await readScimBody(req)));
  } catch (err) {
    return scimErrorFrom(err);
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const ctx = await requireScimAuth(req);
    const { id } = await params;
    await deleteUser(ctx, id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return scimErrorFrom(err);
  }
}
