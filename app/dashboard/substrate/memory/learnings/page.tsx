// Marketr — Phase 8 G3: learnings list.
// House pattern (Creative Studio): dense table, violet primary button,
// stone info notes, light mode, Lucide icons. Filters (result, source, q).
// Styling only — no data changes.

import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { CheckCircle2, XCircle, HelpCircle, FlaskConical, Filter } from "lucide-react";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { freshnessLabel } from "@/lib/substrate/graph/freshness";
import {
  Chip,
  btnPrimary,
  infoNoteCls,
  inputCls,
  rowCls,
  tableShell,
  thCls,
  theadCls,
} from "../../ui";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Learnings — Growth Memory — Marketr",
  description: "What worked, what failed, what was inconclusive — with provenance.",
};

const RESULT_ICON = {
  worked: CheckCircle2,
  failed: XCircle,
  inconclusive: HelpCircle,
} as const;

const RESULT_TONE = {
  worked: "green",
  failed: "red",
  inconclusive: "amber",
} as const;

function bucketTone(bucket: string): "slate" | "amber" | "red" {
  if (bucket === "fresh") return "slate";
  if (bucket === "aging") return "amber";
  return "red";
}

async function listLearnings(
  workspaceId: string,
  opts: { result?: string; source?: string; q?: string },
) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.memoryLearning.findMany({
      where: {
        workspaceId,
        invalidatedAt: null,
        ...(opts.result ? { result: opts.result as never } : {}),
        ...(opts.source ? { source: opts.source as never } : {}),
        ...(opts.q
          ? {
              OR: [
                { hypothesis: { contains: opts.q, mode: "insensitive" } },
                { action: { contains: opts.q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { observedAt: "desc" },
      take: 60,
    }),
  );
}

export default async function LearningsPage({
  searchParams,
}: {
  searchParams: Promise<{ result?: string; source?: string; q?: string }>;
}) {
  const user = await requireUser();
  if (!user?.id) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const sp = await searchParams;
  const learnings = await listLearnings(workspace.id, {
    result: sp.result || undefined,
    source: sp.source || undefined,
    q: sp.q?.trim() || undefined,
  });
  const now = new Date();

  return (
    <div>
      <form method="get" className="mb-3 flex flex-wrap items-center gap-2">
        <input
          name="q"
          placeholder="Search hypothesis or action…"
          defaultValue={sp.q ?? ""}
          className={`${inputCls} w-64`}
        />
        <select
          name="result"
          defaultValue={sp.result ?? ""}
          className={inputCls}
          aria-label="Filter by result"
        >
          <option value="">All results</option>
          <option value="worked">Worked</option>
          <option value="failed">Failed</option>
          <option value="inconclusive">Inconclusive</option>
        </select>
        <button type="submit" className={btnPrimary}>
          <Filter size={14} /> Filter
        </button>
        <span className="ml-auto text-[13px] text-muted">{learnings.length} learnings</span>
      </form>

      <div className={tableShell}>
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className={theadCls}>
              <th className={thCls}>Learning</th>
              <th className={thCls}>Verdict</th>
              <th className={thCls}>Confidence</th>
              <th className={thCls}>Provenance</th>
              <th className={thCls}>Source episode</th>
            </tr>
          </thead>
          <tbody>
            {learnings.map((l) => {
              const Icon = RESULT_ICON[l.result as keyof typeof RESULT_ICON] ?? HelpCircle;
              const fresh = freshnessLabel(l.observedAt, `memory:learning · ${l.source}`, now);
              return (
                <tr key={l.id} className={rowCls}>
                  <td className="px-3 py-2">
                    <div className="flex items-start gap-2">
                      <Icon size={15} className="mt-0.5 shrink-0 text-subtle" aria-hidden />
                      <div className="min-w-0">
                        <div className="font-medium leading-snug text-ink">{l.hypothesis}</div>
                        <div className="mt-0.5 text-[12px] text-muted">{l.action}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Chip tone={RESULT_TONE[l.result as keyof typeof RESULT_TONE] ?? "slate"}>
                      {l.result}
                    </Chip>
                  </td>
                  <td className="px-3 py-2 tabular-nums text-muted">
                    {/* Procedural learnings carry no stored confidence; human-asserted
                        ones are 1.0 by house rule (they never decay). */}
                    {l.source === "human" ? "1.00" : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-[12px] text-muted">{fresh.label}</div>
                    <div className="mt-1">
                      <Chip tone={bucketTone(fresh.bucket)}>{fresh.bucket}</Chip>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {l.sourceEpisodeId ? (
                      <Link
                        className="text-[12px] text-ink underline hover:text-ink"
                        href={`/dashboard/substrate/memory/episodes#${l.sourceEpisodeId}`}
                      >
                        source episode
                      </Link>
                    ) : (
                      <span className="text-[12px] text-subtle">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {learnings.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-[13px] text-subtle">
                  No learnings yet. Close a Test Lab experiment and archive it — the learning lands here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className={`${infoNoteCls} mt-3 flex items-start gap-2`}>
        <FlaskConical size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden />
        <p>Human-asserted learnings carry confidence 1.0 and origin user_told — they never decay.</p>
      </div>
    </div>
  );
}
