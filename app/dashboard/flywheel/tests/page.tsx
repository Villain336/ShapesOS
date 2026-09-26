// Marketr — Test Lab index (F3).
// Idea queue (PIE/ICE), experiment list, new-experiment entry.
// Mirrors app/dashboard/authority/page.tsx conventions.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { resolveExperimentStore } from "@/lib/flywheel/testlab/store";
function chip(text: React.ReactNode, cls: string) {
  return (
    <span className={`inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${cls}`}>
      {text}
    </span>
  );
}
import { Button } from "@/components/vault/shadcn/button";
import { Plus } from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Test Lab — Marketr",
  description: "CRO/A-B experimentation: ideas, experiments, honesty dashboard.",
};

const STATUS_CHIP: Record<string, string> = {
  running: "border-violet-200 bg-violet-50 text-violet-700",
  complete: "border-stone-200 bg-stone-100 text-stone-600",
  archived: "border-stone-200 bg-stone-50 text-stone-500",
  qa: "border-amber-200 bg-amber-50 text-amber-700",
};

const VERDICT_CHIP: Record<string, string> = {
  winner: "border-emerald-200 bg-emerald-50 text-emerald-700",
  loser: "border-red-200 bg-red-50 text-red-700",
  compromised: "border-red-200 bg-red-50 text-red-700",
};

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
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-stone-900">Test Lab</h1>
          <p className="mt-0.5 text-[13px] text-stone-500">
            Peek-safe A/B testing with an honesty dashboard — the lab refuses to
            declare a winner it can&apos;t defend.
          </p>
        </div>
        <Link href="/dashboard/flywheel/tests/new">
          <Button className="bg-violet-600 text-white hover:bg-violet-700"><Plus className="mr-1 h-4 w-4" /> New experiment</Button>
        </Link>
      </header>

      {!persistent && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
          Test Lab tables are not provisioned yet (migration pending) — showing
          in-memory workspace data only.
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight text-stone-900">Idea queue
          <span className="ml-1.5 text-xs font-normal text-stone-500">ranked by PIE/ICE</span>
        </h2>
        {ideas.length === 0 ? (
          <p className="text-[13px] text-stone-500">
            No ideas yet. Ideas arrive from Phases 2–6 signals — or add one via the API.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">Idea</th>
                  <th className="px-3 py-2 font-medium">PIE/ICE</th>
                  <th className="px-3 py-2 font-medium">Signal</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {ideas.map((idea) => (
                  <tr key={idea.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                    <td className="px-3 py-2 font-medium text-stone-900">{idea.title}</td>
                    <td className="px-3 py-2 font-mono text-[12px] text-stone-700">{idea.pieIceScore.toFixed(1)}</td>
                    <td className="px-3 py-2 text-[12px] text-stone-500">{idea.sourceSignal ?? "—"}</td>
                    <td className="px-3 py-2">{chip(idea.status, "border-stone-200 bg-stone-100 text-stone-600")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight text-stone-900">Experiments</h2>
        {experiments.length === 0 ? (
          <p className="text-[13px] text-stone-500">
            No experiments yet. Create one to walk the full lifecycle:
            draft → QA → launch → verdict → archive.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">Experiment</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Channel</th>
                  <th className="px-3 py-2 font-medium">Primary metric</th>
                  <th className="px-3 py-2 font-medium">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {experiments.map((e) => (
                  <tr key={e.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/flywheel/tests/${e.id}`} className="font-medium text-stone-900 hover:text-violet-700">
                        {e.name}
                      </Link>
                      <span className="block max-w-xs truncate text-[12px] text-stone-500">{e.hypothesis}</span>
                    </td>
                    <td className="px-3 py-2">{chip(e.status, STATUS_CHIP[e.status] ?? STATUS_CHIP.qa)}</td>
                    <td className="px-3 py-2 text-[12px] text-stone-600">{e.channel}</td>
                    <td className="px-3 py-2 text-[12px] text-stone-600">{e.primaryMetric}</td>
                    <td className="px-3 py-2">
                      {e.verdict ? chip(e.verdict, VERDICT_CHIP[e.verdict] ?? "border-stone-200 bg-stone-100 text-stone-600") : <span className="text-stone-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
