// Marketr — Phase 13B persona voice editor.
// GET   /api/agents/personas/{agentId} → default + override + effective voice
// PATCH /api/agents/personas/{agentId} → upsert user override in PersonaProfile
//
// PersonaProfile rows are USER OVERRIDES ONLY — the built-in defaults
// live in lib/expert/personas/voices.ts. A PATCH with a partial voice
// stores just the supplied fields; absent fields keep their defaults at
// prompt-assembly time (see resolvePersonaVoice()).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  PERSONA_IDS,
  DEFAULT_PERSONA_VOICES,
  resolvePersonaVoice,
  getPersonaProfileOverride,
  type PersonaVoice,
  type PersonaId,
} from "@/lib/expert/personas";

type RouteParams = { params: Promise<{ agentId: string }> };

function isPersonaId(id: string): id is PersonaId {
  return (PERSONA_IDS as readonly string[]).includes(id);
}

async function requireEditor() {
  const user = await requireUser();
  if (!user) return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    return { error: forbidden() };
  }
  return { user, workspace };
}

// --- validation -----------------------------------------------------------

const VOICE_KEYS = new Set([
  "register",
  "manner",
  "quirks",
  "taboos",
  "uncertaintyStyle",
  "proactivityTriggers",
]);

function validateVoice(value: unknown): { ok: true; voice: Partial<PersonaVoice> } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "voice must be an object" };
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!VOICE_KEYS.has(key)) {
      return { ok: false, error: `voice: unknown field "${key}"` };
    }
  }
  const { register, manner, quirks, taboos, uncertaintyStyle, proactivityTriggers } = obj;
  if (register !== undefined && (typeof register !== "string" || !register.trim())) {
    return { ok: false, error: "voice.register must be a non-empty string" };
  }
  if (manner !== undefined && (typeof manner !== "string" || !manner.trim())) {
    return { ok: false, error: "voice.manner must be a non-empty string" };
  }
  for (const [key, v] of [
    ["quirks", quirks],
    ["taboos", taboos],
    ["proactivityTriggers", proactivityTriggers],
  ] as const) {
    if (v !== undefined) {
      if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || !s.trim())) {
        return { ok: false, error: `voice.${key} must be an array of non-empty strings` };
      }
    }
  }
  if (uncertaintyStyle !== undefined && (typeof uncertaintyStyle !== "string" || !uncertaintyStyle.trim())) {
    return { ok: false, error: "voice.uncertaintyStyle must be a non-empty string" };
  }
  return { ok: true, voice: obj as Partial<PersonaVoice> };
}

// --- routes ---------------------------------------------------------------

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { agentId } = await params;
  if (!isPersonaId(agentId)) {
    return Response.json({ error: `unknown persona "${agentId}"` }, { status: 404 });
  }
  const auth = await requireEditor();
  if ("error" in auth) return auth.error;

  const override = await getPersonaProfileOverride(auth.workspace.id, agentId);
  return Response.json({
    agentId,
    default: DEFAULT_PERSONA_VOICES[agentId],
    override,
    effective: resolvePersonaVoice(agentId, override),
  });
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { agentId } = await params;
  if (!isPersonaId(agentId)) {
    return Response.json({ error: `unknown persona "${agentId}"` }, { status: 404 });
  }
  const auth = await requireEditor();
  if ("error" in auth) return auth.error;

  let body: { voice?: unknown; continuityNotes?: unknown; uncertaintyStyle?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.voice === undefined && body.continuityNotes === undefined && body.uncertaintyStyle === undefined) {
    return Response.json(
      { error: "nothing to update: provide voice, continuityNotes, and/or uncertaintyStyle" },
      { status: 400 },
    );
  }

  let voicePatch: Partial<PersonaVoice> | undefined;
  if (body.voice !== undefined) {
    const v = validateVoice(body.voice);
    if (!v.ok) return Response.json({ error: v.error }, { status: 400 });
    voicePatch = v.voice;
  }
  if (body.continuityNotes !== undefined && typeof body.continuityNotes !== "string") {
    return Response.json({ error: "continuityNotes must be a string" }, { status: 400 });
  }
  if (body.uncertaintyStyle !== undefined && typeof body.uncertaintyStyle !== "string") {
    return Response.json({ error: "uncertaintyStyle must be a string" }, { status: 400 });
  }

  const workspaceId = auth.workspace.id;
  const row = await withWorkspaceScope(workspaceId, async (tx) => {
    const existing = await tx.personaProfile.findUnique({
      where: { workspaceId_agentId: { workspaceId, agentId } },
    });
    const voice = voicePatch !== undefined
      ? ({ ...(existing?.voice as Partial<PersonaVoice> | null | undefined), ...voicePatch } as Partial<PersonaVoice>)
      : existing?.voice ?? {};
    // continuityNotes/uncertaintyStyle are required columns: on create,
    // default from the built-in definition / empty continuity.
    const continuityNotes = body.continuityNotes !== undefined
      ? String(body.continuityNotes)
      : existing?.continuityNotes ?? "";
    const uncertaintyStyle = body.uncertaintyStyle !== undefined
      ? String(body.uncertaintyStyle)
      : existing?.uncertaintyStyle ?? DEFAULT_PERSONA_VOICES[agentId].uncertaintyStyle;
    return tx.personaProfile.upsert({
      where: { workspaceId_agentId: { workspaceId, agentId } },
      create: { workspaceId, agentId, voice, continuityNotes, uncertaintyStyle },
      update: { voice, continuityNotes, uncertaintyStyle },
    });
  });

  return Response.json({
    agentId,
    override: await getPersonaProfileOverride(workspaceId, agentId),
    updatedAt: row.updatedAt,
  });
}
