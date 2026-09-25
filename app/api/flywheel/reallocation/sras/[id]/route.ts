// Marketr — GET /api/flywheel/reallocation/sras/:id

import type { NextRequest } from "next/server";
import {
  flywheelGuard, safetyError,
  getStore, reallocationTablesReady, tablesNotReady,
} from "../../_lib";
import { sraConsequences, sraStatusAt } from "@/lib/flywheel/reallocation/sra";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await flywheelGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await reallocationTablesReady())) return tablesNotReady();
  const { id } = await ctx.params;
  try {
    const store = getStore();
    const sra = await store.getSra(id, gate.workspaceId);
    if (!sra) return Response.json({ error: "SRA not found in workspace" }, { status: 404 });
    return Response.json({
      sra: { ...sra, computedStatus: sraStatusAt(sra, new Date()) },
      consequences: sraConsequences(sra),
    });
  } catch (err) {
    return safetyError(err);
  }
}
