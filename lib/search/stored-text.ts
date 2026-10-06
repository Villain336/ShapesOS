// ShapesOS — Phase 18.1: read the indexed text of a file or Office doc.
// Kept apart from lib/search/text-index.ts so the agent's read tool
// (lib/search/tool.ts, reachable from the chat tool registry) does not
// bundle the extractors and the embedder.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export async function storedText(
  workspaceId: string,
  key: { fileId?: string; univerDocId?: string },
  maxChars = 6_000,
): Promise<{ status: string; text: string | null; truncated: boolean } | null> {
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.searchText.findFirst({
      where: { workspaceId, ...(key.fileId ? { fileId: key.fileId } : { univerDocId: key.univerDocId }) },
      select: { status: true, content: true, truncated: true },
    }),
  );
  if (!row) return null;
  const text = row.content ? row.content.slice(0, maxChars) : null;
  return { status: row.status, text, truncated: row.truncated || (row.content?.length ?? 0) > maxChars };
}
