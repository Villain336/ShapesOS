// Marketr — O2 Digital PR (Phase 6).
// Opportunity feed (deadline-triaged, same-day urgency), draft workspace
// (brief + pitch-the-gap + quote skeleton + checklist + de-AI status),
// relationship CRM-lite, placements with coverage attribution.
// Humans send everything: Marketr records sends, never sends.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { authorityTablesReady } from "@/lib/authority/db";
import {
  opportunityFeed, listDrafts, listRelationships, listPlacements,
} from "@/lib/authority/pr/service";
import { Badge } from "@/components/vault/shadcn/badge";
import {
  IngestButton, CreateDraftForm, ApproveButton, MarkSentButton,
  RelationshipNoteForm, PlacementForm,
} from "./_components/PrActions";
import {
  Flame, Clock, CalendarDays, CircleDot, Users, Newspaper,
  Rss, ShieldAlert, CheckCircle2, XCircle, PenLine,
} from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Digital PR — Marketr",
  description: "Journalist queries, draft workspace, relationship CRM, coverage attribution. Humans send.",
};

const URGENCY_META = {
  same_day: { icon: Flame, label: "Due today", variant: "destructive" as const },
  within_48h: { icon: Clock, label: "48h", variant: "default" as const },
  this_week: { icon: CalendarDays, label: "This week", variant: "outline" as const },
  open: { icon: CircleDot, label: "Open", variant: "secondary" as const },
  expired: { icon: XCircle, label: "Expired", variant: "secondary" as const },
};

function hoursLabel(h: number | null): string {
  if (h == null) return "no deadline";
  if (h < 0) return `${Math.abs(h)}h overdue`;
  if (h < 24) return `${h}h left`;
  return `${Math.round(h / 24)}d left`;
}

