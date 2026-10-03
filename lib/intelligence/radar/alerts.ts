// Marketr — Phase 10 M2: alert copy + routing.
//
// Headline pattern: "Google's August 18 Spam Update hit 3 of your pages."
// The alert names the event, the affected pages, the queries that moved —
// and carries a VERIFICATION checklist (never auto-fix prescriptions;
// attribution is honest about uncertainty — docs/specs/SPEC-PHASE10.md §M2).
//
// Routing: emits through the Phase 9 alert hub (lib/alerts/evaluate.ts) on
// the new "platform_rollout" trigger (registered in lib/alerts/triggers.ts).
// Rules match on it like any other trigger; the structured RadarAlert is
// ALSO returned so the UI can render it even when no rules exist yet.

import { emitAlert } from "@/lib/alerts/evaluate";
import type { CorrelatedImpact, RadarAlert } from "./types";

export interface RolloutEventLike {
  id: string;
  title: string;
  startedAt: Date | null;
  url: string | null;
}

export interface ProjectImpactInput {
  projectId: string;
  domain: string;
  impacts: CorrelatedImpact[];
}

export const RADAR_TRIGGER_KEY = "platform_rollout";

/** "August 2026 spam update" → "August 2026 Spam Update". */
export function titleCaseUpdateName(title: string): string {
  return title
    .split(/\s+/)
    .map((w) =>
      /^(core|spam|discover)$/i.test(w) ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w,
    )
    .join(" ");
}

export function eventDateLabel(startedAt: Date | null): string {
  if (!startedAt) return "";
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${months[startedAt.getUTCMonth()]} ${startedAt.getUTCDate()}`;
}

const VERIFICATION_CHECKLIST = [
  "Confirm in Search Console: compare the same pages' clicks/impressions 7 days before vs. after the rollout window — the radar's signal should be visible there too.",
  "Check shape: update hits look the same across unrelated queries on the same pages; site problems cluster on one template or one page type.",
  "Rule out confounders first: recent deploys, robots.txt changes, de-indexed or crawled-not-indexed pages (URL Inspection), and seasonal demand.",
  "Wait until the rollout is marked complete before changing anything — reacting mid-rollout misattributes normal ranking churn to the update.",
  "Document the baseline (this event's impacted pages + queries) so recovery can be measured against it later.",
] as const;

/**
 * Build the structured alert for one confirmed rollout. Pure function —
 * the unit-test surface. Only call with rollout events (the caller guards).
 */
export function buildRolloutAlert(
  event: RolloutEventLike,
  projects: ProjectImpactInput[],
): RadarAlert {
  const withImpacts = projects.filter((p) => p.impacts.length > 0);
  const totalPages = new Set(
    withImpacts.flatMap((p) => p.impacts.map((i) => `${i.projectId}::${i.page}`)),
  ).size;
  const name = titleCaseUpdateName(event.title);
  const date = eventDateLabel(event.startedAt);
  const dateBits = date ? ` ${date}` : "";
  const pageNoun = totalPages === 1 ? "page" : "pages";
  const headline =
    totalPages > 0
      ? `Google's${dateBits} ${name} hit ${totalPages} of your ${pageNoun}.`
      : `Google's${dateBits} ${name} is rolling out — none of your tracked pages moved beyond the noise band yet.`;

  return {
    platformEventId: event.id,
    eventTitle: event.title,
    eventStartedAt: event.startedAt ? event.startedAt.toISOString() : null,
    headline,
    affectedProjects: withImpacts.map((p) => {
      const byPage = new Map<string, CorrelatedImpact[]>();
      for (const i of p.impacts) {
        const arr = byPage.get(i.page) ?? [];
        arr.push(i);
        byPage.set(i.page, arr);
      }
      return {
        projectId: p.projectId,
        domain: p.domain,
        impactedPages: [...byPage.entries()]
          .map(([page, rows]) => {
            const top = rows.reduce((a, b) => (b.impactScore >= a.impactScore ? b : a));
            const direction =
              rows.every((r) => r.direction === rows[0].direction) ? rows[0].direction : "mixed";
            return {
              page,
              impactScore: top.impactScore,
              confidenceBand: top.confidenceBand,
              direction,
              movedQueries: rows
                .sort((a, b) => b.impactScore - a.impactScore)
                .map((r) => ({
                  query: r.query,
                  deltaClicks: r.deltaClicks,
                  deltaImpressions: r.deltaImpressions,
                  deltaPosition: r.deltaPosition,
                })),
            };
          })
          .sort((a, b) => b.impactScore - a.impactScore),
      };
    }),
    checklist: [...VERIFICATION_CHECKLIST],
  };
}

/** Only rollout events may produce alerts — the regression-test surface. */
export function isAlertableEventType(eventType: string): boolean {
  return eventType === "rollout";
}

/** Route one alert through the Phase 9 alert hub. Never throws. */
export async function emitRolloutAlert(
  workspaceId: string,
  alert: RadarAlert,
): Promise<{ emitted: boolean; outcomes: string[]; error: string | null }> {
  try {
    const outcomes = await emitAlert({
      workspaceId,
      trigger: RADAR_TRIGGER_KEY,
      severity: alert.affectedProjects.length > 0 ? "warn" : "info",
      title: alert.headline,
      body: [
        alert.headline,
        "",
        ...alert.affectedProjects.flatMap((p) => [
          `${p.domain} — ${p.impactedPages.length} page(s):`,
          ...p.impactedPages.map(
            (pg) =>
              `  • ${pg.page} (${pg.direction}, impact ${pg.impactScore}, band [${pg.confidenceBand[0]}, ${pg.confidenceBand[1]}])`,
          ),
        ]),
        "",
        "Verify before acting:",
        ...alert.checklist.map((c, i) => `${i + 1}. ${c}`),
      ].join("\n"),
      link: "/dashboard/intelligence/radar",
      dedupKey: `platform_rollout:${alert.platformEventId}:${workspaceId}`,
    });
    const statuses = outcomes.map((o) => `${o.ruleName}:${o.status}`);
    return {
      emitted: outcomes.some((o) => o.status === "sent" || o.status === "queued"),
      outcomes: statuses,
      error: null,
    };
  } catch (err) {
    return {
      emitted: false,
      outcomes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
