// Marketr — content engine: editor save (spec §5 flow 3, step 3).
// POST /api/content/save  { contentId, bodyMarkdown }
//   → { contentItem, score }
// Persists the edited draft, computes the explainable SEO score server-side
// (the same scoreContent() the editor shows live), and stores it as
// seoScore. Saving moves the item to "editing" (a published item stays
// published — re-saving doesn't un-publish it).

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { scoreContent } from "@/lib/content/seoScore";
import type { ContentBrief } from "@/lib/content/brief";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { contentId?: string; bodyMarkdown?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const contentItem = await prisma.contentItem.findFirst({
    where: {
      id: body.contentId,
      project: { workspace: accessibleWorkspaceWhere(user.id) },
    },
    include: {
      keyword: true,
      project: { include: { keywords: { select: { phrase: true } } } },
    },
  });
  if (!contentItem) {
    return Response.json({ error: "Content item not found" }, { status: 404 });
  }
  if (!(await requireProjectRole(user.id, contentItem.projectId, "editor"))) return forbidden();

  const bodyMarkdown = String(body.bodyMarkdown ?? "");
  const brief = contentItem.outlineJson as ContentBrief | null;
  const keyword = contentItem.keyword?.phrase ?? brief?.keyword ?? "";

  const otherKeywords = contentItem.project.keywords
    .map((k) => k.phrase)
    .filter((p) => p !== keyword);

  const result = scoreContent({
    bodyMarkdown,
    keyword,
    targetWordCount: brief?.targetWordCount ?? 1500,
    h2s: brief?.h2s ?? [],
    paa: brief?.paa ?? [],
    otherKeywords,
  });

  const nextStatus =
    contentItem.status === "published" ? "published" : "editing";

  const updated = await prisma.contentItem.update({
    where: { id: contentItem.id },
    data: {
      bodyMarkdown,
      seoScore: result.score,
      status: nextStatus,
    },
  });

  return Response.json({
    contentItem: { id: updated.id, status: updated.status },
    score: result,
  });
}
