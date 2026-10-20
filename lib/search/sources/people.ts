// ShapesOS — Spotlight sources: the Network (people in the tenant's graph)
// and the person's own assistant chats.

import { Prisma } from "@prisma/client";
import { tableSearch } from "../sql";
import type { SearchSource } from "../types";

export const person: SearchSource = {
  kind: "person",
  minRole: "viewer",
  modes: ["name", "text"],
  query: (tx, ctx) =>
    tableSearch(tx, ctx, {
      from: "connector_agent_persons t",
      scope: Prisma.sql`t.workspace_id = ${ctx.workspaceId}`,
      select: "t.id, t.name AS title, array_to_string(t.roles, ', ') AS sub, array_to_string(t.handles, ' ') AS extra, NULL::int AS n, t.updated_at AS updated_at",
      nameMatch: "(t.name || ' ' || array_to_string(t.handles, ' '))",
      nameSim: "t.name",
      fts: { table: "connector_agent_persons", alias: "t" },
    }),
  hit: (r) => ({
    id: r.id,
    title: r.title ?? "Person",
    subtitle: [r.sub, r.extra].filter(Boolean).join(" · ") || "Network",
    href: `/dashboard/connector?person=${encodeURIComponent(r.id)}`,
  }),
};

/**
 * Assistant chat messages. PERSONAL: a thread belongs to the person who
 * started it (ai_chat_threads.user_id), so only their own messages are ever
 * returned — never a teammate's, whatever the role. Threads live in a
 * project of this workspace (projects.workspace_id), which scopes the tenant.
 */
export const chatMessage: SearchSource = {
  kind: "chat_message",
  minRole: "viewer",
  modes: ["text"],
  query: (tx, ctx) => {
    if (!ctx.userId) return Promise.resolve([]);
    return tableSearch(tx, ctx, {
      from: `ai_chat_messages t
        JOIN ai_chat_threads th ON th.id = t.thread_id
        JOIN projects p ON p.id = th.project_id`,
      scope: Prisma.sql`p.workspace_id = ${ctx.workspaceId} AND th.user_id = ${ctx.userId} AND t.role IN ('user', 'assistant')`,
      select:
        "t.id, th.title AS title, t.role AS sub, left(regexp_replace(t.content, '[[:space:]]+', ' ', 'g'), 140) AS extra, NULL::int AS n, t.created_at AS updated_at, th.id AS thread_id, th.project_id AS project_id",
      nameMatch: null,
      fts: { table: "ai_chat_messages", alias: "t" },
      snippetSource: "t.content",
      passthrough: ["thread_id", "project_id"],
    });
  },
  hit: (r) => {
    const extra = r as unknown as { thread_id?: string; project_id?: string };
    return {
      id: r.id,
      title: r.title || "Chat",
      subtitle: [r.sub === "user" ? "You" : "Assistant", r.extra].filter(Boolean).join(" · ") || null,
      href: `/dashboard/assistant?project=${encodeURIComponent(extra.project_id ?? "")}&thread=${encodeURIComponent(extra.thread_id ?? "")}`,
      ref: { threadId: extra.thread_id },
    };
  },
};
