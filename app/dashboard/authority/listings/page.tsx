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
import { Badge } from "@/components/vault/shadcn/badge";
import { Button } from "@/components/vault/shadcn/button";
import {
  MapPin, CheckCircle2, CircleDashed, AlertTriangle, Clock,
  ListChecks, ArrowLeft, FlaskConical, Footprints,
} from "lucide-react";
import { CHANNEL_DEFINITIONS, TIER_LABELS, type ListingTier } from "@/lib/authority/listings/tiers";
import ConnectChannelButton from "./_components/connect-button";
import BriefBuilder from "./_components/brief-builder";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Listings — Marketr Authority",
  description: "Listings & citations, honestly tiered: GBP, Bing, LDE prototype, Apple claims, citation briefs.",
};

const TIER_BADGE: Record<ListingTier, string> = {
  api_synced: "border-emerald-300 bg-emerald-50 text-emerald-800",
  aggregator: "border-blue-300 bg-blue-50 text-blue-800",
  manual: "border-amber-300 bg-amber-50 text-amber-800",
  guided_claim: "border-violet-300 bg-violet-50 text-violet-800",
};

const TIER_ICON: Record<ListingTier, typeof CheckCircle2> = {
  api_synced: CheckCircle2,
  aggregator: FlaskConical,
  manual: Footprints,
  guided_claim: ListChecks,
};

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
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/authority">
          <Button variant="ghost" size="sm"><ArrowLeft className="mr-1.5 h-3.5 w-3.5" />Authority</Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Listings &amp; citations</h1>
          <p className="text-sm text-muted-foreground">
            Honestly tiered: API-synced, aggregator-distributed, manual submission, guided claim.
            Every listing edit is approval-bound; every channel label tells the truth.
          </p>
        </div>
      </div>

      {!ready && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
          Authority tables are not provisioned yet (migration pending).
        </div>
      )}

      {/* Channels — the tier label is mandatory on every card */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Channels</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {CHANNEL_DEFINITIONS.map((def) => {
            const connected = byChannel.get(def.channel);
            const Icon = TIER_ICON[def.tier];
            const config = (connected?.configJson ?? {}) as Record<string, unknown>;
            const appleClaim = (config.appleClaim ?? null) as { progress?: string; completedSteps?: number[] } | null;
            const bingApp = (config.bingApplication ?? null) as { state?: string } | null;
            const ldePrototype = def.channel === "lde";
            return (
              <div key={def.channel} className="flex flex-col rounded-xl border bg-card p-5 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <h3 className="text-base font-semibold">{def.displayName}</h3>
                  </div>
                  {/* MANDATORY tier label */}
                  <Badge variant="outline" className={TIER_BADGE[def.tier]}>
                    {TIER_LABELS[def.tier]}
                  </Badge>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{def.capabilityNote}</p>
                <div className="mt-3 space-y-1 text-xs">
                  <div className="flex items-center gap-1.5">
                    {connected ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />}
                    <span className={connected ? "text-emerald-700" : "text-muted-foreground"}>
                      {connected ? `Connected (${connected.status})` : "Not connected"}
                    </span>
                  </div>
                  {connected && (
                    <>
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Clock className="h-3.5 w-3.5" />
                        <span>Last sync {fmtDate(connected.lastSyncAt)} · Last verified {fmtDate(connected.lastVerifiedAt)}</span>
                      </div>
                      {Array.isArray(connected.syncErrorsJson) && connected.syncErrorsJson.length > 0 && (
                        <div className="flex items-center gap-1.5 text-amber-700">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          <span>{connected.syncErrorsJson.length} sync error(s)</span>
                        </div>
                      )}
                    </>
                  )}
                  {def.channel === "apple" && appleClaim && (
                    <p className="text-muted-foreground">
                      Claim walkthrough: {appleClaim.progress} ({(appleClaim.completedSteps ?? []).length}/6 steps)
                    </p>
                  )}
                  {def.channel === "bing" && bingApp && (
                    <p className="text-muted-foreground">Trusted-partner application: {bingApp.state}</p>
                  )}
                  {ldePrototype && (
                    <p className="text-muted-foreground">
                      Prototype behind a feature flag — sandbox only until sync-accuracy validation passes.
                    </p>
                  )}
                </div>
                <div className="mt-4 flex-1" />
                <div className="pt-1">
                  {!connected && canEdit && <ConnectChannelButton channel={def.channel} />}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Profiles */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Profiles</h2>
        {profiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No listing profiles yet — connect a channel to add one.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2">Channel</th>
                  <th className="px-4 py-2">Tier</th>
                  <th className="px-4 py-2">Location</th>
                  <th className="px-4 py-2">Verification</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => {
                  const def = CHANNEL_DEFINITIONS.find((d) => d.channel === p.channel);
                  const tier = (def?.tier ?? "manual") as ListingTier;
                  return (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="px-4 py-2">
                        <span className="flex items-center gap-1.5">
                          <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                          {def?.displayName ?? p.channel}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className={TIER_BADGE[tier]}>{TIER_LABELS[tier]}</Badge>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">{p.locationRef}</td>
                      <td className="px-4 py-2 text-muted-foreground">{p.verificationStatus}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Citation briefs */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Citation briefs</h2>
        {canEdit && <BriefBuilder />}
        {briefs.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            {briefs.map((b) => {
              const dirs = (Array.isArray(b.directoriesJson) ? b.directoriesJson : []) as { directory: string; status: string }[];
              const gaps = (b.competitorGapJson ?? {}) as { gaps?: { directory: string; priority: string }[] };
              return (
                <div key={b.id} className="rounded-xl border bg-card p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-muted-foreground">{b.id}</span>
                    <Badge variant="outline">{b.checklistStatus}</Badge>
                  </div>
                  <p className="mt-2 text-sm">
                    {dirs.length} directories · {(gaps.gaps ?? []).filter((g) => g.priority === "high").length} high-priority gaps
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Created {fmtDate(b.createdAt)} · manual submission — Marketr tracks, a human submits.
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
