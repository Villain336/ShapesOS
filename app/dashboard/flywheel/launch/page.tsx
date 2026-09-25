// Marketr — Public-launch readiness tracker (Phase 7, F6).
// Readiness checklist by category with evidence links; the open-core split
// decision brief. READINESS ONLY — no public flip is part of this phase
// (SPEC-PHASE7.md §12.5).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { Badge } from "@/components/vault/shadcn/badge";
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
  title: "Launch readiness — Marketr",
  description: "Public-launch readiness checklist: security, legal, community, build. Readiness only — no public flip.",
};

const STATUS_STYLE: Record<string, string> = {
  complete: "default",
  in_progress: "outline",
  pending: "secondary",
};

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
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Public-launch readiness</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Repo hygiene, license, and community bar for going public — tracked with evidence, not vibes.
          </p>
        </div>
        <Badge variant={pct === 100 ? "default" : "secondary"} className="text-sm">
          {progress.complete}/{progress.total} complete
        </Badge>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <strong>Readiness only.</strong> The open-core split is deferred by standing decision (SPEC-PHASE7 §12.5).
        Nothing here flips the repo public — this page tracks the bar, not the launch.
      </div>

      {!ready && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
          Launch tables are not provisioned yet (migration pending).
        </div>
      )}

      {ready && (
        <>
          <div className="rounded-xl border bg-card p-5 shadow-sm">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">Overall readiness</span>
              <span className="text-muted-foreground">{pct}%</span>
            </div>
            <Progress value={pct} className="mt-2" />
            <div className="mt-3 grid gap-2 sm:grid-cols-4">
              {LAUNCH_CATEGORIES.map((c) => {
                const p = progress.byCategory[c.key];
                const cpct = p.total === 0 ? 0 : Math.round((p.complete / p.total) * 100);
                return (
                  <div key={c.key} className="text-xs">
                    <div className="flex justify-between">
                      <span className="font-medium">{c.title}</span>
                      <span className="text-muted-foreground">
                        {p.complete}/{p.total}
                      </span>
                    </div>
                    <Progress value={cpct} className="mt-1 h-1.5" />
                  </div>
                );
              })}
            </div>
          </div>

          {LAUNCH_CATEGORIES.map((c) => (
            <section key={c.key} className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold">{c.title}</h2>
                <p className="text-sm text-muted-foreground">{c.blurb}</p>
              </div>
              <div className="grid gap-3">
                {rows
                  .filter((r) => r.category === c.key)
                  .map((r) => {
                    const cat = catalog.get(r.key);
                    return (
                      <div key={r.id} className="rounded-xl border bg-card p-4 shadow-sm">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="text-sm font-semibold">{r.item}</h3>
                              <Badge variant={(STATUS_STYLE[r.status] ?? "secondary") as "default" | "outline" | "secondary"}>
                                {r.status.replace("_", " ")}
                              </Badge>
                            </div>
                            {cat && <p className="mt-1 text-xs text-muted-foreground">{cat.doneWhen}</p>}
                            {r.note && <p className="mt-1 text-xs italic text-stone-500">Note: {r.note}</p>}
                            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                              {r.evidenceUrl ? (
                                /^https?:\/\//.test(r.evidenceUrl) ? (
                                  <a
                                    href={r.evidenceUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-blue-600 underline"
                                  >
                                    Evidence ↗
                                  </a>
                                ) : (
                                  <span className="font-mono text-stone-600">{r.evidenceUrl}</span>
                                )
                              ) : (
                                <span className="text-stone-400">No evidence yet</span>
                              )}
                              {r.completedAt && (
                                <span className="text-stone-400">
                                  completed {new Date(r.completedAt).toLocaleDateString()}
                                </span>
                              )}
                              {cat && <span className="text-stone-400">{cat.specRef}</span>}
                            </div>
                            {cat && (
                              <p className="mt-1 text-[11px] text-stone-400">Evidence hint: {cat.evidenceHint}</p>
                            )}
                          </div>
                          {canEdit && (
                            <div className="shrink-0">
                              {r.status === "complete" ? <ReopenButton id={r.id} /> : <CompleteButton id={r.id} />}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </section>
          ))}

          <section className="rounded-xl border bg-card p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Decision brief: the open-core split (deferred)</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Four options mapped in <span className="font-mono">docs/open-core-options.md</span> — presented
              with tradeoffs, no recommendation. The split is genuinely undecided; this phase builds readiness
              and the brief, not the decision.
            </p>
            <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
              <li className="rounded-lg border p-3">
                <strong>A — Open everything.</strong> All code AGPL; commercial = white-label license + hosted + support.
              </li>
              <li className="rounded-lg border p-3">
                <strong>B — AGPL core + closed enterprise pack.</strong> SSO/RBAC/audit, white-label sub-accounts, premium integrations.
              </li>
              <li className="rounded-lg border p-3">
                <strong>C — Three-layer GPL/AGPL/closed.</strong> GrowthOS orchestrator closed. Finest IP protection, highest complexity.
              </li>
              <li className="rounded-lg border p-3">
                <strong>D — AGPL everything + cloud premium.</strong> No closed code; Cloud wins on cadence + managed keys.
              </li>
            </ul>
            <p className="mt-3 text-xs text-stone-500">
              Staged alongside: CLA-vs-DCO (must-decide-before-public), the AGPLv3 §7 trademark note (OnlyOffice 2026
              precedent), and the Product Hunt playbook.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
