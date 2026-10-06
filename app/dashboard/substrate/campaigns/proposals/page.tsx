// Marketr — Phase 8 G2: backfill proposal review queue.
// docs/specs/SPEC-PHASE8.md §2 G2, §9.7: precision over recall — every proposal is
// human-confirmed; rejected candidates are recorded as negative signals.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { listProposals } from "@/lib/substrate/campaigns/store";
import { LINKED_TYPE_LABELS } from "@/lib/substrate/campaigns/types";
import { Card, CardBody, CardHeader } from "@/components/vault/Card";
import { EmptyState } from "@/components/vault/EmptyState";
import { campaignTablesReady } from "@/app/api/substrate/_lib";
import { ProposalActions, RunScanButton } from "../client-actions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Link proposals — ShapesOS",
  description: "Human review queue for backfill link proposals. Zero auto-links — precision over recall.",
};

export default async function ProposalsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) redirect("/dashboard/substrate/campaigns");
  if (!(await campaignTablesReady())) redirect("/dashboard");

  const [pending, decided] = await Promise.all([
    listProposals(workspace.id, { status: "pending" }),
    listProposals(workspace.id),
  ]);
  const resolved = decided.filter((p) => p.status !== "pending").slice(0, 50);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="aos-heading">Link proposals</h1>
          <p className="text-sm text-muted">
            The backfill proposer scans fragment tables and suggests links by naming convention,
            utm_campaign, date proximity, and shared creative. Every proposal needs a human decision —
            nothing auto-links, ever.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <span
            className={
              pending.length > 0
                ? "inline-flex items-center rounded-full bg-needs px-2 py-0.5 text-xs font-medium text-ink"
                : "inline-flex items-center rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted shadow-control"
            }
          >
            {pending.length} pending
          </span>
        </div>
      </div>

      <Card>
        <CardHeader
          title="Run a backfill scan"
          description="Link-not-replace: scans all eight fragment tables in this workspace. Fragment rows are never touched — only proposal rows are written."
          actions={<RunScanButton />}
        />
      </Card>

      <Card>
        <CardHeader title="Pending review" description="Approve to materialize the link (with provenance) — reject to record a negative signal." />
        <CardBody>
          {pending.length === 0 ? (
            <EmptyState
              title="Queue is empty"
              description="Run a backfill scan to propose links between historical fragments and campaigns."
            />
          ) : (
            <ul className="divide-y">
              {pending.map((p) => {
                const signals = (p.matchSignals ?? []) as Array<{ signal: string; detail: string; score: number }>;
                return (
                  <li key={p.id} className="py-4 first:pt-0 last:pb-0">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">
                          [{LINKED_TYPE_LABELS[p.linkedType]}] →{" "}
                          {p.campaign ? (
                            <Link href={`/dashboard/substrate/campaigns/${p.campaign.id}`} className="hover:underline">
                              {p.campaign.name}
                            </Link>
                          ) : (
                            <span className="text-muted">(campaign removed)</span>
                          )}
                        </div>
                        <ul className="mt-1 space-y-0.5">
                          {signals.map((s, i) => (
                            <li key={i} className="text-xs text-muted">
                              <span className="font-medium text-ink">{s.signal.replace("_", " ")}</span>
                              {" · "}{s.detail}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="inline-flex items-center whitespace-nowrap rounded-full bg-paper px-1.5 py-0.5 text-[0.625rem] font-medium leading-tight text-muted shadow-control">{Math.round(p.confidence * 100)}% confidence</span>
                        <ProposalActions proposalId={p.id} />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      {resolved.length > 0 ? (
        <Card>
          <CardHeader title="Recently decided" description="Approvals and rejections — the audit trail of human confirmation." />
          <CardBody>
            <ul className="divide-y">
              {resolved.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0 text-sm">
                    <span className="text-muted">[{LINKED_TYPE_LABELS[p.linkedType]}]</span>{" "}
                    {p.campaign?.name ?? "(campaign removed)"}
                    <span className="text-xs text-muted">
                      {" · "}{p.decidedBy ?? "unknown"}{" · "}
                      {p.decidedAt ? new Date(p.decidedAt).toLocaleString() : ""}
                    </span>
                  </div>
                  <span
              className={
                p.status === "approved"
                  ? "inline-flex items-center whitespace-nowrap rounded-full bg-done px-1.5 py-0.5 text-[0.625rem] font-medium leading-tight text-white"
                  : "inline-flex items-center whitespace-nowrap rounded-full bg-paper px-1.5 py-0.5 text-[0.625rem] font-medium leading-tight text-muted shadow-control"
              }
            >
              {p.status}
            </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
