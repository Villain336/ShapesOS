// ShapesOS — Phase 11 (conncore): inbound Slack Events API.
// POST /api/hooks/slack/events
//
// PUBLIC BY DESIGN (registered in scripts/verify-m11-security.mjs): Slack has
// no session. The capability is SLACK_SIGNING_SECRET — every request must
// carry X-Slack-Signature = "v0=" + HMAC-SHA256(secret, "v0:" + timestamp +
// ":" + raw body) with X-Slack-Request-Timestamp inside a 5-minute window,
// checked in constant time over the exact bytes before the body is parsed.
// Unset secret → 503 (the receiver is off). Every event id is stored once
// (primary key): a Slack retry is acknowledged as a duplicate and does
// nothing. Nothing touches the database before the signature verifies; the
// body is capped at 1 MiB; per-IP rate limit in proxy.ts.
//
// What it acts on (lib/slack/events.ts): app_mention and direct messages to
// the bot, from people (bots ignored), in a Slack team that installed the
// app (team_id → workspace via a SELECT-only policy on slack_installations).
// It only queues ONE `slack_mention` agent job; agent writes still wait for a
// person's OK in ShapesOS. Responses carry counts and reasons only.

import { BodyTooLargeError, readCappedText } from "@/lib/workflow/webhook";
import { errorResponse } from "@/lib/api/errors";
import {
  SLACK_EVENTS_MAX_BYTES,
  SLACK_SIGNATURE_HEADER,
  SLACK_TIMESTAMP_HEADER,
  receiveSlackEvent,
} from "@/lib/slack/events";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const signature = req.headers.get(SLACK_SIGNATURE_HEADER);
  if (!signature) return Response.json({ error: "Missing X-Slack-Signature." }, { status: 401 });

  let rawBody: string;
  try {
    rawBody = await readCappedText(req, SLACK_EVENTS_MAX_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return Response.json({ error: "Body too large." }, { status: 413 });
    return Response.json({ error: "Could not read the request body." }, { status: 400 });
  }

  try {
    const result = await receiveSlackEvent({
      rawBody,
      signature,
      timestamp: req.headers.get(SLACK_TIMESTAMP_HEADER),
    });
    return Response.json(result.body, { status: result.status });
  } catch (err) {
    return errorResponse(err, "POST /api/hooks/slack/events", req);
  }
}
