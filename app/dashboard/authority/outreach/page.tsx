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
import { Badge } from "@/components/vault/shadcn/badge";
import { Progress } from "@/components/vault/shadcn/progress";
import {
  ShieldCheck, ShieldAlert, ShieldX, Mail, Gauge, Flame, Snowflake,
  Send, Layers, CircleCheck, CircleX, Clock,
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
  high: { icon: ShieldCheck, cls: "bg-emerald-100 text-emerald-800", label: "High" },
  medium: { icon: ShieldAlert, cls: "bg-amber-100 text-amber-800", label: "Medium" },
  low: { icon: ShieldAlert, cls: "bg-orange-100 text-orange-800", label: "Low" },
  bad: { icon: ShieldX, cls: "bg-red-100 text-red-800", label: "Bad" },
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
    <div className="flex h-full flex-col gap-6 bg-[#FAFAF7] p-4 md:p-6">
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
          <div className="grid gap-4 lg:grid-cols-2">
            {campaigns.map((c) => {
              const domain = c.sendingDomainId ? domainById.get(c.sendingDomainId) : null;
              const checklist = domain ? evaluateDomain(domain) : null;
              const pending = pendingDepth3.get(c.id) ?? null;
              const depthMeta = DEPTH_META[c.depth as 1 | 2 | 3];
              return (
                <div key={c.id} className="rounded-xl border border-stone-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <Link
                        href={`/dashboard/authority/outreach/campaigns/${c.id}`}
                        className="text-sm font-semibold text-stone-900 hover:underline"
                      >
                        {c.name}
                      </Link>
                      <p className="mt-0.5 text-xs text-stone-500">
                        Depth {c.depth} — {depthMeta.label}. {depthMeta.hint}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <Badge variant={c.status === "active" ? "default" : "secondary"}>{c.status}</Badge>
                      <Badge variant="outline">≤ {c.dailyCap}/day</Badge>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2 text-xs text-stone-600">
                    <Mail className="h-3.5 w-3.5 text-stone-400" />
                    {domain ? (
                      <span>
                        {domain.domain}
                        {domain.isPrimary && (
                          <Badge variant="destructive" className="ml-2">primary — never cold-sends</Badge>
                        )}
                      </span>
                    ) : (
                      <span className="text-stone-400">No sending domain assigned</span>
                    )}
                  </div>
                  {c.depth === 3 && (
                    <div className="mt-2">
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
                      {c.status === "active" && (
                        <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                          <Send className="h-3.5 w-3.5" /> Automated pitching live within caps and rail checks.
                        </p>
                      )}
                    </div>
                  )}
                  {canEdit && c.depth !== 3 && c.status === "draft" && (
                    <div className="mt-3">
                      <ActivateShallowButton campaignId={c.id} />
                    </div>
                  )}
                </div>
              );
            })}
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
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {deliverability.map((d) => {
              const rep = REPUTATION_META[d.reputation];
              const RepIcon = rep.icon;
              return (
                <div key={d.domainId} className="rounded-xl border border-stone-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-stone-900">{d.domain}</p>
                      <p className="text-[11px] text-stone-500">
                        {d.warmupDays}d / {d.warmupRequiredDays}d warmup
                        {d.warmupOk ? " — complete" : " — warming"}
                      </p>
                    </div>
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${rep.cls}`}>
                      <RepIcon className="h-3 w-3" /> {rep.label}
                    </span>
                  </div>
                  <div className="mt-3 space-y-2.5">
                    <div>
                      <div className="flex justify-between text-[11px] text-stone-500">
                        <span className="flex items-center gap-1"><Flame className="h-3 w-3" /> Spam rate</span>
                        <span className={d.spamOk ? "text-stone-600" : "font-semibold text-red-700"}>
                          {d.spamRatePct.toFixed(3)}% / ceiling {d.spamCeilingPct}%
                        </span>
                      </div>
                      <Progress value={Math.min(100, (d.spamRatePct / d.spamCeilingPct) * 100)} className="mt-1 h-1.5" />
                    </div>
                    <div>
                      <div className="flex justify-between text-[11px] text-stone-500">
                        <span>Bounce rate</span>
                        <Badge
                          variant={d.bounceStatus === "healthy" ? "secondary" : "destructive"}
                          className="text-[10px]"
                        >
                          {d.bounceRatePct.toFixed(2)}% — {d.bounceStatus}
                        </Badge>
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-[11px] text-stone-500">
                        <span className="flex items-center gap-1"><Snowflake className="h-3 w-3" /> Warmup</span>
                        <span>{d.warmupDays}d / {d.warmupRequiredDays}d</span>
                      </div>
                      <Progress value={Math.min(100, (d.warmupDays / d.warmupRequiredDays) * 100)} className="mt-1 h-1.5" />
                    </div>
                  </div>
                  {d.checklistFailures.length > 0 && (
                    <ul className="mt-3 space-y-1 border-t border-stone-100 pt-2 text-[11px] text-red-700">
                      {d.checklistFailures.map((f) => (
                        <li key={f.code} className="flex gap-1.5">
                          <CircleX className="mt-0.5 h-3 w-3 shrink-0" /> {f.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  {canEdit && <UpdateDomainChecks domainId={d.domainId} />}
                </div>
              );
            })}
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
