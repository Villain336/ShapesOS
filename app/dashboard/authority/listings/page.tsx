// Marketr — Authority / Listings (Phase 6 L1).
//
// Channels with their TRUE tier label on every card (spec §9.10 — the label
// is mandatory), sync/verification status, profiles, and the citation-brief
// builder. Light mode; lucide icons only; no emoji.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { authorityTablesReady } from "@/lib/authority/db";
import {
  MapPin, CheckCircle2, CircleDashed, AlertTriangle, Clock,
  ListChecks, ChevronRight, FlaskConical, Footprints,
} from "lucide-react";
import { CHANNEL_DEFINITIONS, TIER_LABELS, type ListingTier } from "@/lib/authority/listings/tiers";
import ConnectChannelButton from "./_components/connect-button";
import BriefBuilder from "./_components/brief-builder";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Listings — ShapesOS Authority",
  description: "Listings & citations, honestly tiered: GBP, Bing, LDE prototype, Apple claims, citation briefs.",
};

// Listing tiers are categories, not agent states — always a neutral chip.
const TIER_BADGE: Record<ListingTier, string> = {
  api_synced: "border-line bg-paper text-muted shadow-control",
  aggregator: "border-line bg-paper text-muted shadow-control",
  manual: "border-line bg-paper text-muted shadow-control",
  guided_claim: "border-line bg-paper text-muted shadow-control",
};

const TIER_ICON: Record<ListingTier, typeof CheckCircle2> = {
  api_synced: CheckCircle2,
  aggregator: FlaskConical,
  manual: Footprints,
  guided_claim: ListChecks,
};

function tierChip(tier: ListingTier) {
  return (
    <span className={`inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[0.625rem] font-medium leading-tight ${TIER_BADGE[tier]}`}>
      {TIER_LABELS[tier]}
    </span>
  );
}

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

