// Marketr — R6 enrichment run API.
// POST /api/enrichment/run (editor) { listId, providers?, estimateAck? } →
// waterfall over unenriched prospects (status "new"). Runs >100 prospects
// require estimateAck: true (the UI shows the estimate banner first).

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { guardWorkspace, httpErrorResponse, readJson, HttpError } from "@/lib/enrichment/guard";
import { runWaterfall, checkRunBudget } from "@/lib/enrichment/waterfall";
import { getEnrichmentProviders } from "@/lib/enrichment/provider";

const Schema = z.object({
  listId: z.string().min(1),
  providers: z.array(z.enum(["fake", "apollo", "hunter"])).min(1).max(5).optional(),
  estimateAck: z.boolean().default(false),
  /** Also retry prospects that previously failed. Default false. */
  includeFailed: z.boolean().default(false),
});

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const parsed = Schema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    const { listId, estimateAck, includeFailed } = parsed.data;
    const list = await prisma.prospectList.findFirst({
      where: { id: listId, workspaceId: workspace.id },
    });
    if (!list) throw new HttpError(404, "List not found");

    const statuses = includeFailed ? ["new", "failed"] : ["new"];
    const targets = await prisma.prospect.findMany({
      where: { workspaceId: workspace.id, listId, status: { in: statuses } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });

    const budget = checkRunBudget(workspace.id, targets.length, parsed.data.providers, estimateAck);
    if (!budget.ok) {
      return Response.json(
        { error: budget.blockedReason, estimate: budget.estimate },
        { status: 400 },
      );
    }

    // Resolve the provider chain once (env misconfiguration fails the run
    // loudly before any prospect is touched).
    const providers = parsed.data.providers
      ? getEnrichmentProviders({ ...process.env, ENRICHMENT_PROVIDERS: parsed.data.providers.join(",") })
      : getEnrichmentProviders();

    if (list.status === "building" || list.status === "draft") {
      await prisma.prospectList.update({ where: { id: listId }, data: { status: "building" } });
    }

    let enriched = 0;
    let failed = 0;
    let hits = 0;
    for (const t of targets) {
      try {
        const result = await runWaterfall(workspace.id, t.id, providers, user.id);
        if (result.status === "enriched") {
          enriched++;
          if (result.hitProvider) hits++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }

    const remaining = await prisma.prospect.count({
      where: { workspaceId: workspace.id, listId, status: "new" },
    });
    if (remaining === 0) {
      await prisma.prospectList.update({ where: { id: listId }, data: { status: "ready" } });
    }

    return Response.json({
      listId,
      ran: targets.length,
      enriched,
      failed,
      hits,
      estimate: budget.estimate,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
