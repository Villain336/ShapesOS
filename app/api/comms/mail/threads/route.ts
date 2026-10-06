// ShapesOS — Phase 18.2 (WS=comms): the Mail app's unified inbox.
//   GET /api/comms/mail/threads[?folder=inbox|unread|archived&q=&source=gmail|outlook|crm|social&tag=&refresh=1]
//     → { threads, sources }   (viewer+)
// Your own Gmail / Outlook (headers cached, refreshed at most once a minute
// unless refresh=1), the CRM inbox and the workspace's social DMs
// (lib/comms/mail/mailbox.server.ts). In production with no connector the
// sources say so — never fake mail.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { listMailbox } from "@/lib/comms/mail/mailbox.server";
import { isMailSource, MAIL_FOLDERS, normalizeTag, type MailFolder } from "@/lib/comms/mail/types";
import { mailGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const ctx = await mailGuard("viewer");
    const p = req.nextUrl.searchParams;
    const folder = (MAIL_FOLDERS as readonly string[]).includes(p.get("folder") ?? "") ? (p.get("folder") as MailFolder) : "inbox";
    const source = p.get("source");
    const listing = await listMailbox(ctx.mail, {
      folder,
      q: (p.get("q") ?? "").slice(0, 200) || null,
      source: isMailSource(source) ? source : null,
      tag: normalizeTag(p.get("tag")),
      refresh: p.get("refresh") === "1",
    });
    return Response.json(listing);
  } catch (err) {
    return errorResponse(err, "GET /api/comms/mail/threads");
  }
}
