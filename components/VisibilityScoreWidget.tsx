// Marketr — composite visibility score widget (milestone 14).
// Server component for the project overview page: latest score, 30-day
// sparkline, and the component breakdown that explains the number.

import Link from "next/link";
import { prisma } from "@/lib/prisma";

const COMPONENT_LABELS: Record<string, string> = {
  rankings: "Rankings",
  aiPresence: "AI presence",
  freshness: "Freshness",
  coverage: "Coverage",
};

export default async function VisibilityScoreWidget({ projectId }: { projectId: string }) {
  const scores = await prisma.visibilityScore.findMany({
    where: { projectId },
    orderBy: { date: "desc" },
    take: 30,
  });
  const latest = scores[0];
  const trend = scores.slice().reverse();

  const weekAgo = scores.find((s) => {
    const days = (latest!.date.getTime() - s.date.getTime()) / (24 * 60 * 60 * 1000);
    return days >= 6 && days <= 8;
  });
  const delta = latest && weekAgo ? latest.score - weekAgo.score : null;

  const W = 220;
  const H = 56;
  const pts = trend.map((s, i) => {
    const x = trend.length === 1 ? W / 2 : (i / (trend.length - 1)) * W;
    const y = H - 4 - (s.score / 100) * (H - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const components = (latest?.components ?? {}) as Record<string, unknown>;

  return (
    <div className="rounded-lg border border-zinc-300 bg-white p-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-widest text-zinc-500">Visibility score</h2>
          {latest ? (
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-4xl font-bold">{latest.score}</span>
              <span className="text-sm text-zinc-500">/ 100</span>
              {delta !== null && delta !== 0 && (
                <span className={`text-sm font-medium ${delta > 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {delta > 0 ? "▲" : "▼"} {Math.abs(delta)} WoW
                </span>
              )}
            </div>
          ) : (
            <p className="mt-2 text-sm text-zinc-500">No score yet — the daily cron computes it.</p>
          )}
        </div>
        <Link href={`/dashboard/projects/${projectId}`} className="text-xs text-zinc-500 hover:text-zinc-600">
          What&apos;s this?
        </Link>
      </div>

      {trend.length > 1 && (
        <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full" role="img" aria-label="30-day visibility score trend">
          <polyline points={pts.join(" ")} fill="none" stroke="#ea580c" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      )}

      {latest && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {Object.entries(COMPONENT_LABELS).map(([key, label]) => {
            const v = typeof components[key] === "number" ? (components[key] as number) : null;
            return (
              <div key={key} className="rounded border border-zinc-200 bg-zinc-50 p-2">
                <div className="text-xs text-zinc-500">{label}</div>
                <div className="mt-0.5 text-lg font-semibold">{v ?? "–"}</div>
                <div className="mt-1 h-1 overflow-hidden rounded bg-zinc-100">
                  <div className="h-full rounded bg-orange-600" style={{ width: `${Math.min(100, Math.max(0, v ?? 0))}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
