// Marketr — Settings → Agents (Phase 13B, worker 5).
// The "what I've learned about you" surface: per-workspace agent memory,
// preference profile, personas. Sub-tabs [Memory | Personas] follow the
// house sub-tab pattern (Lucide icon + label, active = border-ink
// text-ink). Lessons are sourced from memory_learnings (the
// procedural store — AgentLesson is NOT a table, see docs/phases/13b/
// DATA-MODEL.md); retire = invalidate, never delete.

import Link from "next/link";
import { redirect } from "next/navigation";
import { Brain, Users } from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  listPreferences,
  getLearningPaused,
  type Preference,
} from "@/lib/substrate/memory/preferences";
import MemoryTab from "./memory-tab";
import PersonasTab from "./personas-tab";
import { PERSONAS, type PersonaId } from "@/lib/expert/personas";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Agents — Settings — ShapesOS",
  description: "What ShapesOS's agents have learned about this workspace — lessons, preferences, personas.",
};

export interface LessonRow {
  id: string;
  hypothesis: string;
  action: string;
  result: string;
  source: string;
  sourceEpisodeId: string | null;
  sourceCount: number;
  confidence: number | null;
  retired: boolean;
  observedAt: string;
}

const TABS = [
  { id: "memory", label: "Memory", icon: Brain },
  { id: "personas", label: "Personas", icon: Users },
] as const;

function confidenceOf(metricDelta: unknown): number | null {
  if (metricDelta && typeof metricDelta === "object") {
    const c = (metricDelta as Record<string, unknown>).confidence;
    if (typeof c === "number" && c >= 0 && c <= 1) return c;
  }
  return null;
}

async function loadLessons(workspaceId: string): Promise<LessonRow[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.memoryLearning.findMany({
      where: { workspaceId },
      orderBy: { observedAt: "desc" },
      take: 200,
      select: {
        id: true,
        hypothesis: true,
        action: true,
        result: true,
        source: true,
        sourceEpisodeId: true,
        observedAt: true,
        invalidatedAt: true,
        metricDelta: true,
        contextRefs: true,
      },
    }),
  );
  return rows.map((r) => {
    const refs = (r.contextRefs ?? {}) as Record<string, unknown>;
    const extra = Array.isArray(refs.sourceIds) ? refs.sourceIds.length : 0;
    return {
      id: r.id,
      hypothesis: r.hypothesis,
      action: r.action,
      result: r.result,
      source: r.source,
      sourceEpisodeId: r.sourceEpisodeId,
      sourceCount: (r.sourceEpisodeId ? 1 : 0) + extra,
      confidence: confidenceOf(r.metricDelta),
      retired: r.invalidatedAt != null,
      observedAt: r.observedAt.toISOString(),
    };
  });
}

export default async function AgentsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const canEdit = (await requireWorkspaceRole(user.id, workspace.id, "editor")) !== null;

  const sp = await searchParams;
  const tab = sp.tab === "personas" ? "personas" : "memory";

  const [lessons, preferences, paused, personaRows] = await Promise.all([
    loadLessons(workspace.id),
    listPreferences(workspace.id),
    withWorkspaceScope(workspace.id, (tx) => getLearningPaused(tx, workspace.id)),
    withWorkspaceScope(workspace.id, (tx) =>
      tx.personaProfile.findMany({
        where: { workspaceId: workspace.id },
        select: {
          agentId: true,
          voice: true,
          continuityNotes: true,
          uncertaintyStyle: true,
          updatedAt: true,
        },
      }),
    ),
  ]);

  const byAgent = new Map(personaRows.map((r) => [r.agentId, r]));
  const personas = (Object.keys(PERSONAS) as PersonaId[]).map((id) => {
    const row = byAgent.get(id);
    const voice = ((row?.voice ?? {}) as Record<string, unknown>) ?? {};
    return {
      id,
      name: PERSONAS[id].name,
      description: PERSONAS[id].description,
      surfaces: [...PERSONAS[id].surfaces],
      profile: row
        ? {
            register: typeof voice.register === "string" ? voice.register : "",
            manner: typeof voice.manner === "string" ? voice.manner : "",
            quirks: Array.isArray(voice.quirks) ? voice.quirks.map(String) : [],
            taboos: Array.isArray(voice.taboos) ? voice.taboos.map(String) : [],
            continuityNotes: row.continuityNotes,
            uncertaintyStyle: row.uncertaintyStyle,
            updatedAt: row.updatedAt.toISOString(),
          }
        : null,
    };
  });

  const serializablePrefs: Preference[] = preferences.map((p) => ({
    ...p,
    validAt: p.validAt,
  }));

  return (
    <div className="bg-canvas p-4 md:p-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <div>
          <h1 className="aos-heading">Agents</h1>
          <p className="mt-0.5 text-sm text-muted">
            {workspace.name} — what ShapesOS&apos;s agents have learned, how they should work, and who they are.
          </p>
        </div>
        <SettingsNav />
        <nav aria-label="Agents sections" className="flex flex-wrap gap-1 border-b border-line">
          {TABS.map((t) => {
            const active = tab === t.id;
            const Icon = t.icon;
            return (
              <Link
                key={t.id}
                href={`/dashboard/settings/agents?tab=${t.id}`}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[0.84375rem] font-medium transition ${
                  active
                    ? "border-ink text-ink"
                    : "border-transparent text-muted hover:text-ink"
                }`}
              >
                <Icon size={15} />
                {t.label}
              </Link>
            );
          })}
        </nav>
        {tab === "memory" ? (
          <MemoryTab
            workspaceId={workspace.id}
            lessons={lessons}
            preferences={serializablePrefs.map((p) => ({
              ...p,
              validAt: p.validAt instanceof Date ? p.validAt.toISOString() : String(p.validAt),
            }))}
            paused={paused}
            canEdit={canEdit}
          />
        ) : (
          <PersonasTab workspaceId={workspace.id} personas={personas} canEdit={canEdit} />
        )}
      </div>
    </div>
  );
}
