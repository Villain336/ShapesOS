// ShapesOS — Phase 18.2 (WS=comms): Messages live updates (Server-Sent Events).
//   GET /api/comms/messages/stream[?channel=<id>]  (Last-Event-ID / ?lastEventId= resumes)
//
// Events:
//   ready     { cursor }                       the stream is up
//   message   MessageView                      new / edited / removed messages in the open
//                                              channel (and a root whose reply count moved);
//                                              id = the change cursor, so a reconnect resumes
//   unread    { channels: { id: {unread, mentioned} } }   when the member's counts change
//   presence  { presence: [...] }              the open channel's people, every 30 s
//   gone      { reason }                       the channel can't be seen any more (then closes)
//
// Multi-instance safe: there is no in-memory fan-out — every stream polls
// Postgres (every 2 s, under RLS) from its cursor with a small overlap and
// drops versions it already sent, so a message posted on any replica
// reaches every viewer on every replica. Heartbeats, retry and the graceful
// drain come from lib/http/sse.ts; a stream rotates after 5 minutes (the
// browser reconnects and the session is checked again).

import type { NextRequest } from "next/server";
import { errorResponse, HttpError } from "@/lib/api/errors";
import { lastEventIdOf, sseResponse, sseSleep } from "@/lib/http/sse";
import { messageVersion } from "@/lib/comms/messages/model";
import { changesSince, channelMembers, presenceFor, unreadMap } from "@/lib/comms/messages/store.server";
import { idParam, messagesGuard } from "../_lib";

export const dynamic = "force-dynamic";

const POLL_MS = 2_000;
const PRESENCE_MS = 30_000;
const UNREAD_EVERY = 2; // polls
const ROTATE_MS = 5 * 60_000;

export async function GET(req: NextRequest) {
  try {
    const ctx = await messagesGuard();
    const raw = req.nextUrl.searchParams.get("channel");
    const channelId = raw ? idParam(raw) : null;
    // Fail fast (404) when the channel can't be seen, before opening the stream.
    const people = channelId ? (await channelMembers(ctx, channelId)).filter((m) => m.userId).map((m) => m.userId!).slice(0, 50) : [];
    const resume = lastEventIdOf(req);
    const resumeAt = resume ? new Date(resume) : null;
    let cursor = resumeAt && !Number.isNaN(resumeAt.getTime()) ? resumeAt : new Date();
    return sseResponse(
      async (ch) => {
        const started = Date.now();
        const sent = new Set<string>();
        let lastUnread = "";
        let lastPresence = 0;
        let polls = 0;
        ch.send("ready", { cursor: cursor.toISOString() });
        while (!ch.closed && !ch.draining) {
          try {
            if (channelId) {
              const out = await changesSince(ctx, channelId, cursor);
              for (const m of out.messages) {
                const v = messageVersion(m);
                if (sent.has(v)) continue;
                sent.add(v);
                ch.send("message", m, { id: out.cursor.toISOString() });
              }
              cursor = out.cursor;
              if (sent.size > 5_000) sent.clear();
              if (Date.now() - lastPresence >= PRESENCE_MS && people.length) {
                lastPresence = Date.now();
                ch.send("presence", { presence: await presenceFor(ctx, people) });
              }
            }
            if (polls % UNREAD_EVERY === 0) {
              const unread = await unreadMap(ctx);
              const key = JSON.stringify(unread);
              if (key !== lastUnread) {
                lastUnread = key;
                ch.send("unread", { channels: unread });
              }
            }
          } catch (err) {
            if (err instanceof HttpError && err.status === 404) {
              ch.send("gone", { reason: "You can't see this channel any more." });
              return;
            }
            // A transient database error: keep the stream, try again next poll.
          }
          polls++;
          if (Date.now() - started > ROTATE_MS) {
            ch.reconnect({ reason: "rotate" });
            return;
          }
          await sseSleep(ch, POLL_MS);
        }
      },
      { lastEventId: resume },
    );
  } catch (err) {
    return errorResponse(err, "GET /api/comms/messages/stream");
  }
}
