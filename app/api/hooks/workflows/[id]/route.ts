// ShapesOS — inbound webhook for the workflow canvas "webhook" trigger
// (Phase 6 runtime).
// POST /api/hooks/workflows/[id]
//
// PUBLIC BY DESIGN (registered in scripts/verify-m11-security.mjs): there is
// no session. The capability is the workflow's signing secret — the request
// must carry ShapesOS-Signature: t=<unix seconds>,v1=<HMAC-SHA256 hex of
// "<t>.<raw body>"> keyed with that secret (the outbound webhook scheme,
// lib/webhooks/signing.ts), within a 5-minute window, and never seen before
// (replayed signed requests 409). Unknown workflow / no secret / no webhook
// trigger all 404 alike. Rate limited per workflow (and per IP by proxy.ts)
// before any database work; the body is capped at 64 KiB and must be JSON.
//
// A verified call starts a WorkflowRun through the engine's normal path
// (startWorkflowRun: kill switch → 423, 5-minute dedupe → 200 with the
// existing run) with the JSON body as the trigger payload. Responses carry
// only the run id and status, never workflow data.

import { checkRateLimit, tooManyRequests } from "@/lib/api/rate-limit";
import {
  BodyTooLargeError,
  readCappedText,
  receiveWorkflowWebhook,
  signatureHeaderLooksValid,
  SIGNATURE_HEADER,
} from "@/lib/workflow/webhook";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID_RE.test(id)) return Response.json({ error: "Not found" }, { status: 404 });

  // Per-workflow budget at the AI tier (each run can spend): 20/min.
  const limit = checkRateLimit(`wfhook:${id}`, "ai");
  if (!limit.allowed) return tooManyRequests(limit.retryAfterMs);

  const signature = req.headers.get(SIGNATURE_HEADER);
  if (!signatureHeaderLooksValid(signature)) {
    return Response.json({ error: `Missing or invalid ${SIGNATURE_HEADER} header.` }, { status: 401 });
  }

  let rawBody: string;
  try {
    rawBody = await readCappedText(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return Response.json({ error: err.message }, { status: 413 });
    return Response.json({ error: "Could not read the request body." }, { status: 400 });
  }

  try {
    const result = await receiveWorkflowWebhook({ workflowId: id, rawBody, signature });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(
      { runId: result.runId, status: result.runStatus, deduped: result.deduped },
      { status: result.status },
    );
  } catch (err) {
    return errorResponse(err, "POST /api/hooks/workflows/[id]", req);
  }
}
