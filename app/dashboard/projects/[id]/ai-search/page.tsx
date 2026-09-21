// Marketr — AI search visibility dashboard (milestone 14).
// Per-project tab: AI Overview presence %, citation rate, daily trend, and
// per-keyword latest snapshot (cited URL when the site is cited).

import { accessibleWorkspaceWhere } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { aiVisibilitySummary } from "@/lib/retention/ai-visibility";

export const dynamic = "force-dynamic";

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="text-xs uppercase tracking-widest text-zinc-500">{label}</div>
      <div className="mt-1 text-3xl font-bold">{value}</div>
      <div className="mt-1 text-xs text-zinc-500">{hint}</div>
    </div>
  );
}

function TrendBars({ trend }: { trend: { date: string; checked: number; overviewPresent: number; siteCited: number }[] }) {
  const points = trend.slice(-30);
  const max = Math.max(1, ...points.map((p) => p.checked));
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h2 className="text-sm font-medium uppercase tracking-widest text-zinc-500">30-day trend</h2>
      <div className="mt-3 flex h-32 items-end gap-1">
        {points.map((p) => (
          <div key={p.date} className="flex flex-1 flex-col items-center justify-end gap-0.5" title={`${p.date}: ${p.overviewPresent}/${p.checked} AI Overviews, ${p.siteCited} cited`}>
            <div className="flex w-full flex-col justify-end" style={{ height: `${(100 * Math.max(p.overviewPresent, 1)) / max}%`, minHeight: 4 }}>
              <div className="w-full rounded-sm bg-violet-500/70" style={{ height: `${p.overviewPresent ? 100 : 0}%` }} />
            </div>
            <div className="flex w-full flex-col justify-end" style={{ height: `${(100 * Math.max(p.siteCited, 1)) / max}%`, minHeight: 4 }}>
              <div className="w-full rounded-sm bg-emerald-500/80" style={{ height: `${p.siteCited ? 100 : 0}%` }} />
            </div>
          </div>
        ))}
        {points.length === 0 && <p className="text-sm text-zinc-500">No snapshots yet — run a rank check.</p>}
      </div>
      <div className="mt-2 flex gap-4 text-xs text-zinc-500">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-violet-500/70" /> AI Overview present</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-500/80" /> Site cited</span>
      </div>
    </div>
  );
}

export default async function AISearchPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return null;
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
  });
  if (!project) notFound();

  const summary = await aiVisibilitySummary(project.id, 30);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/dashboard/projects/${project.id}`} className="text-sm text-zinc-500 hover:text-zinc-300">
          ← {project.domain}
        </Link>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">AI search visibility</h1>
        <p className="mt-1 text-sm text-zinc-400">
          How often AI Overviews appear for your tracked keywords — and whether your site is cited inside them.
          Snapshots are recorded on every rank check.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="AI Overview presence" value={`${summary.presencePct}%`} hint={`of ${summary.keywordsTracked} tracked keywords`} />
        <Stat label="Citation rate" value={`${summary.citationPct}%`} hint="keywords where your site is cited in the AI answer" />
        <Stat label="Share of AI Overviews" value={`${summary.citationShareOfOverviewsPct}%`} hint="cited ÷ keywords with an AI Overview" />
      </div>

      <TrendBars trend={summary.trend} />

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-zinc-500">Per keyword</h2>
        {summary.perKeyword.length === 0 ? (
          <p className="text-sm text-zinc-500">No tracked keywords yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-widest text-zinc-500">
                <th className="pb-2 pr-4">Keyword</th>
                <th className="pb-2 pr-4">AI Overview</th>
                <th className="pb-2 pr-4">Cited</th>
                <th className="pb-2">Checked</th>
              </tr>
            </thead>
            <tbody>
              {summary.perKeyword.map((k) => (
                <tr key={k.keywordId} className="border-t border-zinc-800">
                  <td className="py-2 pr-4">{k.phrase}</td>
                  <td className="py-2 pr-4">{k.aiOverviewPresent ? "✨ yes" : <span className="text-zinc-600">—</span>}</td>
                  <td className="py-2 pr-4">
                    {k.siteCited ? (
                      <span className="text-emerald-400">
                        ✓ cited{k.citedUrl ? ` (${k.citedUrl.replace(/^https?:\/\//, "").slice(0, 40)})` : ""}
                      </span>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="py-2 text-zinc-500">{k.checkedAt ? k.checkedAt.slice(0, 10) : "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