export default async function PrPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const ready = await authorityTablesReady().catch(() => false);
  let feed: Awaited<ReturnType<typeof opportunityFeed>> = [];
  let drafts: Awaited<ReturnType<typeof listDrafts>> = [];
  let relationships: Awaited<ReturnType<typeof listRelationships>> = [];
  let placementData: Awaited<ReturnType<typeof listPlacements>> | null = null;
  if (ready) {
    [feed, drafts, relationships, placementData] = await Promise.all([
      opportunityFeed(workspace.id).catch(() => []),
      listDrafts(workspace.id).catch(() => []),
      listRelationships(workspace.id).catch(() => []),
      listPlacements(workspace.id).catch(() => ({ placements: [], aeoSourceDomains: [] })),
    ]);
  }
  const placements = placementData?.placements ?? [];
  const aeoDomains = placementData?.aeoSourceDomains ?? [];

  return (
    <div className="flex h-full flex-col gap-6 bg-[#FAFAF7] p-4 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-stone-900">Digital PR</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-stone-500">
            Journalist queries aggregated and matched — then a draft workspace with research
            brief, pitch-the-gap, and a de-AI pass. <strong>Humans send everything.</strong>{" "}
            Marketr records sends against a pr_send approval; it never sends on your identity.
          </p>
        </div>
        <IngestButton />
      </div>

      {!ready && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Authority tables are not provisioned yet — this page renders read-only until the Phase 6 migration runs.
        </div>
      )}

      {/* Opportunity feed */}
      <section className="rounded-xl border border-stone-200 bg-white p-4">
        <div className="mb-3 flex items-center gap-2">
          <Rss className="h-4 w-4 text-stone-500" />
          <h2 className="text-sm font-semibold text-stone-900">Opportunity feed</h2>
          <span className="text-xs text-stone-500">{feed.length} open</span>
        </div>
        {feed.length === 0 ? (
          <p className="text-sm text-stone-500">
            No open queries. Run an ingest to pull HARO / Connectively / Qwoted / SOS / HAB2BW / #JournoRequest digests.
          </p>
        ) : (
          <ul className="space-y-2">
            {feed.map((o) => {
              const um = URGENCY_META[o.urgency];
              const UIcon = um.icon;
              return (
                <li key={o.id} className="rounded-lg border border-stone-100 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={um.variant} className="inline-flex items-center gap-1">
                      <UIcon className="h-3 w-3" />
                      {o.urgency === "same_day" ? "Due today" : um.label} · {hoursLabel(o.hoursLeft)}
                    </Badge>
                    <Badge variant="secondary">match {o.matchScore}</Badge>
                    <Badge variant="outline">{o.source}</Badge>
                    <span className="text-sm font-medium text-stone-900">
                      {o.journalist} · {o.outlet}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[13px] leading-snug text-stone-700">{o.queryText}</p>
                  {o.expertiseTags.length > 0 && (
                    <p className="mt-1 font-mono text-[11px] text-stone-400">{o.expertiseTags.join(" · ")}</p>
                  )}
                  {(o.status === "new" || o.status === "matched") && <CreateDraftForm opportunityId={o.id} />}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Draft workspace */}
      <section className="rounded-xl border border-stone-200 bg-white p-4">
        <div className="mb-3 flex items-center gap-2">
          <PenLine className="h-4 w-4 text-stone-500" />
          <h2 className="text-sm font-semibold text-stone-900">Draft workspace</h2>
          <span className="text-xs text-stone-500">{drafts.length} drafts</span>
        </div>
        {drafts.length === 0 ? (
          <p className="text-sm text-stone-500">No drafts yet. Build one from an opportunity above.</p>
        ) : (
          <ul className="space-y-3">
            {drafts.map((d) => {
              const brief = (d.brief as { brief?: Record<string, unknown>; gap?: Record<string, unknown>; deAi?: { passed: boolean; flags: string[]; suggestions: string[] } } | null) ?? {};
              const b = (brief.brief ?? {}) as { recentBeats?: string[]; pitchingGuidelines?: string[]; notes?: string[]; recentArticles?: { title: string; topics: string[] }[] };
              const gap = (brief.gap ?? {}) as { theGap?: string[]; suggestedAngle?: string };
              const deAi = brief.deAi ?? { passed: d.deAiPassed, flags: [], suggestions: [] };
              const checklist = ((d.checklist as { items?: { id: string; label: string; passed: boolean; detail: string }[]; subject?: string } | null)?.items ?? []);
              return (
                <li key={d.id} className="rounded-lg border border-stone-200 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-stone-900">
                      {d.opportunity.journalist} · {d.opportunity.outlet}
                    </span>
                    <Badge variant={d.status === "sent" ? "default" : d.status === "human_approved" ? "outline" : "secondary"}>
                      {d.status.replace("_", " ")}
                    </Badge>
                    <Badge variant={d.deAiPassed ? "default" : "destructive"} className="inline-flex items-center gap-1">
                      {d.deAiPassed ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                      de-AI {d.deAiPassed ? "passed" : "failed"}
                    </Badge>
                  </div>

                  {/* Research brief */}
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer font-medium text-stone-800">Research brief</summary>
                    <div className="mt-1 space-y-1 text-[13px] text-stone-600">
                      {(b.recentBeats?.length ?? 0) > 0 && <p><strong>Beats:</strong> {b.recentBeats!.join(", ")}</p>}
                      {(b.recentArticles?.length ?? 0) > 0 && (
                        <p><strong>Recent:</strong> {b.recentArticles!.map((a) => a.title).join(" · ")}</p>
                      )}
                      {(b.pitchingGuidelines?.length ?? 0) > 0 && (
                        <p><strong>Guidelines:</strong> {b.pitchingGuidelines!.join(" · ")}</p>
                      )}
                      {(b.notes?.length ?? 0) > 0 && <p><strong>Notes:</strong> {b.notes!.join(" · ")}</p>}
                      {(gap.theGap?.length ?? 0) > 0 && (
                        <p><strong>The gap:</strong> {gap.theGap!.join(" ")}</p>
                      )}
                      {gap.suggestedAngle && <p><strong>Angle:</strong> {gap.suggestedAngle}</p>}
                    </div>
                  </details>

                  {/* Quote skeleton */}
                  <details className="mt-1 text-sm">
                    <summary className="cursor-pointer font-medium text-stone-800">Quote skeleton (working scaffold — never send-ready)</summary>
                    <pre className="mt-1 whitespace-pre-wrap rounded bg-stone-50 p-2 font-mono text-[12px] text-stone-700">{d.quoteSkeleton}</pre>
                  </details>

                  {/* Pre-send checklist */}
                  <div className="mt-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Pre-send checklist</p>
                    <ul className="mt-1 space-y-0.5">
                      {checklist.map((c) => (
                        <li key={c.id} className="flex items-start gap-1.5 text-[13px]">
                          {c.passed ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />}
                          <span className={c.passed ? "text-stone-700" : "text-stone-900 font-medium"}>{c.label}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* de-AI flags */}
                  {!d.deAiPassed && deAi.flags.length > 0 && (
                    <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-2 text-[12px] text-red-900">
                      <p className="font-semibold">De-AI pass flagged AI signals — rework before approval:</p>
                      <ul className="mt-1 list-disc pl-4">
                        {deAi.flags.map((f, i) => <li key={i}>{f}</li>)}
                        {deAi.suggestions.map((s, i) => <li key={`s${i}`} className="text-red-700">→ {s}</li>)}
                      </ul>
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    {d.status === "draft" && (
                      <ApproveButton
                        draftId={d.id}
                        disabled={!d.deAiPassed}
                        reason={!d.deAiPassed ? "Blocked until the de-AI pass and checklist clear" : undefined}
                      />
                    )}
                    {d.status === "human_approved" && (
                      <MarkSentButton draftId={d.id} journalist={d.opportunity.journalist} outlet={d.opportunity.outlet} />
                    )}
                    {d.status === "sent" && (
                      <span className="inline-flex items-center gap-1 text-xs text-stone-500">
                        <ShieldAlert className="h-3.5 w-3.5" />
                        Recorded against pr_send approval {d.approvalId ? d.approvalId.slice(0, 8) : "—"}…
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Relationship CRM-lite */}
      <section className="rounded-xl border border-stone-200 bg-white p-4">
        <div className="mb-3 flex items-center gap-2">
          <Users className="h-4 w-4 text-stone-500" />
          <h2 className="text-sm font-semibold text-stone-900">Journalist relationships</h2>
          <span className="text-xs text-stone-500">{relationships.length} journalists</span>
        </div>
        {relationships.length === 0 ? (
          <p className="text-sm text-stone-500">No journalists yet — relationships are created when a draft is built.</p>
        ) : (
          <ul className="space-y-2">
            {relationships.map((r) => {
              const eligible = !r.reengagementEligibleAt || r.reengagementEligibleAt.getTime() <= Date.now();
              return (
                <li key={r.id} className="rounded-lg border border-stone-100 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-stone-900">{r.journalist} · {r.outlet}</span>
                    <Badge variant={r.followUpCount >= 2 ? "destructive" : "secondary"}>
                      {r.followUpCount}/2 follow-ups
                    </Badge>
                    <Badge variant={eligible ? "outline" : "default"}>
                      {eligible ? "re-engageable" : `cooling until ${r.reengagementEligibleAt!.toISOString().slice(0, 10)}`}
                    </Badge>
                  </div>
                  {r.declinationReasons.length > 0 && (
                    <p className="mt-1 text-[12px] text-stone-500">
                      Declinations: {r.declinationReasons.join(" · ")}
                    </p>
                  )}
                  {r.history.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-[12px] text-stone-500">
                      {r.history.slice(-4).reverse().map((h, i) => (
                        <li key={i}>
                          <span className="font-mono text-[11px]">{h.ts.toISOString().slice(0, 10)}</span>{" "}
                          <span className="font-medium">{h.kind.replace("_", " ")}</span> — {h.detail}
                        </li>
                      ))}
                    </ul>
                  )}
                  <RelationshipNoteForm journalist={r.journalist} outlet={r.outlet} />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Placements + attribution */}
      <section className="rounded-xl border border-stone-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Newspaper className="h-4 w-4 text-stone-500" />
            <h2 className="text-sm font-semibold text-stone-900">Coverage &amp; attribution</h2>
            <span className="text-xs text-stone-500">{placements.length} placements</span>
          </div>
          <PlacementForm />
        </div>
        {placements.length === 0 ? (
          <p className="text-sm text-stone-500">No placements yet. Record one when a pitch lands.</p>
        ) : (
          <ul className="space-y-2">
            {placements.map((p) => {
              const impact = (p.impact as { impact?: { score?: number; notes?: string[] } } | null)?.impact;
              return (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-stone-100 px-3 py-2">
                  <div className="min-w-0">
                    <Link href={p.url} target="_blank" className="truncate text-sm font-medium text-stone-900 hover:underline">
                      {p.outlet}
                    </Link>
                    <p className="truncate font-mono text-[11px] text-stone-400">{p.url}</p>
                  </div>
                  <Badge variant="outline">impact {impact?.score ?? "—"}/100</Badge>
                </li>
              );
            })}
          </ul>
        )}
        {aeoDomains.length > 0 && (
          <div className="mt-3 rounded-lg bg-stone-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">
              AEO source list (placed domains — consumable by the AEO source-impact scorer)
            </p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {aeoDomains.map((d) => (
                <Badge key={d.domain} variant="secondary" className="font-mono">
                  {d.domain} ×{d.placements}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
