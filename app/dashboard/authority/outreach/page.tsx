// Marketr — O1 outreach engine (Phase 6).
// Campaigns list + ladder-depth config per campaign, the depth-3 enablement
// checklist as a visible gate, and the deliverability dashboard (reputation,
// spam rate, bounce, warmup per sending domain). Light mode, no emoji.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, roleAtLeast } from "@/lib/authz";
import { authorityTablesReady, authorityApprovals } from "@/lib/authority/db";
import {
  prismaCampaignStore, prismaDomainStore, prismaProspectStore, prismaSequenceStore,
  deliverabilityForWorkspace, evaluateDomain,
} from "@/lib/authority/outreach";
import {
  Mail, Gauge, Send, Layers, CircleCheck, CircleX, Clock,
} from "lucide-react";
import {
  CreateCampaignForm, ActivateShallowButton, Depth3ActivationPanel,
  CreateDomainForm, UpdateDomainChecks,
} from "./_components/OutreachActions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Outreach — Marketr",
  description: "Guest-post outreach engine: 3-depth ladder, depth-3 gating, deliverability.",
};


// Domain reputation is analytic info, never status-colored — neutral chips.
const REPUTATION_CHIP = {
  high: "border-line bg-paper text-muted shadow-control",
  medium: "border-line bg-paper text-muted shadow-control",
  low: "border-line bg-paper text-muted shadow-control",
  bad: "border-line bg-paper text-muted shadow-control",
} as const;

