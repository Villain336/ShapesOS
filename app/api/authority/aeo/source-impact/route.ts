// Marketr — /api/authority/aeo/source-impact
// GET → source-impact ranking (citation frequency + citation efficiency +
//       co-occurrence lift), per engine, over run history. (viewer+)

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { aeoEngineSchema } from "@/app/api/authority/_schemas";
import { authorityTablesReady } from "@/lib/authority/db";
import { computeSourceImpact } from "@/lib/authority/aeo/impact";
import { AEO_ENGINES, AEO_PROXY_DISCLAIMER, type AeoEngineName } from "@/lib/authority/aeo/engines";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ impacts: [], tablesReady: false });
  }
  const engineParam = new URL(req.url).searchParams.get("engine");
  let engines: AeoEngineName[];
  if (engineParam) {
    const parsed = aeoEngineSchema.safeParse(engineParam);
    if (!parsed.success) return badRequest("Invalid engine.");
    engines = [parsed.data];
  } else {
    engines = [...AEO_ENGINES];
  }

  try {
    const perEngine: Record<string, unknown[]> = {};
    for (const engine of engines) {
      const mentions = await prisma.aeoMention.findMany({
        where: { run: { workspaceId: gate.workspaceId, engine } },
        orderBy: { promptIdx: "asc" },
      });
      const rows = computeSourceImpact(
        engine,
        mentions.map((m) => ({
          promptIdx: m.promptIdx,
          rep: m.rep,
          mentioned: m.mentioned,
          position: m.position,
          sentiment: m.sentiment as "positive" | "neutral" | "negative" | null,
          competitors: m.competitors,
          citedSources: m.citedSources,
        })),
      );
      perEngine[engine] = rows.map((r) => ({
        domain: r.domain,
        citationFrequency: r.citationFrequency,
        citationEfficiency: Math.round(r.citationEfficiency * 100) / 100,
        cooccurrenceLift: Math.round(r.cooccurrenceLift * 1000) / 1000,
        urls: r.urls.slice(0, 5),
      }));
    }
    return Response.json({ perEngine, disclaimer: AEO_PROXY_DISCLAIMER });
  } catch (err) {
    return safetyError(err);
  }
}
