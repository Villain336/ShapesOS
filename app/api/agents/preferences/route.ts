// Marketr — /api/agents/preferences (Phase 13B, worker 5).
// The "pref API": reads/writes the workspace preference profile, which is
// a convention over memory_facts (predicate "pref:<key>"), NOT a table.
// All access goes through lib/substrate/memory/preferences.ts — never raw
// memoryFact queries (DATA-MODEL rule 3).
//
// GET (viewer):  ?workspaceId= → { preferences: [...] }
// POST (editor): { workspaceId, key, value, pinned?, confidence?, origin? }
//   The learning-pause toggle is key "learning_paused" with a boolean value.

import type { NextRequest } from "next/server";
import { agentsGuard, badRequest, readJson } from "../_lib";
import {
  listPreferences,
  setPreference,
  PREF_KEYS,
} from "@/lib/substrate/memory/preferences";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await agentsGuard(req, "viewer");
  if (gate instanceof Response) return gate;
  const preferences = await listPreferences(gate.workspaceId);
  return Response.json({ preferences });
}

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const gate = await agentsGuard(req, "editor", body);
  if (gate instanceof Response) return gate;

  const key = String(body.key ?? "").trim();
  if (!key || !/^[a-z0-9_]{1,64}$/.test(key)) {
    return badRequest("key is required (lowercase letters, digits, underscores)");
  }
  if (!("value" in body)) return badRequest("value is required");

  const pinned = body.pinned === true;
  const confidence =
    typeof body.confidence === "number" && body.confidence >= 0 && body.confidence <= 1
      ? body.confidence
      : undefined;
  const origin =
    body.origin === "user_told" || body.origin === "agent_inferred" || body.origin === "imported"
      ? body.origin
      : "user_told";

  // The pause toggle is user-explicit; everything else set from the UI is too.
  if (key === PREF_KEYS.learningPaused && typeof body.value !== "boolean") {
    return badRequest("learning_paused must be a boolean");
  }

  const id = await setPreference(gate.workspaceId, key, body.value, {
    pinned,
    confidence,
    origin,
  });
  return Response.json({ id, key, pinned, origin });
}
