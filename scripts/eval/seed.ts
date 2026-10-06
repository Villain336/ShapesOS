// ShapesOS — Phase 17 evaluation: the seeded workspace every task runs
// against (one fresh workspace per configuration, so usage and caches are
// measured per configuration). The data the fixtures' checks expect:
// 3 keywords (espresso machines at 3, coffee grinders 6 → 11, …), two
// competitors, two content items, two open issues, no workflows/skills/ops data.

import { prisma } from "@/lib/prisma";

export interface EvalWorkspace {
  workspaceId: string;
  projectId: string;
  userId: string;
}

export async function seedEvalWorkspace(tag: string): Promise<EvalWorkspace> {
  const workspaceId = `eval-${tag}`;
  const userId = `eval-${tag}-owner`;
  await prisma.workspace.create({ data: { id: workspaceId, name: `Eval ${tag}`, ownerUserId: userId } });
  const project = await prisma.project.create({ data: { workspaceId, domain: "brewbase.example", locale: "en-US" } });
  const day = 86_400_000;
  const kw = async (phrase: string, volume: number, positions: [number | null, number | null]) => {
    const k = await prisma.keyword.create({ data: { projectId: project.id, phrase, volume, difficulty: 40, tracked: true, list: "core" } });
    const [previous, latest] = positions;
    if (previous !== null) await prisma.ranking.create({ data: { keywordId: k.id, position: previous, checkedAt: new Date(Date.now() - 7 * day), url: `https://brewbase.example/${phrase.replace(/\s+/g, "-")}` } });
    if (latest !== null) await prisma.ranking.create({ data: { keywordId: k.id, position: latest, checkedAt: new Date(Date.now() - day), url: `https://brewbase.example/${phrase.replace(/\s+/g, "-")}` } });
    return k;
  };
  const espresso = await kw("espresso machines", 2400, [4, 3]);
  await kw("coffee grinders", 1300, [6, 11]);
  await kw("cold brew ratio", 480, [null, 18]);
  await prisma.competitor.createMany({ data: [{ projectId: project.id, domain: "beanhub.example" }, { projectId: project.id, domain: "brewcraft.example" }] });
  await prisma.contentItem.createMany({
    data: [
      { projectId: project.id, keywordId: espresso.id, status: "published", seoScore: 82, publishedUrl: "https://brewbase.example/espresso-machines" },
      { projectId: project.id, status: "draft", seoScore: 55 },
    ],
  });
  await prisma.issue.createMany({
    data: [
      { projectId: project.id, type: "http_404", severity: "error", url: "https://brewbase.example/old-page" },
      { projectId: project.id, type: "missing_title", severity: "warning", url: "https://brewbase.example/blog" },
    ],
  });
  return { workspaceId, projectId: project.id, userId };
}
