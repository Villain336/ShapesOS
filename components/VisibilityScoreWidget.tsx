// Marketr — composite visibility score widget (milestone 14).
// Server component for the project overview page: latest score, 30-day
// sparkline, and the component breakdown that explains the number.

import Link from "next/link";
import { Gauge, TrendingDown, TrendingUp } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { EmptyState } from "@/components/vault/EmptyState";
import { ValuePill } from "@/components/vault/atoms/ValuePill";
import { buttonVariants } from "@/components/vault/atoms/button-variants";

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

  const weekAgo = latest
    ? scores.find((s) => {
        const days = (latest.date.getTime() - s.date.getTime()) / (24 * 60 * 60 * 1000);
        return days >= 6 && days <= 8;
      })
    : undefined;
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
    <Card>
      <CardHeader
        title="Visibility score"
        description="Composite across rankings, AI presence, freshness, and coverage"
        actions={
          <Link
            href={`/dashboard/projects/${projectId}`}
            className={buttonVariants({ variant: "quiet", size: "xs" })}
          >
            What&apos;s this?
          </Link>
        }
      />
      <CardBody>
        {latest ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-[36px] font-semibold tracking-tight text-ink tabular-nums">
                {latest.score}
              </span>
              <span className="text-[13px] text-ink-2">/ 100</span>
              {delta !== null && delta !== 0 && (
                <ValuePill tone={delta > 0 ? "green" : "red"}>
                  <span className="inline-flex items-center gap-1">
                    {delta > 0 ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                    {Math.abs(delta)} WoW
                  </span>
                </ValuePill>
              )}
            </div>

            {trend.length > 1 && (
              <svg
                viewBox={`0 0 ${W} ${H}`}
                className="mt-3 w-full"
                role="img"
                aria-label="30-day visibility score trend"
              >
                <polyline
                  points={pts.join(" ")}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
              </svg>
            )}

            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {Object.entries(COMPONENT_LABELS).map(([key, label]) => {
                const v = typeof components[key] === "number" ? (components[key] as number) : null;
                return (
                  <div key={key} className="rounded-control bg-field p-2.5">
                    <div className="text-[12px] text-ink-2">{label}</div>
                    <div className="mt-0.5 text-[18px] font-semibold text-ink tabular-nums">
                      {v ?? "–"}
                    </div>
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
                      <div
                        className="h-full rounded-full bg-accent transition-[width] duration-300 ease-[cubic-bezier(0.2,0,0,1)]"
                        style={{ width: `${Math.min(100, Math.max(0, v ?? 0))}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <EmptyState
            icon={<Gauge className="size-5" />}
            title="No score yet"
            description="The daily cron computes the visibility score for this project."
          />
        )}
      </CardBody>
    </Card>
  );
}
