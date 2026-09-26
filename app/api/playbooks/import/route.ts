// Marketr — /api/playbooks/import (Phase 9 M5).
// POST (editor): { envelope } → explicit import of an exported playbook.
// Imported playbooks always start at version 1 / status draft and must
// travel the lifecycle (EVAL→…) before use.

import { playbooksGuard, badRequest, readJson, storeError } from "../_lib";
import { importPlaybook } from "@/lib/playbooks/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await playbooksGuard("editor");
  if (gate instanceof Response) return gate;
  const body = await readJson(req);
  if (!body.envelope || typeof body.envelope !== "object") {
    return badRequest("envelope is required (a marketr.playbook/v1 export).");
  }
  try {
    const result = await importPlaybook(
      gate.workspaceId,
      body.envelope as Record<string, unknown>,
      gate.userId,
    );
    return Response.json(result, { status: 201 });
  } catch (err) {
    return storeError(err);
  }
}
