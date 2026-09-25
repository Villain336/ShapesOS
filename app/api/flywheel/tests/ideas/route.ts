// Marketr — GET /api/flywheel/tests/ideas (PIE/ICE queue) · POST (new idea)

import { flywheelGuard, badRequest, flywheelError, readJson } from "@/app/api/flywheel/_lib";
import { resolveExperimentStore } from "@/lib/flywheel/testlab/store";
import { createIdeaSchema } from "../_schemas";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await flywheelGuard("viewer");
  if (gate instanceof Response) return gate;
  try {
    const { store, persistent } = await resolveExperimentStore();
    const ideas = await store.listIdeas(gate.workspaceId);
    return Response.json({ ideas, persistent });
  } catch (err) {
    return flywheelError(err);
  }
}

export async function POST(req: Request) {
  const gate = await flywheelGuard("editor");
  if (gate instanceof Response) return gate;
  try {
    const body = await readJson(req);
    const parsed = createIdeaSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid idea payload.", parsed.error.issues);
    const { store, persistent } = await resolveExperimentStore();
    const idea = await store.createIdea(gate.workspaceId, parsed.data);
    return Response.json({ idea, persistent }, { status: 201 });
  } catch (err) {
    return flywheelError(err);
  }
}
