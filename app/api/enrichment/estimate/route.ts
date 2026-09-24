// Marketr — R6 enrichment cost estimate API.
// POST /api/enrichment/estimate { listId, providers? } → cost preview for the
// unenriched prospects in the list. No provider calls are made.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { guardWorkspace, httpErrorResponse, readJson, HttpError } from "@/lib/enrichment/guard";
import { estimateRunCost, ENRICHMENT_PRICING_USD } from "@/lib/enrichment/waterfall";
import { getEnrichmentProviders } from "@/lib/enrichment/provider";

const Schema = z.object({
  listId: z.string().min(1),
  providers: z.array(z.enum(["fake", "apollo", "hunter"])).min(1).max(5).optional(),
});

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const parsed = Schema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    const list = await prisma.prospectList.findFirst({
      where: { id: parsed.data.listId, workspaceId: workspace.id },
    });
    if (!list) throw new HttpError(404, "List not found");

    const unenriched = await prisma.prospect.count({
      where: { workspaceId: workspace.id, listId: list.id, status: "new" },
    });

    // Validate provider names resolve (catches typos before the run).
    let chain: string[];
    if (parsed.data.providers) {
      chain = parsed.data.providers;
      getEnrichmentProviders({ ...process.env, ENRICHMENT_PROVIDERS: chain.join(",") });
    } else {
      chain = getEnrichmentProviders().map((p) => p.name);
    }

    const estimate = estimateRunCost(workspace.id, unenriched, chain);
    return Response.json({
      listId: list.id,
      unenriched,
      estimate,
      pricingNote:
        "Worst-case estimate: every prospect is attempted on every provider. " +
        "Fake lookups are free. Real-provider USD figures are planning estimates — " +
        `see ENRICHMENT_PRICING_USD in lib/enrichment/waterfall.ts (${Object.entries(ENRICHMENT_PRICING_USD).map(([k, v]) => `${k} $${v}`).join(", ")} per lookup).`,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
