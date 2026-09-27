// Marketr — Cloudinary signed-upload endpoint (Phase 11 "Canvas",
// integration #7).
// POST /api/studio/cloudinary/sign — { filename, mimeType, sizeBytes } →
// the client-safe signed-upload envelope: { uploadUrl, cloudName, apiKey,
// timestamp, signature, folder, publicId, deliveryUrl, thumbUrl }. The
// browser then POSTs the file straight to Cloudinary; the API secret is
// used server-side to mint the signature and NEVER leaves the server.
//
// File type (images only) and size are validated server-side on the sign
// request. A zero-credit passthrough meter event is recorded per signature
// so each tenant's upload count is visible in the usage ledger — quota
// awareness only: Cloudinary bills the user's own account (free tier 25
// credits/month), so Marketr never charges ledger credits or blocks here.

import { guardWorkspace, httpErrorResponse, readJson } from "../../designs/_lib";
import {
  NOT_CONFIGURED_MESSAGE,
  SignParamError,
  buildSignPayload,
  getCloudinaryConfig,
  parseSignRequest,
} from "@/lib/design/cloudinary";
import { meter } from "@/lib/metering/service";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });

    let signReq;
    try {
      signReq = parseSignRequest(await readJson(req));
    } catch (e) {
      const message = e instanceof SignParamError ? e.message : "Invalid sign request.";
      return Response.json({ error: message, code: "cloudinary_bad_request" }, { status: 400 });
    }

    const config = getCloudinaryConfig();
    if (!config) {
      return Response.json(
        { error: NOT_CONFIGURED_MESSAGE, code: "cloudinary_not_configured" },
        { status: 400 },
      );
    }

    const payload = buildSignPayload(config, workspace.id);

    // Zero-credit passthrough: per-tenant upload counts for quota awareness.
    // Always passes the cap (zero cost); unknown_action would be a programmer
    // error, surfaced as a 500 rather than a silent unmetered upload.
    const m = await meter({
      workspaceId: workspace.id,
      actorId: null,
      action: "cloudinary_upload",
      idempotencyKey: `cloudinaryupload:${payload.publicId}`,
      evidenceRef: `cloudinary:${payload.publicId}:${signReq.sizeBytes}b`,
    });
    if (!m.ok) {
      throw new Error(`metering failed for cloudinary_upload (${m.reason})`);
    }

    return Response.json(payload);
  } catch (e) {
    return httpErrorResponse(e);
  }
}
