// Marketr — Phase 8 G3: consolidation status (SPEC-PHASE8.md §6).
// Server status + client trigger button. Async by design: trigger returns
// 202 immediately; the pass runs detached on the worker pool.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { DatabaseZap, Clock3 } from "lucide-react";
import { consolidationStatus } from "@/lib/substrate/memory/consolidate";
import ConsolidationTrigger from "./consolidation-trigger";

// Run statuses are worker-job states -> neutral chips (voice JobsApp precedent).
const chipNeutral =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-1.5 py-0.5 text-[10px] font-medium leading-tight text-muted shadow-control";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Consolidation — Growth Memory — ShapesOS",
  description: "Async distillation, contradiction detection, and decay-to-floor pruning.",
};

export default async function ConsolidationPage() {
  const user = await requireUser();
  if (!user?.id) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const status = await consolidationStatus(workspace.id);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <ConsolidationTrigger workspaceId={workspace.id} />
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <DatabaseZap className="h-3.5 w-3.5" aria-hidden />
          Worker: {status.workerIdentity}
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <Clock3 className="h-3.5 w-3.5" aria-hidden />
          {status.queueDepth} episodes in the distillation backlog
        </span>
      </div>

      {status.lastRun ? (
        <article className="relative rounded-lg border border-line bg-paper p-4">
          <div className="absolute right-3 top-3">
            <span className={chipNeutral}>{status.lastRun.status}</span>
          </div>
          <h3 className="font-medium">Last run</h3>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div><dt className="text-muted">Started</dt><dd>{new Date(status.lastRun.startedAt).toLocaleString()}</dd></div>
            <div><dt className="text-muted">Finished</dt><dd>{status.lastRun.finishedAt ? new Date(status.lastRun.finishedAt).toLocaleString() : "—"}</dd></div>
            <div><dt className="text-muted">Episodes scanned</dt><dd>{status.lastRun.episodesScanned}</dd></div>
            <div><dt className="text-muted">Facts distilled</dt><dd>{status.lastRun.factsDistilled}</dd></div>
            <div><dt className="text-muted">Contradictions invalidated</dt><dd>{status.lastRun.factsInvalidated}</dd></div>
            <div><dt className="text-muted">Learnings deduped</dt><dd>{status.lastRun.learningsDeduped}</dd></div>
            <div><dt className="text-muted">Rows pruned (decay-to-floor)</dt><dd>{status.lastRun.rowsPruned}</dd></div>
          </dl>
          {status.lastRun.error && status.lastRun.status !== "succeeded" && (
            <p className="mt-3 rounded-md bg-hover-paper p-2 text-xs">Run note: {status.lastRun.error.slice(0, 300)}</p>
          )}
        </article>
      ) : (
        <div className="rounded-lg border border-line bg-paper p-8 text-center text-sm text-muted">
          No consolidation runs yet. Trigger the first pass to distill episodes into facts.
        </div>
      )}

      {status.recentRuns.length > 1 && (
        <article className="rounded-lg border border-line bg-paper p-4">
          <h3 className="font-medium">Recent runs</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {status.recentRuns.slice(1).map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <span className={chipNeutral}>{r.status}</span>
                <span className="text-muted">{new Date(r.startedAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </article>
      )}

      <p className="text-xs text-muted">
        Decay-to-floor: user-told facts are never pruned. Agent inferences fade after a year and
        expire only when their decayed confidence falls below the floor — nothing is ever deleted.
      </p>
    </div>
  );
}
