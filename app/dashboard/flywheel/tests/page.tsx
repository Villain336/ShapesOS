// Marketr — Test Lab index (F3).
// Idea queue (PIE/ICE), experiment list, new-experiment entry.
// Mirrors app/dashboard/authority/page.tsx conventions.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { resolveExperimentStore } from "@/lib/flywheel/testlab/store";
// Category chips are neutral by default (tone accepted for call-site compat).
function chip(text: React.ReactNode, cls?: string) {
  void cls;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-[0.625rem] font-semibold leading-tight text-muted shadow-control">
      {text}
    </span>
  );
}

// Status badges carry the AOS status shape language:
// running = agent run in progress, qa = awaiting attention, complete/archived = neutral.
function statusBadge(status: string) {
  const base =
    "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[0.625rem] font-semibold leading-tight";
  if (status === "running")
    return (
      <span className={`${base} bg-running text-white`}>
        <span className="aos-shape aos-shape--running aos-is-live [--aos-shape-size:9px]" style={{ color: "inherit" }} aria-hidden /> running
      </span>
    );
  if (status === "qa")
    return (
      <span className={`${base} bg-needs text-ink`}>
        <span className="aos-shape aos-shape--needs aos-shape--edged [--aos-shape-size:9px]" style={{ color: "inherit" }} aria-hidden /> qa
      </span>
    );
  return <span className={`${base} bg-paper text-muted shadow-control`}>{status}</span>;
}
import { Button } from "@/components/vault/shadcn/button";
import { Plus } from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Test Lab — ShapesOS",
  description: "CRO/A-B experimentation: ideas, experiments, honesty dashboard.",
};

// Verdicts are analytic outcomes, not agent states — the neutral chip() renders them.


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
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="aos-heading">Test Lab</h1>
          <p className="mt-0.5 text-[0.8125rem] text-muted">
            Peek-safe A/B testing with an honesty dashboard — the lab refuses to
            declare a winner it can&apos;t defend.
          </p>
        </div>
        <Link href="/dashboard/flywheel/tests/new">
          <Button className="inline-flex h-control cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-5 text-sm font-semibold text-white aos-press hover:bg-ink-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40"><Plus className="mr-1 h-4 w-4" /> New experiment</Button>
        </Link>
      </header>

      {!persistent && (
        <div className="flex items-start gap-2.5 rounded-lg bg-needs p-4 text-sm text-ink">
          <span className="aos-shape aos-shape--needs aos-shape--edged mt-0.5 shrink-0 [--aos-shape-size:14px]" style={{ color: "inherit" }} aria-hidden />
          <span>
            Test Lab tables are not provisioned yet (migration pending) — showing
            in-memory workspace data only.
          </span>
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight text-ink">Idea queue
          <span className="ml-1.5 text-xs font-normal text-muted">ranked by PIE/ICE</span>
        </h2>
        {ideas.length === 0 ? (
          <p className="text-[0.8125rem] text-muted">
            No ideas yet. Ideas arrive from Phases 2–6 signals — or add one via the API.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-white">
            <table className="w-full text-left text-[0.8125rem]">
              <thead>
                <tr className="border-b border-line text-xs font-semibold text-muted">
                  <th className="px-3 py-2 font-medium">Idea</th>
                  <th className="px-3 py-2 font-medium">PIE/ICE</th>
                  <th className="px-3 py-2 font-medium">Signal</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {ideas.map((idea) => (
                  <tr key={idea.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2 font-medium text-ink">{idea.title}</td>
                    <td className="px-3 py-2 font-mono text-[0.75rem] text-muted">{idea.pieIceScore.toFixed(1)}</td>
                    <td className="px-3 py-2 text-[0.75rem] text-muted">{idea.sourceSignal ?? "—"}</td>
                    <td className="px-3 py-2">{chip(idea.status, "border-line bg-hover text-muted")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight text-ink">Experiments</h2>
        {experiments.length === 0 ? (
          <p className="text-[0.8125rem] text-muted">
            No experiments yet. Create one to walk the full lifecycle:
            draft → QA → launch → verdict → archive.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-white">
            <table className="w-full text-left text-[0.8125rem]">
              <thead>
                <tr className="border-b border-line text-xs font-semibold text-muted">
                  <th className="px-3 py-2 font-medium">Experiment</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Channel</th>
                  <th className="px-3 py-2 font-medium">Primary metric</th>
                  <th className="px-3 py-2 font-medium">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {experiments.map((e) => (
                  <tr key={e.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/flywheel/tests/${e.id}`} className="font-medium text-ink hover:text-ink">
                        {e.name}
                      </Link>
                      <span className="block max-w-xs truncate text-[0.75rem] text-muted">{e.hypothesis}</span>
                    </td>
                    <td className="px-3 py-2">{statusBadge(e.status)}</td>
                    <td className="px-3 py-2 text-[0.75rem] text-muted">{e.channel}</td>
                    <td className="px-3 py-2 text-[0.75rem] text-muted">{e.primaryMetric}</td>
                    <td className="px-3 py-2">
                      {e.verdict ? chip(e.verdict) : <span className="text-subtle">—</span>}
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
