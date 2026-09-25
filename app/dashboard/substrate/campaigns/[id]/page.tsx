// Marketr — Phase 8 G2: campaign detail.
// SPEC-PHASE8.md §6: campaign detail — 12-stage pipeline view, linked
// fragments with provenance labels, roll-up report, link manager.

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
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { Badge } from "@/components/vault/shadcn/badge";
import { campaignTablesReady } from "@/app/api/substrate/_lib";
import {
  AttachLinkForm, CampaignStatusSelect, NewCampaignForm, StageStatusSelect, UnlinkButton,
  type FragmentOption,
} from "../client-actions";
import { ChevronRight } from "lucide-react";

export const dynamic = "force-dynamic";

const STAGE_BADGE: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  not_started: "secondary",
  in_progress: "default",
  complete: "secondary",
  blocked: "destructive",
  skipped: "outline",
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
    <div className="space-y-6">
      {/* Header */}
      <div>
        <nav className="mb-2 flex items-center gap-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
          <Link href="/dashboard/substrate/campaigns" className="hover:underline">Campaigns</Link>
          {ancestors.map((a) => (
            <span key={a.id} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3" />
              <Link href={`/dashboard/substrate/campaigns/${a.id}`} className="hover:underline">{a.name}</Link>
            </span>
          ))}
        </nav>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{campaign.name}</h1>
            <p className="text-sm text-muted-foreground">
              Objective: {campaign.objective.replace("_", " ")} · Level {depth} of 3
              {campaign.createdBy ? ` · created by ${campaign.createdBy}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="outline">{campaign.links.length} fragment{campaign.links.length === 1 ? "" : "s"}</Badge>
            <Badge variant="outline">Roll-up {fmtCents(campaign.budgetRollupCents)}</Badge>
            <CampaignStatusSelect campaignId={campaign.id} value={campaign.status} />
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          The budget roll-up is a reporting convenience (per-fragment declared budgets/spend) — not a
          spending envelope. Nothing on this page can move money (§3.1).
        </p>
      </div>

      {/* 12-stage pipeline */}
      <Card>
        <CardHeader
          title="Lifecycle pipeline"
          description="The 12 master-plan stages. Attaching a fragment flips its stage to in-progress; status is otherwise human-driven."
        />
        <CardBody>
          <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {stages.map((s) => (
              <li key={s.key} className="rounded-lg border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-medium">{CAMPAIGN_STAGE_LABELS[s.key as CampaignStageKey] ?? s.key}</div>
                  <Badge variant={STAGE_BADGE[s.status] ?? "secondary"}>{s.status.replace("_", " ")}</Badge>
                </div>
                {s.linkedRefs.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {s.linkedRefs.map((r) => (
                      <li key={`${r.linkedType}:${r.linkedId}`} className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{LINKED_TYPE_LABELS[r.linkedType]}</span>
                        {" · "}
                        {report.fragments.find((f) => f.linkedType === r.linkedType && f.linkedId === r.linkedId)?.displayName ?? r.linkedId.slice(0, 8)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">No linked fragments yet.</p>
                )}
                <div className="mt-2">
                  <StageStatusSelect campaignId={campaign.id} stageKey={s.key} value={s.status} />
                </div>
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>

      {/* Linked fragments */}
      <Card>
        <CardHeader
          title="Linked fragments"
          description="Each link is a first-class row with provenance. Unlinking is surgical — fragment rows are never touched."
        />
        <CardBody className="space-y-4">
          {report.fragments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No fragments linked yet. Attach one below, or run the backfill proposer on the Link proposals tab.
            </p>
          ) : (
            <ul className="divide-y">
              {report.fragments.map((f) => (
                <li key={f.linkId} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{f.displayName}</div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {LINKED_TYPE_LABELS[f.linkedType]} · role {f.role} · source {f.linkSource.replace("_", " ")}
                        {f.stageKeys.length > 0 ? ` · stages: ${f.stageKeys.map((k) => CAMPAIGN_STAGE_LABELS[k as CampaignStageKey] ?? k).join(", ")}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">Provenance:</span> table <code>{f.provenance.table}</code>
                        {" · "}{f.provenance.notes.join("; ")}
                      </p>
                      {f.platformRef ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">Platform ref (opaque):</span>{" "}
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
                          <dt className="text-muted-foreground">{m.label}</dt>
                          <dd className="font-medium">{m.key === "spend_cents" ? fmtCents(typeof m.value === "number" ? m.value : null) : fmtVal(m.value)}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <div className="border-t pt-4">
            <h3 className="mb-2 text-sm font-medium">Attach a fragment</h3>
            {attachOptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Every fragment in this workspace is already linked.</p>
            ) : (
              <AttachLinkForm campaignId={campaign.id} fragments={attachOptions} />
            )}
          </div>
        </CardBody>
      </Card>

      {/* Roll-up report */}
      <Card>
        <CardHeader
          title="Roll-up report"
          description="Per-fragment metrics with provenance labels. Totals carry explicit semantics notes — semantically-different metrics are never silently summed."
        />
        <CardBody className="space-y-4">
          {report.warnings.length > 0 ? (
            <ul className="space-y-1">
              {report.warnings.map((w, i) => (
                <li key={i} className="text-sm text-amber-700">{w}</li>
              ))}
            </ul>
          ) : null}
          {report.totals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No summable metrics on the linked fragments yet.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {report.totals.map((t) => (
                <div key={t.key} className="rounded-lg border p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="text-sm font-medium">{t.key.replace(/_/g, " ")}</div>
                    <div className="text-lg font-semibold">
                      {t.key === "spend_cents" ? fmtCents(t.value) : t.value.toLocaleString("en-US")}
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{t.semantics}</p>
                  <ul className="mt-2 space-y-0.5">
                    {t.provenance.map((p, i) => (
                      <li key={i} className="text-xs text-muted-foreground">
                        {p.from}: <span className="font-medium text-foreground">{t.key === "spend_cents" ? fmtCents(p.value) : p.value.toLocaleString("en-US")}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Generated {new Date(report.generatedAt).toLocaleString()} · metrics labeled at the fragment level;
            no "conversions" total is produced because platform conversions and CRM closed-won are different things.
          </p>
        </CardBody>
      </Card>

      {/* Sub-campaigns */}
      <Card>
        <CardHeader
          title={`Sub-campaigns (${children.length})`}
          description={canNest ? "HubSpot-style hierarchy — up to 3 levels. A 4th level is rejected." : "Maximum depth (3 levels) reached — no further nesting."}
        />
        <CardBody className="space-y-4">
          {children.length > 0 ? (
            <ul className="divide-y">
              {children.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                  <Link href={`/dashboard/substrate/campaigns/${c.id}`} className="text-sm font-medium hover:underline">
                    {c.name}
                  </Link>
                  <Badge variant="secondary">{c.status}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No sub-campaigns.</p>
          )}
          {canNest ? (
            <div className="border-t pt-4">
              <h3 className="mb-2 text-sm font-medium">Create sub-campaign</h3>
              <NewCampaignForm parentId={campaign.id} />
            </div>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
