// ShapesOS — Spotlight sources: Phase 18.2 (WS=comms) Mail.
//
// "mail" searches the member's OWN Gmail / Outlook threads cached by the Mail
// app (mail_thread_cache: subject, people, the inbox agent's summary and
// labels — headers only, never bodies). PERSONAL like assistant chats: only
// the owner of the mailbox ever gets their threads, whatever the role.
// Lead conversations stay the "inbox_message" kind; contacts are "contact".

import { Prisma } from "@prisma/client";
import { tableSearch } from "../sql";
import type { SearchSource } from "../types";

export const mail: SearchSource = {
  kind: "mail",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) => {
    if (!ctx.userId) return Promise.resolve([]);
    return tableSearch(tx, ctx, {
      from: "mail_thread_cache t",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId} AND t.owner_user_id = ${ctx.userId}`,
      select:
        "t.id, t.subject AS title, concat_ws(' · ', coalesce(t.from_name, t.from_email), t.source) AS sub, t.source || ':' || t.connection_id || ':' || t.external_id AS extra, t.message_count AS n, t.last_message_at AS updated_at",
      nameMatch: "(t.subject || ' ' || coalesce(t.from_name, '') || ' ' || coalesce(t.from_email, '') || ' ' || array_to_string(t.participants, ' ') || ' ' || array_to_string(t.tags, ' ') || ' ' || coalesce(t.summary, ''))",
      nameSim: "t.subject",
      fts: null,
    });
  },
  hit: (r) => ({
    id: r.id,
    title: r.title || "(no subject)",
    subtitle: r.sub || null,
    href: `/dashboard/mail?thread=${encodeURIComponent(r.extra ?? "")}`,
  }),
  actions: [{ id: "draft_mail_reply", tool: "mail_draft_reply", instruction: "Draft a reply to this mail thread in my Mail drafts (nothing is sent; pass the thread key from the link)." }],
};
