// Marketr — Phase 8 G2: campaign detail.
// House pattern (Creative Studio): violet tabs (layout), dense tables,
// stone info notes, light mode, Lucide icons. Styling only — no data changes.
// Sections: 12-stage pipeline view, linked fragments with provenance labels,
// roll-up report, link manager.

import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import {
  getCampaign, ancestorChain, campaignReport, listChildren, normalizeStages,
} from "@/lib/substrate/campaigns/store";
import { scanWorkspaceFragments } from "@/lib/substrate/campaigns/fragments";
import { withCampaignScope } from "@/lib/substrate/campaigns/rls";
import {
  CAMPAIGN_STAGE_LABELS,
  LINKED_TYPE_LABELS,
  type CampaignStageKey,
} from "@/lib/substrate/campaigns/types";
import { campaignTablesReady } from "@/app/api/substrate/_lib";
import {
  AttachLinkForm, CampaignStatusSelect, NewCampaignForm, StageStatusSelect, UnlinkButton,
  type FragmentOption,
} from "../client-actions";
import { ChevronRight, AlertTriangle } from "lucide-react";
import {
  Chip,
  PageTitle,
  Section,
  infoNoteCls,
  rowCls,
  tableShell,
  thCls,
  theadCls,
} from "../../ui";

export const dynamic = "force-dynamic";

const STAGE_TONE: Record<string, "slate" | "violet" | "green" | "red"> = {
  not_started: "slate",
  in_progress: "violet",
  complete: "green",
  blocked: "red",
  skipped: "slate",
};

const STATUS_TONE: Record<string, "violet" | "green" | "amber" | "slate"> = {
  draft: "violet",
  active: "green",
  paused: "amber",
  complete: "slate",
  archived: "slate",
};

