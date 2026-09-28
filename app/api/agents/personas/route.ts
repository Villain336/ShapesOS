// Marketr — /api/agents/personas (Phase 13B, worker 5).
// Personas tab backing for Settings → Agents. Merges the five canonical
// Phase-12 persona seeds (lib/expert/personas) with per-workspace
// PersonaProfile rows (voice, continuityNotes, uncertaintyStyle).
// NOTE: Worker 6 owns PATCH /api/agents/personas/{agentId} — this route
// stays at collection level (GET list + PUT upsert) to avoid collisions.
//
// GET (viewer): ?workspaceId= → { personas: [{ id, name, description, surfaces, profile }] }
// PUT (editor): { workspaceId, agentId, voice?, continuityNotes?, uncertaintyStyle? }

import type { NextRequest } from "next/server";
import { agentsGuard, badRequest, readJson } from "../_lib";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { PERSONAS, type PersonaId } from "@/lib/expert/personas";

export const dynamic = "force-dynamic";

const IDS = Object.keys(PERSONAS) as PersonaId[];

function shapeProfile(row: {
  voice: unknown;
  continuityNotes: string;
  uncertaintyStyle: string;
  createdAt: Date;
  updatedAt: Date;
} | null) {
  if (!row) return null;
  const voice = (row.voice ?? {}) as Record<string, unknown>;
  return {
    register: typeof voice.register === "string" ? voice.register : "",
    manner: typeof voice.manner === "string" ? voice.manner : "",
    quirks: Array.isArray(voice.quirks) ? voice.quirks.map(String) : [],
    taboos: Array.isArray(voice.taboos) ? voice.taboos.map(String) : [],
    continuityNotes: row.continuityNotes,
    uncertaintyStyle: row.uncertaintyStyle,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const gate = await agentsGuard(req, "viewer");
  if (gate instanceof Response) return gate;
  const rows = await withWorkspaceScope(gate.workspaceId, (tx) =>
    tx.personaProfile.findMany({
      where: { workspaceId: gate.workspaceId },
      select: { agentId: true, voice: true, continuityNotes: true, uncertaintyStyle: true, createdAt: true, updatedAt: true },
    }),
  );
  const byAgent = new Map(rows.map((r) => [r.agentId, r]));
  const personas = IDS.map((id) => ({
    id,
    name: PERSONAS[id].name,
    description: PERSONAS[id].description,
    surfaces: [...PERSONAS[id].surfaces],
    profile: shapeProfile(byAgent.get(id) ?? null),
  }));
  return Response.json({ personas });
}

export async function PUT(req: NextRequest) {
  const body = await readJson(req);
  const gate = await agentsGuard(req, "editor", body);
  if (gate instanceof Response) return gate;

  const agentId = String(body.agentId ?? "");
  if (!IDS.includes(agentId as PersonaId)) {
    return badRequest(`agentId must be one of ${IDS.join(", ")}`);
  }
  const voice = (body.voice ?? {}) as Record<string, unknown>;
  const data = {
    voice: {
      register: typeof voice.register === "string" ? voice.register.slice(0, 500) : "",
      manner: typeof voice.manner === "string" ? voice.manner.slice(0, 2000) : "",
      quirks: Array.isArray(voice.quirks) ? voice.quirks.map(String).slice(0, 20) : [],
      taboos: Array.isArray(voice.taboos) ? voice.taboos.map(String).slice(0, 20) : [],
    },
    continuityNotes:
      typeof body.continuityNotes === "string" ? body.continuityNotes.slice(0, 4000) : "",
    uncertaintyStyle:
      typeof body.uncertaintyStyle === "string" ? body.uncertaintyStyle.slice(0, 2000) : "",
  };

  const row = await withWorkspaceScope(gate.workspaceId, (tx) =>
    tx.personaProfile.upsert({
      where: { workspaceId_agentId: { workspaceId: gate.workspaceId, agentId } },
      create: { workspaceId: gate.workspaceId, agentId, ...data },
      update: data,
      select: { agentId: true, voice: true, continuityNotes: true, uncertaintyStyle: true, createdAt: true, updatedAt: true },
    }),
  );
  return Response.json({ agentId, profile: shapeProfile(row) });
}
