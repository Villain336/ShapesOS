// Marketr — Phase 18 slice 1: Advertising hub (Grow pillar → Advertising).
//
// Platform registry table: capability flags, linked-account status, and the
// connect action. Zero custody of client spend — connecting links the
// advertiser's own account; Marketr never holds ad money.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { ensureAdPlatforms } from "@/lib/adplatforms/oauth";
import { ADS_PLATFORMS } from "@/lib/adplatforms/types";
import AdsTabs from "./_components/AdsTabs";
import ConnectButton from "./_components/ConnectButton";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Advertising — Marketr",
  description: "Buy everywhere, approve everything: one home for Amazon Ads, StackAdapt, Walmart Connect, and Spotify.",
};

const chip =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight";
const chipSlate = `${chip} bg-stone-100 text-stone-600 border-stone-200`;
const chipBrand = `${chip} bg-[var(--brand-50)] text-[var(--brand-700)] border-[var(--brand-600)]/20`;
const chipGreen = `${chip} bg-emerald-50 text-emerald-700 border-emerald-200`;
const chipAmber = `${chip} bg-amber-50 text-amber-700 border-amber-200`;

function capabilityChips(key: keyof typeof ADS_PLATFORMS) {
  const def = ADS_PLATFORMS[key];
  return (
    <div className="flex flex-wrap gap-1">
      {def.supportsApiLaunch && <span className={chipBrand}>API launch</span>}
      {def.supportsReportingApi && <span className={chipBrand}>Reporting API</span>}
      {def.guidedOnly && <span className={chipAmber}>Guided only</span>}
      <span className={chipSlate}>{def.authKind === "oauth" ? "OAuth" : def.authKind === "api_key" ? "API key" : "Guided"}</span>
    </div>
  );
}

export default async function AdvertisingPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  await ensureAdPlatforms(workspace.id);
  const [platforms, accounts, pendingCount] = await Promise.all([
    prisma.adPlatform.findMany({ where: { workspaceId: workspace.id }, orderBy: { displayName: "asc" } }),
    prisma.adAccount.findMany({
      where: { workspaceId: workspace.id },
      include: { platform: { select: { key: true } } },
    }),
    prisma.spendProposal.count({ where: { workspaceId: workspace.id, status: "pending" } }),
  ]);

  const accountsByPlatform = new Map<string, typeof accounts>();
  for (const a of accounts) {
    const list = accountsByPlatform.get(a.platform.key) ?? [];
    list.push(a);
    accountsByPlatform.set(a.platform.key, list);
  }

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Advertising</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          {workspace.name} — buy everywhere, approve everything. Every spend action is proposed first and executes only after your approval.
        </p>
      </div>

      <AdsTabs active="overview" />

      {pendingCount > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
          {pendingCount} spend {pendingCount === 1 ? "proposal is" : "proposals are"} waiting for approval —{" "}
          <a href="/dashboard/media/advertising/proposals" className="font-medium underline">
            open the proposal inbox
          </a>
          .
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-stone-200 bg-stone-50 text-[11px] uppercase tracking-wide text-stone-500">
              <th className="px-3 py-2 font-medium">Platform</th>
              <th className="px-3 py-2 font-medium">Capabilities</th>
              <th className="px-3 py-2 font-medium">Linked accounts</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {platforms.map((p) => {
              const linked = accountsByPlatform.get(p.key) ?? [];
              const connected = linked.filter((a) => a.status === "connected").length;
              return (
                <tr key={p.id} className="border-b border-stone-100 last:border-0 hover:bg-[var(--brand-50)]/40">
                  <td className="px-3 py-2.5 font-medium text-stone-900">{p.displayName}</td>
                  <td className="px-3 py-2.5">{capabilityChips(p.key as keyof typeof ADS_PLATFORMS)}</td>
                  <td className="px-3 py-2.5 text-stone-600">
                    {linked.length === 0 ? (
                      <span className="text-stone-400">None linked</span>
                    ) : (
                      linked.map((a) => a.name ?? a.externalAccountId).join(", ")
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {connected > 0 ? (
                      <span className={chipGreen}>{connected} connected</span>
                    ) : (
                      <span className={chipSlate}>Not connected</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <ConnectButton platformKey={p.key} displayName={p.displayName} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-[12px] text-stone-500">
        Your ad accounts bill to you directly on each platform — Marketr never holds or moves ad spend.
        Campaign connectors (launch, reporting) land in the following Phase 18 slices; the proposal inbox
        below is live now.
      </p>

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <div className="flex items-center justify-between border-b border-stone-200 bg-stone-50 px-3 py-2">
          <span className="text-[12px] font-medium text-stone-600">Conversational-intent campaigns</span>
          <a
            href="/dashboard/media/advertising/chatgpt"
            className="text-[12px] font-medium text-[var(--brand-700)] underline"
          >
            Open ChatGPT Ads
          </a>
        </div>
        <p className="px-3 py-3 text-[13px] text-stone-500">
          Target users inside ChatGPT — Free and Go tiers, by topic intent — bought through your StackAdapt
          account. Propose a campaign and it lands in the proposal inbox; nothing spends until you approve.
        </p>
      </div>
    </div>
  );
}