function chip(text: string, cls: string) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${cls}`}>
      {text}
    </span>
  );
}

const DEPTH_META = {
  1: { label: "Prospecting only", hint: "Discovery + scoring. Zero sending code paths." },
  2: { label: "Drafts for human send", hint: "Every send is a human click + per-send approval. Drafts expire 14d." },
  3: { label: "Automated pitching", hint: "Checklist + two-person approval + rail checks. Caps enforced." },
} as const;

// The six code-enforced depth-3 checklist items (the 7th — CAN-SPAM footer on
// every template — is enforced at draft time, not on the domain).
const CHECKLIST_ITEMS = [
  { code: "primary_domain", label: "Secondary domain (primary domains never cold-send)" },
  { code: "gmail_free", label: "No Gmail free accounts (Workspace/M365 or partner inboxes)" },
  { code: "warmup_incomplete", label: "Warmup ≥ 30 days with ramp history" },
  { code: "auth_missing", label: "SPF + DKIM verified" },
  { code: "dmarc_weak", label: "DMARC p=quarantine or p=reject" },
  { code: "tracking_cname", label: "Custom tracking CNAME set" },
] as const;

function ChecklistGate({ failures }: { failures: { code: string; message: string }[] }) {
  const failed = new Set(failures.map((f) => f.code));
  return (
    <div className="mt-2 rounded-lg border border-line bg-paper p-3">
      <p className="mb-2 text-[11px] font-semibold text-muted">
        Depth-3 enablement checklist — the gate, not a toggle
      </p>
      <ul className="space-y-1.5">
        {CHECKLIST_ITEMS.map((item) => {
          const pass = !failed.has(item.code);
          const detail = failures.find((f) => f.code === item.code);
          return (
            <li key={item.code} className="flex items-start gap-2 text-xs">
              {pass ? (
                <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink" />
              ) : (
                <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-failed-text" />
              )}
              <span className={pass ? "text-muted" : "font-medium text-failed-text"}>
                {item.label}
                {!pass && detail && <span className="block font-normal text-failed-text">{detail.message}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 flex items-start gap-1.5 text-[11px] text-muted">
        <Clock className="mt-0.5 h-3 w-3 shrink-0" />
        One-click unsubscribe + physical mailing address are enforced on every template at draft time (CAN-SPAM).
      </p>
    </div>
  );
}

const REPUTATION_META = {
  high: { label: "High" },
  medium: { label: "Medium" },
  low: { label: "Low" },
  bad: { label: "Bad" },
} as const;

export default async function OutreachPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  const canEdit = roleAtLeast(membership.role, "editor");

  const ready = await authorityTablesReady().catch(() => false);
  let campaigns: Awaited<ReturnType<ReturnType<typeof prismaCampaignStore>["list"]>> = [];
  let domains: Awaited<ReturnType<ReturnType<typeof prismaDomainStore>["list"]>> = [];
  let deliverability: Awaited<ReturnType<typeof deliverabilityForWorkspace>> = [];
  let pendingApprovals: Awaited<ReturnType<typeof authorityApprovals.list>> = [];
  if (ready) {
    const campaignStore = prismaCampaignStore();
    const domainStore = prismaDomainStore();
    const sequenceStore = prismaSequenceStore();
    campaigns = await campaignStore.list(workspace.id).catch(() => []);
    domains = await domainStore.list(workspace.id).catch(() => []);
    deliverability = await deliverabilityForWorkspace(
      {
        domains: domainStore,
        sequences: sequenceStore,
        campaigns: { list: (w: string) => campaignStore.list(w) },
      },
      workspace.id,
    ).catch(() => []);
    pendingApprovals = await authorityApprovals.list(workspace.id, "pending", 50).catch(() => []);
  }
  const domainById = new Map(domains.map((d) => [d.id, d]));
  const pendingDepth3 = new Map(
    pendingApprovals
      .filter((a) => a.type === "depth3_activation")
      .map((a) => [(a.bindingJson as { campaignId?: string }).campaignId ?? "", a] as const),
  );

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="aos-heading">Outreach</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-muted">
            Guest-post outreach on the 3-depth ladder: prospecting → human-sent drafts → gated
            automated pitching. Nothing sends without its depth&apos;s trust gate.
          </p>
        </div>
        {canEdit && <CreateCampaignForm domains={domains.map((d) => ({ id: d.id, domain: d.domain }))} />}
      </div>

      {!ready && (
        <div className="rounded-lg border border-needs bg-needs-tint p-4 text-sm text-ink">
          Authority tables are not provisioned yet (migration pending). The engine UI is disabled until then.
        </div>
      )}

      {/* Campaigns */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
          <Layers className="h-4 w-4" /> Campaigns
        </h2>
        {campaigns.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line bg-paper p-8 text-center text-sm text-muted">
            No campaigns yet. Create one to start prospecting — depth 1 never sends.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-paper">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-line bg-paper/60 text-[11px] text-muted">
                  <th className="px-3 py-2 font-medium">Campaign</th>
                  <th className="px-3 py-2 font-medium">Depth</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Cap</th>
                  <th className="px-3 py-2 font-medium">Sending domain</th>
                  <th className="px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => {
                  const domain = c.sendingDomainId ? domainById.get(c.sendingDomainId) : null;
                  const checklist = domain ? evaluateDomain(domain) : null;
                  const pending = pendingDepth3.get(c.id) ?? null;
                  const depthMeta = DEPTH_META[c.depth as 1 | 2 | 3];
                  return (
                    <>
                      <tr key={c.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                        <td className="px-3 py-2">
                          <Link
                            href={`/dashboard/authority/outreach/campaigns/${c.id}`}
                            className="font-medium text-ink hover:underline"
                          >
                            {c.name}
                          </Link>
                          <span className="block text-[11px] text-muted">{depthMeta.hint}</span>
                        </td>
                        <td className="px-3 py-2">
                          {chip(`Depth ${c.depth} — ${depthMeta.label}`, "border-line bg-paper text-muted")}
                        </td>
                        <td className="px-3 py-2">
                          {chip(c.status, "border-line bg-paper text-muted shadow-control")}
                        </td>
                        <td className="px-3 py-2 text-muted">≤ {c.dailyCap}/day</td>
                        <td className="px-3 py-2">
                          {domain ? (
                            <span className="text-muted">
                              {domain.domain}{" "}
                              {domain.isPrimary && chip("primary — never cold-sends", "border-failed bg-failed-tint text-failed-text")}
                            </span>
                          ) : (
                            <span className="text-subtle">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {canEdit && c.depth !== 3 && c.status === "draft" && <ActivateShallowButton campaignId={c.id} />}
                          {c.depth === 3 && c.status === "active" && (
                            <span className="flex items-center gap-1 text-[11px] font-medium text-ink">
                              <Send className="h-3 w-3" /> live within caps
                            </span>
                          )}
                        </td>
                      </tr>
                      {c.depth === 3 && (
                        <tr key={`${c.id}-gate`} className="border-b border-line bg-paper/40">
                          <td colSpan={6} className="px-3 py-3">
                            {checklist ? (
                              <ChecklistGate failures={checklist.failures} />
                            ) : (
                              <p className="text-xs text-muted">Assign a sending domain to evaluate the depth-3 gate.</p>
                            )}
                            {canEdit && c.status !== "active" && (
                              <div className="mt-3">
                                <Depth3ActivationPanel
                                  campaignId={c.id}
                                  sendingDomainId={c.sendingDomainId}
                                  pendingApproval={pending ? { id: pending.id, approvers: pending.approvers } : null}
                                />
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Deliverability */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
          <Gauge className="h-4 w-4" /> Deliverability
        </h2>
        {deliverability.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line bg-paper p-8 text-center text-sm text-muted">
            No sending domains registered. Register a secondary domain below to start warmup tracking.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-paper">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-line bg-paper/60 text-[11px] text-muted">
                  <th className="px-3 py-2 font-medium">Domain</th>
                  <th className="px-3 py-2 font-medium">Reputation</th>
                  <th className="px-3 py-2 font-medium">Spam rate</th>
                  <th className="px-3 py-2 font-medium">Bounce</th>
                  <th className="px-3 py-2 font-medium">Warmup</th>
                  <th className="px-3 py-2 font-medium">Checks</th>
                </tr>
              </thead>
              <tbody>
                {deliverability.map((d) => {
                  const rep = REPUTATION_META[d.reputation];
                  return (
                    <tr key={d.domainId} className="border-b border-line last:border-0 hover:bg-hover-paper">
                      <td className="px-3 py-2">
                        <span className="font-medium text-ink">{d.domain}</span>
                        {d.checklistFailures.length > 0 && (
                          <span className="block text-[11px] text-failed-text">
                            {d.checklistFailures.map((f) => f.code).join(" · ")}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {chip(rep.label, REPUTATION_CHIP[d.reputation])}
                      </td>
                      <td className="px-3 py-2">
                        <span className={d.spamOk ? "text-muted" : "font-semibold text-failed-text"}>
                          {d.spamRatePct.toFixed(3)}%
                        </span>
                        <span className="text-[11px] text-subtle"> / {d.spamCeilingPct}%</span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={d.bounceStatus === "healthy" ? "text-muted" : "font-semibold text-failed-text"}>
                          {d.bounceRatePct.toFixed(2)}% — {d.bounceStatus}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="text-muted">{d.warmupDays}d / {d.warmupRequiredDays}d</span>
                          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-paper">
                            <span className="block h-full rounded-full bg-ink" style={{ width: `${Math.min(100, (d.warmupDays / d.warmupRequiredDays) * 100)}%` }} />
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2">{canEdit && <UpdateDomainChecks domainId={d.domainId} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Sending domains */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
          <Mail className="h-4 w-4" /> Sending domains
        </h2>
        {canEdit ? (
          <CreateDomainForm />
        ) : (
          <p className="text-xs text-muted">Domain management requires the editor role.</p>
        )}
        <p className="mt-2 max-w-2xl text-[11px] text-muted">
          Secondary domains only for cold sending. Primary domains and Gmail free accounts are hard-blocked
          by the depth-3 gate — registering them here will show the block, not bypass it. Canada cold pitching
          is blocked at dispatch (CASL).
        </p>
      </section>
    </div>
  );
}