export default async function ListingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  const canEdit = ["owner", "admin", "editor"].includes(membership.role);

  const ready = await authorityTablesReady().catch(() => false);
  let channels: Awaited<ReturnType<typeof prisma.listingChannel.findMany>> = [];
  let profiles: Awaited<ReturnType<typeof prisma.listingProfile.findMany>> = [];
  let briefs: Awaited<ReturnType<typeof prisma.citationBrief.findMany>> = [];
  if (ready) {
    [channels, profiles, briefs] = await Promise.all([
      prisma.listingChannel.findMany({ where: { workspaceId: workspace.id } }),
      prisma.listingProfile.findMany({ where: { workspaceId: workspace.id }, orderBy: { channel: "asc" } }),
      prisma.citationBrief.findMany({ where: { workspaceId: workspace.id }, orderBy: { createdAt: "desc" }, take: 10 }),
    ]);
  }
  const byChannel = new Map(channels.map((c) => [c.channel, c]));

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <nav className="flex items-center gap-1.5 text-xs text-muted">
        <Link href="/dashboard/authority" className="hover:text-ink">Authority</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-medium text-ink">Listings &amp; citations</span>
      </nav>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="aos-heading">Listings &amp; citations</h1>
          <p className="mt-0.5 text-[0.8125rem] text-muted">
            Honestly tiered: API-synced, aggregator-distributed, manual submission, guided claim.
            Every listing edit is approval-bound; every channel label tells the truth.
          </p>
        </div>
      </header>

      {!ready && (
        <div className="rounded-lg border border-needs bg-needs-tint p-4 text-sm">
          Authority tables are not provisioned yet (migration pending).
        </div>
      )}

      {/* Channels — the tier label is mandatory on every row */}
      <section>
        <h2 className="mb-2 text-sm font-semibold tracking-tight text-ink">Channels</h2>
        <div className="overflow-x-auto rounded-lg border border-line bg-paper">
          <table className="w-full text-left text-[0.8125rem]">
            <thead>
              <tr className="border-b border-line bg-paper/60 text-[0.6875rem] text-muted">
                <th className="px-3 py-2 font-medium">Channel</th>
                <th className="px-3 py-2 font-medium">Tier</th>
                <th className="px-3 py-2 font-medium">Capability</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Last sync</th>
                <th className="px-3 py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {CHANNEL_DEFINITIONS.map((def) => {
                const connected = byChannel.get(def.channel);
                const Icon = TIER_ICON[def.tier];
                const config = (connected?.configJson ?? {}) as Record<string, unknown>;
                const appleClaim = (config.appleClaim ?? null) as { progress?: string; completedSteps?: number[] } | null;
                const bingApp = (config.bingApplication ?? null) as { state?: string } | null;
                const ldePrototype = def.channel === "lde";
                return (
                  <tr key={def.channel} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2 font-medium text-ink">
                        <Icon className="h-3.5 w-3.5 text-muted" />
                        {def.displayName}
                      </span>
                    </td>
                    {/* MANDATORY tier label */}
                    <td className="px-3 py-2">{tierChip(def.tier)}</td>
                    <td className="max-w-xs px-3 py-2 text-[0.75rem] text-muted">
                      {def.capabilityNote}
                      {def.channel === "apple" && appleClaim && (
                        <span className="block">Claim walkthrough: {appleClaim.progress} ({(appleClaim.completedSteps ?? []).length}/6 steps)</span>
                      )}
                      {def.channel === "bing" && bingApp && (
                        <span className="block">Trusted-partner application: {bingApp.state}</span>
                      )}
                      {ldePrototype && (
                        <span className="block">Prototype behind a feature flag — sandbox only until sync-accuracy validation passes.</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5 text-[0.75rem]">
                        {connected ? <CheckCircle2 className="h-3.5 w-3.5 text-ink" /> : <CircleDashed className="h-3.5 w-3.5 text-subtle" />}
                        <span className={connected ? "text-ink" : "text-muted"}>
                          {connected ? `Connected (${connected.status})` : "Not connected"}
                        </span>
                      </span>
                      {connected && Array.isArray(connected.syncErrorsJson) && connected.syncErrorsJson.length > 0 && (
                        <span className="mt-0.5 flex items-center gap-1 text-[0.75rem] text-failed-text">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {connected.syncErrorsJson.length} sync error(s)
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[0.75rem] text-muted">
                      {connected ? (
                        <span className="flex items-center gap-1.5">
                          <Clock className="h-3.5 w-3.5" />
                          Sync {fmtDate(connected.lastSyncAt)} · verified {fmtDate(connected.lastVerifiedAt)}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {!connected && canEdit && <ConnectChannelButton channel={def.channel} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Profiles */}
      <section>
        <h2 className="mb-2 text-sm font-semibold tracking-tight text-ink">Profiles</h2>
        {profiles.length === 0 ? (
          <p className="text-[0.8125rem] text-muted">
            No listing profiles yet — connect a channel to add one.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-paper">
            <table className="w-full text-left text-[0.8125rem]">
              <thead>
                <tr className="border-b border-line bg-paper/60 text-[0.6875rem] text-muted">
                  <th className="px-3 py-2 font-medium">Channel</th>
                  <th className="px-3 py-2 font-medium">Tier</th>
                  <th className="px-3 py-2 font-medium">Location</th>
                  <th className="px-3 py-2 font-medium">Verification</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => {
                  const def = CHANNEL_DEFINITIONS.find((d) => d.channel === p.channel);
                  const tier = (def?.tier ?? "manual") as ListingTier;
                  return (
                    <tr key={p.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-1.5 font-medium text-ink">
                          <MapPin className="h-3.5 w-3.5 text-muted" />
                          {def?.displayName ?? p.channel}
                        </span>
                      </td>
                      <td className="px-3 py-2">{tierChip(tier)}</td>
                      <td className="px-3 py-2 font-mono text-xs text-muted">{p.locationRef}</td>
                      <td className="px-3 py-2 text-muted">{p.verificationStatus}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Citation briefs */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-tight text-ink">Citation briefs</h2>
        {canEdit && <BriefBuilder />}
        {briefs.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-line bg-paper">
            <table className="w-full text-left text-[0.8125rem]">
              <thead>
                <tr className="border-b border-line bg-paper/60 text-[0.6875rem] text-muted">
                  <th className="px-3 py-2 font-medium">Brief</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Scope</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {briefs.map((b) => {
                  const dirs = (Array.isArray(b.directoriesJson) ? b.directoriesJson : []) as { directory: string; status: string }[];
                  const gaps = (b.competitorGapJson ?? {}) as { gaps?: { directory: string; priority: string }[] };
                  return (
                    <tr key={b.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                      <td className="px-3 py-2 font-mono text-xs text-muted">{b.id}</td>
                      <td className="px-3 py-2 text-[0.75rem] text-muted">{b.checklistStatus}</td>
                      <td className="px-3 py-2 text-[0.75rem] text-muted">
                        {dirs.length} directories · {(gaps.gaps ?? []).filter((g) => g.priority === "high").length} high-priority gaps
                      </td>
                      <td className="px-3 py-2 text-[0.75rem] text-muted">
                        {fmtDate(b.createdAt)} · manual submission — ShapesOS tracks, a human submits.
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
