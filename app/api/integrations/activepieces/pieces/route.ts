// Marketr — GET /api/integrations/activepieces/pieces (Phase 12, Worker 3).
// The curated marketing piece catalog, read live from the installed
// @activepieces/piece-* npm packages. Needs no engine connection — it
// describes what Marketr can propose, not what the engine has.

import { curatedPieces, AUTOMATION_RECIPES } from "@/lib/integrations/activepieces";
import { integrationsGuard, engineError } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await integrationsGuard("viewer");
  if (gate instanceof Response) return gate;
  try {
    const pieces = await curatedPieces();
    return Response.json({ pieces, recipes: AUTOMATION_RECIPES });
  } catch (e) {
    return engineError(e);
  }
}
