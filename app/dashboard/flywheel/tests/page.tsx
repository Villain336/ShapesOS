// Marketr — Test Lab index (F3).
// Idea queue (PIE/ICE), experiment list, new-experiment entry.
// Mirrors app/dashboard/authority/page.tsx conventions.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { resolveExperimentStore } from "@/lib/flywheel/testlab/store";
import { Badge } from "@/components/vault/shadcn/badge";
import { Button } from "@/components/vault/shadcn/button";
import { FlaskConical, Lightbulb, Plus } from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Test Lab — Marketr",
  description: "CRO/A-B experimentation: ideas, experiments, honesty dashboard.",
};

function statusVariant(s: string) {
  switch (s) {
    case "running": return "default";
    case "complete": return "secondary";
    case "archived": return "outline";
    case "qa": return "outline";
    default: return "secondary";
  }
}

function verdictVariant(v: string | null) {
  switch (v) {
    case "winner": return "default";
    case "loser": return "destructive";
    case "compromised": return "destructive";
    default: return "secondary";
  }
}

export default async function TestLabPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const { store, persistent } = await resolveExperimentStore();
  const [experiments, ideas] = await Promise.all([
    store.listExperiments(workspace.id).catch(() => []),
    store.listIdeas(workspace.id).catch(() => []),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <FlaskConical className="h-6 w-6" /> Test Lab
          </h1>
          <p className="text-sm text-muted-foreground">
            Peek-safe A/B testing with an honesty dashboard — the lab refuses to
            declare a winner it can&apos;t defend.
          </p>
        </div>
        <Link href="/dashboard/flywheel/tests/new">
          <Button><Plus className="mr-1 h-4 w-4" /> New experiment</Button>
        </Link>
      </div>

      {!persistent && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
          Test Lab tables are not provisioned yet (migration pending) — showing
          in-memory workspace data only.
        </div>
      )}

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Lightbulb className="h-4 w-4" /> Idea queue
          <span className="text-xs font-normal text-muted-foreground">ranked by PIE/ICE</span>
        </h2>
        {ideas.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No ideas yet. Ideas arrive from Phases 2–6 signals — or add one via the API.
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {ideas.map((idea) => (
              <div key={idea.id} className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold">{idea.title}</h3>
                  <Badge variant="outline">{idea.pieIceScore.toFixed(1)}</Badge>
                </div>
                {idea.sourceSignal && (
                  <p className="mt-1 text-xs text-muted-foreground">Signal: {idea.sourceSignal}</p>
                )}
                <Badge variant="secondary" className="mt-2">{idea.status}</Badge>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Experiments</h2>
        {experiments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No experiments yet. Create one to walk the full lifecycle:
            draft → QA → launch → verdict → archive.
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {experiments.map((e) => (
              <Link
                key={e.id}
                href={`/dashboard/flywheel/tests/${e.id}`}
                className="rounded-xl border bg-card p-5 shadow-sm transition hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-base font-semibold">{e.name}</h3>
                  <Badge variant={statusVariant(e.status)}>{e.status}</Badge>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{e.hypothesis}</p>
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  <Badge variant="outline">{e.channel}</Badge>
                  <Badge variant="outline">{e.primaryMetric}</Badge>
                  {e.verdict && <Badge variant={verdictVariant(e.verdict)}>{e.verdict}</Badge>}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
