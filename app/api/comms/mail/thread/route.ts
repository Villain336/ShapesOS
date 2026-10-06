// ShapesOS — Phase 18.2 (WS=comms): one mail thread.
//   GET   /api/comms/mail/thread?key=…[&read=1] → { thread, messages, reply }   (viewer+)
//         Bodies come from the provider now and are never stored; read=1 (a
//         person opened it) marks it read in the Mail app / the CRM inbox /
//         Zernio.
//   PATCH /api/comms/mail/thread?key=… { archived?, unread?, addTags?, removeTags?, acceptSuggested? } → { thread }
//         The Mail app's own state on your cached Gmail / Outlook threads.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { organizeThread, readMailThread } from "@/lib/comms/mail/mailbox.server";
import { normalizeTag } from "@/lib/comms/mail/types";
import { keyParam, mailGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const ctx = await mailGuard("viewer");
    const detail = await readMailThread(ctx.mail, keyParam(req.nextUrl), { markRead: req.nextUrl.searchParams.get("read") === "1" });
    return Response.json(detail);
  } catch (err) {
    return errorResponse(err, "GET /api/comms/mail/thread");
  }
}

const Tags = z.array(z.string().max(60)).max(10).optional();
const Body = z
  .object({ archived: z.boolean().optional(), unread: z.boolean().optional(), addTags: Tags, removeTags: Tags, acceptSuggested: z.boolean().optional() })
  .strict();

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await mailGuard("viewer");
    const parsed = validateBody(Body, await req.json());
    if (!parsed.ok) return parsed.error;
    const b = parsed.data;
    const clean = (xs?: string[]) => (xs ?? []).map(normalizeTag).filter((x): x is string => !!x);
    const thread = await organizeThread(ctx.mail, keyParam(req.nextUrl), { archived: b.archived, unread: b.unread, addTags: clean(b.addTags), removeTags: clean(b.removeTags), acceptSuggested: b.acceptSuggested });
    return Response.json({ thread });
  } catch (err) {
    return errorResponse(err, "PATCH /api/comms/mail/thread");
  }
}
