// Marketr — Public-launch readiness tracker (Phase 7, F6).
// Readiness checklist by category with evidence links; the open-core split
// decision brief. READINESS ONLY — no public flip is part of this phase
// (docs/specs/SPEC-PHASE7.md §12.5).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
// Category chips are neutral by default (tone accepted for call-site compat).
function chip(text: React.ReactNode, cls?: string) {
  void cls;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-[0.625rem] font-semibold leading-tight text-muted shadow-control">
      {text}
    </span>
  );
}
import { Progress } from "@/components/vault/shadcn/progress";
import {
  launchTablesReady,
  seedLaunchChecklist,
  listLaunchChecklist,
  progressOf,
} from "@/lib/flywheel/launch/store";
import { LAUNCH_CATEGORIES, LAUNCH_CHECKLIST_CATALOG } from "@/lib/flywheel/launch/catalog";
import { CompleteButton, ReopenButton } from "./_components/launch-actions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Launch readiness — ShapesOS",
  description: "Public-launch readiness checklist: security, legal, community, build. Readiness only — no public flip.",
};

// Checklist statuses carry the AOS status shape language:
// complete = done, in_progress = running, pending = neutral.
const STATUS_SHAPE = (tone: string) => (
  <span className={`aos-shape ${tone} [--aos-shape-size:9px]`} style={{ color: "inherit" }} aria-hidden />
);
function statusBadge(status: string) {
  const base =
    "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[0.625rem] font-semibold leading-tight";
  switch (status) {
    case "complete":
      return (
        <span className={`${base} bg-done text-white`}>
          {STATUS_SHAPE("aos-shape--done")} complete
        </span>
      );
    case "in_progress":
      return (
        <span className={`${base} bg-running text-white`}>
          {STATUS_SHAPE("aos-shape--running aos-is-live")} in progress
        </span>
      );
    default:
      return <span className={`${base} bg-paper text-muted shadow-control`}>pending</span>;
  }
}

