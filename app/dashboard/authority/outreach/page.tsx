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


const REPUTATION_CHIP = {
  high: "border-emerald-200 bg-emerald-50 text-emerald-700",
  medium: "border-amber-200 bg-amber-50 text-amber-700",
  low: "border-orange-200 bg-orange-50 text-orange-700",
  bad: "border-red-200 bg-red-50 text-red-700",
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
    <div className="mt-2 rounded-lg border border-stone-200 bg-stone-50 p-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-stone-500">
        Depth-3 enablement checklist — the gate, not a toggle
      </p>
      <ul className="space-y-1.5">
        {CHECKLIST_ITEMS.map((item) => {
          const pass = !failed.has(item.code);
          const detail = failures.find((f) => f.code === item.code);
          return (
            <li key={item.code} className="flex items-start gap-2 text-xs">
              {pass ? (
                <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
              ) : (
                <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
              )}
              <span className={pass ? "text-stone-600" : "font-medium text-red-800"}>
                {item.label}
                {!pass && detail && <span className="block font-normal text-red-600">{detail.message}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 flex items-start gap-1.5 text-[11px] text-stone-500">
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
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-stone-900">Outreach</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-stone-500">
            Guest-post outreach on the 3-depth ladder: prospecting → human-sent drafts → gated
            automated pitching. Nothing sends without its depth&apos;s trust gate.
          </p>
        </div>
        {canEdit && <CreateCampaignForm domains={domains.map((d) => ({ id: d.id, domain: d.domain }))} />}
      </div>

      {!ready && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Authority tables are not provisioned yet (migration pending). The engine UI is disabled until then.
        </div>
      )}

      {/* Campaigns */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-stone-800">
          <Layers className="h-4 w-4" /> Campaigns
        </h2>
        {campaigns.length === 0 ? (
          <div className="rounded-lg border border-dashed border-stone-300 bg-white p-8 text-center text-sm text-stone-500">
            No campaigns yet. Create one to start prospecting — depth 1 never sends.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
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
                      <tr key={c.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                        <td className="px-3 py-2">
                          <Link
                            href={`/dashboard/authority/outreach/campaigns/${c.id}`}
                            className="font-medium text-stone-900 hover:underline"
                          >
                            {c.name}
                          </Link>
                          <span className="block text-[11px] text-stone-500">{depthMeta.hint}</span>
                        </td>
                        <td className="px-3 py-2">
                          {chip(`Depth ${c.depth} — ${depthMeta.label}`, "border-stone-200 bg-stone-50 text-stone-700")}
                        </td>
                        <td className="px-3 py-2">
                          {chip(c.status, c.status === "active" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-stone-200 bg-stone-50 text-stone-600")}
                        </td>
                        <td className="px-3 py-2 text-stone-600">≤ {c.dailyCap}/day</td>
                        <td className="px-3 py-2">
                          {domain ? (
                            <span className="text-stone-700">
                              {domain.domain}{" "}
                              {domain.isPrimary && chip("primary — never cold-sends", "border-red-200 bg-red-50 text-red-700")}
                            </span>
                          ) : (
                            <span className="text-stone-400">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {canEdit && c.depth !== 3 && c.status === "draft" && <ActivateShallowButton campaignId={c.id} />}
                          {c.depth === 3 && c.status === "active" && (
                            <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-700">
                              <Send className="h-3 w-3" /> live within caps
                            </span>
                          )}
                        </td>
                      </tr>
                      {c.depth === 3 && (
                        <tr key={`${c.id}-gate`} className="border-b border-stone-100 bg-stone-50/40">
                          <td colSpan={6} className="px-3 py-3">
                            {checklist ? (
                              <ChecklistGate failures={checklist.failures} />
                            ) : (
                              <p className="text-xs text-amber-700">Assign a sending domain to evaluate the depth-3 gate.</p>
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
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-stone-800">
          <Gauge className="h-4 w-4" /> Deliverability
        </h2>
        {deliverability.length === 0 ? (
          <div className="rounded-lg border border-dashed border-stone-300 bg-white p-8 text-center text-sm text-stone-500">
            No sending domains registered. Register a secondary domain below to start warmup tracking.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
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
                    <tr key={d.domainId} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                      <td className="px-3 py-2">
                        <span className="font-medium text-stone-900">{d.domain}</span>
                        {d.checklistFailures.length > 0 && (
                          <span className="block text-[11px] text-red-700">
                            {d.checklistFailures.map((f) => f.code).join(" · ")}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {chip(rep.label, REPUTATION_CHIP[d.reputation])}
                      </td>
                      <td className="px-3 py-2">
                        <span className={d.spamOk ? "text-stone-600" : "font-semibold text-red-700"}>
                          {d.spamRatePct.toFixed(3)}%
                        </span>
                        <span className="text-[11px] text-stone-400"> / {d.spamCeilingPct}%</span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={d.bounceStatus === "healthy" ? "text-stone-600" : "font-semibold text-red-700"}>
                          {d.bounceRatePct.toFixed(2)}% — {d.bounceStatus}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="text-stone-600">{d.warmupDays}d / {d.warmupRequiredDays}d</span>
                          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-stone-100">
                            <span className="block h-full rounded-full bg-violet-500" style={{ width: `${Math.min(100, (d.warmupDays / d.warmupRequiredDays) * 100)}%` }} />
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
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-stone-800">
          <Mail className="h-4 w-4" /> Sending domains
        </h2>
        {canEdit ? (
          <CreateDomainForm />
        ) : (
          <p className="text-xs text-stone-500">Domain management requires the editor role.</p>
        )}
        <p className="mt-2 max-w-2xl text-[11px] text-stone-500">
          Secondary domains only for cold sending. Primary domains and Gmail free accounts are hard-blocked
          by the depth-3 gate — registering them here will show the block, not bypass it. Canada cold pitching
          is blocked at dispatch (CASL).
        </p>
      </section>
    </div>
  );
}
