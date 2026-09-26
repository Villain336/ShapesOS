// Marketr — /api/playbooks (Phase 9 M5).
// GET: list playbooks (id, name, source badge, production version, status, outcome lift)
// POST (editor): create a playbook.

import { playbooksGuard, badRequest, readJson, storeError } from "./_lib";
import { listPlaybooks, createPlaybook, type PlaybookSource } from "@/lib/playbooks/store";

export const dynamic = "force-dynamic";

const SOURCES: PlaybookSource[] = ["learned", "community", "seed"];

export async function GET() {
  const gate = await playbooksGuard("viewer");
  if (gate instanceof Response) return gate;
  try {
    const playbooks = await listPlaybooks(gate.workspaceId);
    return Response.json({ playbooks });
  } catch (err) {
    return storeError(err);
  }
}

export async function POST(req: Request) {
  const gate = await playbooksGuard("editor");
  if (gate instanceof Response) return gate;
  const body = await readJson(req);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const source = body.source as PlaybookSource | undefined;
  if (!name) return badRequest("name is required.");
  if (!source || !SOURCES.includes(source)) {
    return badRequest(`source is required and must be one of: ${SOURCES.join(", ")}.`);
  }
  const description = typeof body.description === "string" ? body.description : null;
  try {
    const created = await createPlaybook(
      gate.workspaceId,
      { name, source, description },
      gate.userId,
    );
    return Response.json(created, { status: 201 });
  } catch (err) {
    return storeError(err);
  }
}