export default async function LaunchReadinessPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  const canEdit = membership.role === "editor" || membership.role === "admin" || membership.role === "owner";

  const ready = await launchTablesReady().catch(() => false);
  const rows = ready
    ? await (async () => {
        await seedLaunchChecklist(workspace.id);
        return listLaunchChecklist(workspace.id);
      })().catch(() => [])
    : [];
  const order = new Map(LAUNCH_CHECKLIST_CATALOG.map((c, i) => [c.key, i]));
  rows.sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
  const catalog = new Map(LAUNCH_CHECKLIST_CATALOG.map((c) => [c.key, c]));
  const progress = progressOf(rows);
  const pct = progress.total === 0 ? 0 : Math.round((progress.complete / progress.total) * 100);

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="aos-heading">Public-launch readiness</h1>
          <p className="mt-0.5 text-[0.8125rem] text-muted">
            Repo hygiene, license, and community bar for going public — tracked with evidence, not vibes.
          </p>
        </div>
        <span className="text-[0.8125rem] font-semibold text-muted">{progress.complete}/{progress.total} complete</span>
      </header>

      <div className="flex items-start gap-2.5 rounded-lg bg-needs p-4 text-sm text-ink"><span className="aos-shape aos-shape--needs aos-shape--edged mt-0.5 shrink-0 [--aos-shape-size:14px]" style={{ color: "inherit" }} aria-hidden /><span><strong>Readiness only.</strong> The open-core split is deferred by standing decision (SPEC-PHASE7 §12.5). Nothing here flips the repo public — this page tracks the bar, not the launch.</span></div>

      {!ready && (
        <div className="flex items-start gap-2.5 rounded-lg bg-needs p-4 text-sm text-ink"><span className="aos-shape aos-shape--needs aos-shape--edged mt-0.5 shrink-0 [--aos-shape-size:14px]" style={{ color: "inherit" }} aria-hidden /><span>Launch tables are not provisioned yet (migration pending).</span></div>
      )}

      {ready && (
        <>
          <div className="rounded-xl border border-line bg-white p-4">
            <div className="flex items-center justify-between text-[0.8125rem]">
              <span className="font-medium text-ink">Overall readiness</span>
              <span className="text-muted">{pct}%</span>
            </div>
            <Progress value={pct} className="mt-2" />
            <div className="mt-3 grid gap-2 sm:grid-cols-4">
              {LAUNCH_CATEGORIES.map((c) => {
                const p = progress.byCategory[c.key];
                const cpct = p.total === 0 ? 0 : Math.round((p.complete / p.total) * 100);
                return (
                  <div key={c.key} className="text-xs">
                    <div className="flex justify-between">
                      <span className="font-medium text-ink">{c.title}</span>
                      <span className="text-muted">
                        {p.complete}/{p.total}
                      </span>
                    </div>
                    <Progress value={cpct} className="mt-1 h-1.5" />
                  </div>
                );
              })}
            </div>
          </div>

          {LAUNCH_CATEGORIES.map((c) => {
            const catRows = rows.filter((r) => r.category === c.key);
            return (
              <section key={c.key} className="space-y-2">
                <div>
                  <h2 className="text-sm font-semibold tracking-tight text-ink">{c.title}</h2>
                  <p className="text-[0.8125rem] text-muted">{c.blurb}</p>
                </div>
                <div className="overflow-x-auto rounded-xl border border-line bg-white">
                  <table className="w-full text-left text-[0.8125rem]">
                    <thead>
                      <tr className="border-b border-line text-xs font-semibold text-muted">
                        <th className="px-3 py-2 font-medium">Checklist item</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2 font-medium">Evidence</th>
                        <th className="px-3 py-2 font-medium">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {catRows.map((r) => {
                        const cat = catalog.get(r.key);
                        return (
                          <tr key={r.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                            <td className="max-w-sm px-3 py-2">
                              <span className="font-medium text-ink">{r.item}</span>
                              {cat && <span className="block text-[0.75rem] text-muted">{cat.doneWhen}</span>}
                              {r.note && <span className="block text-[0.75rem] italic text-muted">Note: {r.note}</span>}
                              {cat && (
                                <span className="block text-[0.6875rem] text-subtle">
                                  {cat.specRef} · hint: {cat.evidenceHint}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {statusBadge(r.status)}
                            </td>
                            <td className="px-3 py-2 text-[0.75rem] text-muted">
                              {r.evidenceUrl ? (
                                /^https?:\/\//.test(r.evidenceUrl) ? (
                                  <a
                                    href={r.evidenceUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-ink underline"
                                  >
                                    Evidence ↗
                                  </a>
                                ) : (
                                  <span className="font-mono">{r.evidenceUrl}</span>
                                )
                              ) : (
                                <span className="text-subtle">No evidence yet</span>
                              )}
                              {r.completedAt && (
                                <span className="block text-subtle">
                                  completed {new Date(r.completedAt).toLocaleDateString()}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {canEdit && (r.status === "complete" ? <ReopenButton id={r.id} /> : <CompleteButton id={r.id} />)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}

          <section className="rounded-xl border border-line bg-white p-4">
            <h2 className="text-sm font-semibold tracking-tight text-ink">Decision brief: the open-core split (deferred)</h2>
            <p className="mt-0.5 text-[0.8125rem] text-muted">
              Four options mapped in <span className="font-mono">docs/open-core-options.md</span> — presented
              with tradeoffs, no recommendation. The split is genuinely undecided; this phase builds readiness
              and the brief, not the decision.
            </p>
            <div className="mt-2 overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-left text-[0.8125rem]">
                <thead>
                  <tr className="border-b border-line text-xs font-semibold text-muted">
                    <th className="px-3 py-2 font-medium">Option</th>
                    <th className="px-3 py-2 font-medium">Model</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-line hover:bg-hover-paper"><td className="px-3 py-2 font-medium text-ink">A — Open everything</td><td className="px-3 py-2 text-muted">All code AGPL; commercial = white-label license + hosted + support.</td></tr>
                  <tr className="border-b border-line hover:bg-hover-paper"><td className="px-3 py-2 font-medium text-ink">B — AGPL core + closed enterprise pack</td><td className="px-3 py-2 text-muted">SSO/RBAC/audit, white-label sub-accounts, premium integrations.</td></tr>
                  <tr className="border-b border-line hover:bg-hover-paper"><td className="px-3 py-2 font-medium text-ink">C — Three-layer GPL/AGPL/closed</td><td className="px-3 py-2 text-muted">GrowthOS orchestrator closed. Finest IP protection, highest complexity.</td></tr>
                  <tr className="hover:bg-hover-paper"><td className="px-3 py-2 font-medium text-ink">D — AGPL everything + cloud premium</td><td className="px-3 py-2 text-muted">No closed code; Cloud wins on cadence + managed keys.</td></tr>
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-muted">
              Staged alongside: CLA-vs-DCO (must-decide-before-public), the AGPLv3 §7 trademark note (OnlyOffice 2026
              precedent), and the Product Hunt playbook.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
