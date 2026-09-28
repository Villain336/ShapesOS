// Marketr — Phase 13B Worker 4: content memory write helper.
//
// A ContentRecord is the index entry for everything ever generated for a
// company (spec §2): kind, title, angle, channel, and a pointer to the
// artifact (bodyRef) — the body itself stays in its store, never duplicated
// here. Performance is fed later by the analytics integrations.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export interface ContentRecordInput {
  kind: string;
  title: string;
  bodyRef?: string;
  angle?: string;
  channel?: string;
}

/** Write a ContentRecord for generated content (RLS-scoped). */
export async function recordContent(workspaceId: string, input: ContentRecordInput) {
  if (!input.kind?.trim() || !input.title?.trim()) {
    throw new Error("recordContent: kind and title are required");
  }
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.contentRecord.create({
      data: {
        workspaceId,
        kind: input.kind.trim(),
        title: input.title.trim().slice(0, 300),
        bodyRef: input.bodyRef?.slice(0, 500) ?? null,
        angle: input.angle ?? null,
        channel: input.channel ?? null,
      },
    }),
  );
}

/** Recent content history for the UI + "we already ran this angle" retrieval. */
export async function listContentRecords(
  workspaceId: string,
  opts: { kind?: string; limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.contentRecord.findMany({
      where: {
        workspaceId,
        ...(opts.kind ? { kind: opts.kind } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  );
}
