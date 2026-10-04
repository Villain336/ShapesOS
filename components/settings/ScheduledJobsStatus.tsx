// ShapesOS — scheduled jobs status (Phase 6 runtime). Server component,
// rendered on Settings → Providers for platform operators only (the cron
// runner is host-wide, not a workspace setting). Shows whether the in-app
// runner is on in this process, and each job's cadence and last run from
// cron_runs. Run states here are job states, not agent states — neutral
// chips, no status colors.

import { cronRunnerDecision } from "@/lib/cron/runner";
import { lastRunPerJob, type JobStatusView } from "@/lib/cron/store";

const STATUS_LABEL: Record<string, string> = {
  running: "running",
  ok: "ok",
  failed: "failed",
  timeout: "timed out",
};

function when(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export default async function ScheduledJobsStatus() {
  const decision = cronRunnerDecision(process.env);
  let jobs: JobStatusView[] | null = null;
  try {
    jobs = await lastRunPerJob();
  } catch {
    jobs = null;
  }

  return (
    <div className="rounded-lg border border-line bg-paper/60 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium">Scheduled jobs</h2>
        <span className="inline-flex items-center rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted shadow-control">
          {decision.start ? "in-app runner on" : "in-app runner off"}
        </span>
      </div>
      <p className="mt-1 text-xs text-subtle">
        {decision.start
          ? "This server runs the sweeps below on their schedules (times in UTC). One replica runs each slot."
          : `Not running here: ${decision.reason}. Set CRON_RUNNER=internal, or call the routes from an external scheduler with the CRON_SECRET bearer.`}
      </p>
      {jobs === null ? (
        <p className="mt-3 text-sm text-muted">Run history isn&apos;t available (the cron_runs table couldn&apos;t be read).</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-subtle">
                <th className="py-2 pr-3 font-medium">Job</th>
                <th className="py-2 pr-3 font-medium">Schedule</th>
                <th className="py-2 pr-3 font-medium">Last run</th>
                <th className="py-2 pr-3 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.key} className="border-b border-line last:border-0 hover:bg-hover">
                  <td className="py-2 pr-3">
                    <span className="block font-mono text-xs text-ink">{j.key}</span>
                    <span className="block font-mono text-[11px] text-subtle">{j.path}</span>
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs text-muted">{j.cron}</td>
                  <td className="py-2 pr-3 text-xs text-muted">{j.last ? when(j.last.startedAt) : "never"}</td>
                  <td className="py-2 pr-3 text-xs">
                    {j.last ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center rounded-full bg-paper px-2 py-0.5 font-medium text-muted shadow-control">
                          {STATUS_LABEL[j.last.status] ?? j.last.status}
                        </span>
                        {j.last.httpStatus !== null && <span className="font-mono text-subtle">{j.last.httpStatus}</span>}
                        {j.last.durationMs !== null && <span className="text-subtle">{(j.last.durationMs / 1000).toFixed(1)}s</span>}
                        {j.last.error && (
                          <span className="max-w-[280px] truncate text-subtle" title={j.last.error}>
                            {j.last.error}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