function fmtCents(c: number | null): string {
  if (c === null || c === undefined) return "—";
  return `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function fmtVal(v: number | string | null): string {
  if (v === null || v === undefined) return "—";
  return typeof v === "number" ? v.toLocaleString("en-US") : v;
}

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  if (!(await campaignTablesReady())) redirect("/dashboard");

  let campaign, ancestors, report, children;
  try {
    [campaign, ancestors, report, children] = await Promise.all([
      getCampaign(workspace.id, id),
      ancestorChain(workspace.id, id),
      campaignReport(workspace.id, id),
      listChildren(workspace.id, id),
    ]);
  } catch {
    notFound();
  }

  const stages = normalizeStages(campaign.stages);
  const linkedIds = new Set(campaign.links.map((l) => `${l.linkedType}:${l.linkedId}`));
  const allFragments = await withCampaignScope(workspace.id, (tx) => scanWorkspaceFragments(tx, workspace.id));
  const attachOptions: FragmentOption[] = allFragments
    .filter((f) => !linkedIds.has(`${f.linkedType}:${f.linkedId}`))
    .map((f) => ({ linkedType: f.linkedType, linkedId: f.linkedId, displayName: f.displayName }))
    .slice(0, 300);
  const depth = ancestors.length + 1;
  const canNest = depth < 3;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <nav className="mb-2 flex items-center gap-1 text-xs text-muted" aria-label="Breadcrumb">
          <Link href="/dashboard/substrate/campaigns" className="hover:underline">Campaigns</Link>
          {ancestors.map((a) => (
            <span key={a.id} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3" />
              <Link href={`/dashboard/substrate/campaigns/${a.id}`} className="hover:underline">{a.name}</Link>
            </span>
          ))}
        </nav>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <PageTitle
            title={campaign.name}
            subtitle={
              <>
                Objective: {campaign.objective.replace("_", " ")} · Level {depth} of 3
                {campaign.createdBy ? ` · created by ${campaign.createdBy}` : ""} ·{" "}
                <Chip tone={STATUS_TONE[campaign.status] ?? "slate"}>{campaign.status}</Chip>
              </>
            }
          />
          <div className="flex shrink-0 items-center gap-1.5">
            <Chip>
              {campaign.links.length} fragment{campaign.links.length === 1 ? "" : "s"}
            </Chip>
            <Chip>Roll-up {fmtCents(campaign.budgetRollupCents)}</Chip>
            <CampaignStatusSelect campaignId={campaign.id} value={campaign.status} />
          </div>
        </div>
        <div className={`${infoNoteCls} mt-3`}>
          <span className="font-medium text-ink">Money note. </span>
          The budget roll-up is a reporting convenience (per-fragment declared budgets/spend) —
          not a spending envelope. Nothing on this page can move money (§3.1).
        </div>
      </div>

      {/* 12-stage pipeline */}
      <Section
        title="Lifecycle pipeline"
        description="The 12 master-plan stages. Attaching a fragment flips its stage to in-progress; status is otherwise human-driven."
      >
        <div className={tableShell}>
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className={theadCls}>
                <th className={thCls}>Stage</th>
                <th className={thCls}>Status</th>
                <th className={thCls}>Linked fragments</th>
                <th className={thCls}>Set status</th>
              </tr>
            </thead>
            <tbody>
              {stages.map((s) => (
                <tr key={s.key} className={rowCls}>
                  <td className="px-3 py-2 font-medium text-ink">
                    {CAMPAIGN_STAGE_LABELS[s.key as CampaignStageKey] ?? s.key}
                  </td>
                  <td className="px-3 py-2">
                    <Chip tone={STAGE_TONE[s.status] ?? "slate"}>{s.status.replace("_", " ")}</Chip>
                  </td>
                  <td className="px-3 py-2 text-muted">
                    {s.linkedRefs.length > 0 ? (
                      <ul className="space-y-0.5">
                        {s.linkedRefs.map((r) => (
                          <li key={`${r.linkedType}:${r.linkedId}`} className="text-xs">
                            <span className="font-medium text-muted">{LINKED_TYPE_LABELS[r.linkedType]}</span>
                            {" · "}
                            {report.fragments.find((f) => f.linkedType === r.linkedType && f.linkedId === r.linkedId)?.displayName ?? r.linkedId.slice(0, 8)}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-xs text-subtle">No linked fragments yet.</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <StageStatusSelect campaignId={campaign.id} stageKey={s.key} value={s.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Linked fragments */}
      <Section
        title="Linked fragments"
        description="Each link is a first-class row with provenance. Unlinking is surgical — fragment rows are never touched."
      >
        {report.fragments.length === 0 ? (
          <p className="text-[13px] text-muted">
            No fragments linked yet. Attach one below, or run the backfill proposer on the Link proposals tab.
          </p>
        ) : (
          <ul>
            {report.fragments.map((f) => (
              <li key={f.linkId} className="border-b border-line py-3 first:pt-0 last:border-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-ink">{f.displayName}</div>
                    <p className="mt-0.5 text-xs text-muted">
                      {LINKED_TYPE_LABELS[f.linkedType]} · role {f.role} · source {f.linkSource.replace("_", " ")}
                      {f.stageKeys.length > 0 ? ` · stages: ${f.stageKeys.map((k) => CAMPAIGN_STAGE_LABELS[k as CampaignStageKey] ?? k).join(", ")}` : ""}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      <span className="font-medium text-muted">Provenance:</span> table <code>{f.provenance.table}</code>
                      {" · "}{f.provenance.notes.join("; ")}
                    </p>
                    {f.platformRef ? (
                      <p className="mt-1 text-xs text-muted">
                        <span className="font-medium text-muted">Platform ref (opaque):</span>{" "}
                        <code className="break-all">{JSON.stringify(f.platformRef)}</code>
                      </p>
                    ) : null}
                  </div>
                  <UnlinkButton campaignId={campaign.id} linkId={f.linkId} label={f.displayName} />
                </div>
                {f.metrics.length > 0 ? (
                  <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
                    {f.metrics.map((m) => (
                      <div key={m.key} className="text-xs">
                        <dt className="text-muted">{m.label}</dt>
                        <dd className="font-medium text-ink">{m.key === "spend_cents" ? fmtCents(typeof m.value === "number" ? m.value : null) : fmtVal(m.value)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 border-t border-line pt-4">
          <h3 className="mb-2 text-[13px] font-medium text-ink">Attach a fragment</h3>
          {attachOptions.length === 0 ? (
            <p className="text-[13px] text-muted">Every fragment in this workspace is already linked.</p>
          ) : (
            <AttachLinkForm campaignId={campaign.id} fragments={attachOptions} />
          )}
        </div>
      </Section>

      {/* Roll-up report */}
      <Section
        title="Roll-up report"
        description="Per-fragment metrics with provenance labels. Totals carry explicit semantics notes — semantically-different metrics are never silently summed."
      >
        {report.warnings.length > 0 ? (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-needs bg-needs-tint px-3 py-2 text-[13px] text-ink">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <ul className="space-y-1">
              {report.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {report.totals.length === 0 ? (
          <p className="text-[13px] text-muted">No summable metrics on the linked fragments yet.</p>
        ) : (
          <div className={tableShell}>
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className={theadCls}>
                  <th className={thCls}>Metric</th>
                  <th className={thCls}>Total</th>
                  <th className={thCls}>Semantics</th>
                  <th className={thCls}>From fragments</th>
                </tr>
              </thead>
              <tbody>
                {report.totals.map((t) => (
                  <tr key={t.key} className={rowCls}>
                    <td className="px-3 py-2 font-medium text-ink">{t.key.replace(/_/g, " ")}</td>
                    <td className="px-3 py-2 font-semibold tabular-nums text-ink">
                      {t.key === "spend_cents" ? fmtCents(t.value) : t.value.toLocaleString("en-US")}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">{t.semantics}</td>
                    <td className="px-3 py-2">
                      <ul className="space-y-0.5">
                        {t.provenance.map((p, i) => (
                          <li key={i} className="text-xs text-muted">
                            {p.from}:{" "}
                            <span className="font-medium text-ink">
                              {t.key === "spend_cents" ? fmtCents(p.value) : p.value.toLocaleString("en-US")}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted">
          Generated {new Date(report.generatedAt).toLocaleString()} · metrics labeled at the fragment level;
          no "conversions" total is produced because platform conversions and CRM closed-won are different things.
        </p>
      </Section>

      {/* Sub-campaigns */}
      <Section
        title={`Sub-campaigns (${children.length})`}
        description={canNest ? "HubSpot-style hierarchy — up to 3 levels. A 4th level is rejected." : "Maximum depth (3 levels) reached — no further nesting."}
      >
        {children.length > 0 ? (
          <ul>
            {children.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 border-b border-line py-2 last:border-0">
                <Link href={`/dashboard/substrate/campaigns/${c.id}`} className="text-[13px] font-medium text-ink hover:underline">
                  {c.name}
                </Link>
                <Chip tone={STATUS_TONE[c.status] ?? "slate"}>{c.status}</Chip>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted">No sub-campaigns.</p>
        )}
        {canNest ? (
          <div className="mt-4 border-t border-line pt-4">
            <h3 className="mb-2 text-[13px] font-medium text-ink">Create sub-campaign</h3>
            <NewCampaignForm parentId={campaign.id} />
          </div>
        ) : null}
      </Section>
    </div>
  );
}
