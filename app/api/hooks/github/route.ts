// ShapesOS — Phase 9 (repos): inbound GitHub webhook for agent pull requests.
// POST /api/hooks/github
//
// PUBLIC BY DESIGN (registered in scripts/verify-m11-security.mjs): GitHub
// has no session. The capability is GITHUB_WEBHOOK_SECRET — the request must
// carry X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(secret, raw body),
// checked in constant time over the exact bytes before the body is parsed.
// Unset secret → 503 (the receiver is off). Every delivery id is stored once
// (primary key): a redelivery is acknowledged as a duplicate and does nothing.
// Rate limited per IP by proxy.ts; nothing touches the database before the
// signature verifies (a cheap HMAC), and the body is capped at 1 MiB. No
// extra global bucket here: GitHub does not retry a 429, and one review with
// many line comments arrives as a burst of deliveries.
//
// What it acts on (lib/ship/github-events.ts): pull_request_review,
// pull_request_review_comment, issue_comment, check_suite / check_run and
// pull_request state changes on branches named shapes/<runId>, from people
// who are repository collaborators (bots ignored). Feedback queues ONE
// `pr_feedback` agent job that continues the run's chat thread on the same
// branch; pushing again still waits for a person's OK (git_push_branch is a
// Tier-2 publish action). Responses carry counts and reasons only.

import { BodyTooLargeError, readCappedText } from "@/lib/workflow/webhook";
import { errorResponse } from "@/lib/api/errors";
import { GITHUB_WEBHOOK_MAX_BYTES, receiveGitHubWebhook } from "@/lib/ship/github-webhook";
import { GITHUB_DELIVERY_HEADER, GITHUB_EVENT_HEADER, GITHUB_SIGNATURE_HEADER } from "@/lib/ship/github-events";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const signature = req.headers.get(GITHUB_SIGNATURE_HEADER);
  if (!signature) return Response.json({ error: "Missing X-Hub-Signature-256." }, { status: 401 });

  let rawBody: string;
  try {
    rawBody = await readCappedText(req, GITHUB_WEBHOOK_MAX_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return Response.json({ error: "Body too large." }, { status: 413 });
    return Response.json({ error: "Could not read the request body." }, { status: 400 });
  }

  try {
    const result = await receiveGitHubWebhook({
      event: req.headers.get(GITHUB_EVENT_HEADER),
      deliveryId: req.headers.get(GITHUB_DELIVERY_HEADER),
      signature,
      rawBody,
    });
    return Response.json(result.body, { status: result.status });
  } catch (err) {
    return errorResponse(err, "POST /api/hooks/github", req);
  }
}
