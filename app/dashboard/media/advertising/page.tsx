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
  "inline-flex h-badge items-center whitespace-nowrap rounded-full border border-line bg-paper px-2.5 text-sm font-semibold text-muted";
const chipOnInk =
  "inline-flex h-badge items-center whitespace-nowrap rounded-full bg-ink px-2.5 text-sm font-semibold text-white";

function capabilityChips(key: keyof typeof ADS_PLATFORMS) {
  const def = ADS_PLATFORMS[key];
  return (
    <div className="flex flex-wrap gap-1.5">
      {def.supportsApiLaunch && <span className={chip}>API launch</span>}
      {def.supportsReportingApi && <span className={chip}>Reporting API</span>}
      {def.guidedOnly && <span className={chip}>Guided only</span>}
      <span className={chip}>{def.authKind === "oauth" ? "OAuth" : def.authKind === "api_key" ? "API key" : "Guided"}</span>
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
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Advertising</h1>
        <p className="mt-0.5 text-sm text-muted">
          {workspace.name} — buy everywhere, approve everything. Every spend action is proposed first and executes only after your approval.
        </p>
      </div>

      <AdsTabs active="overview" />

      {pendingCount > 0 && (
        <div className="flex items-center gap-2.5 rounded-lg bg-needs px-4 py-3">
          <span
            className="aos-shape aos-shape--needs"
            style={{ color: "var(--aos-ink)" }}
            role="img"
            aria-label="Needs review"
          />
          <p className="text-sm font-semibold text-ink">
            {pendingCount} spend {pendingCount === 1 ? "proposal is" : "proposals are"} waiting for approval
          </p>
          <a
            href="/dashboard/media/advertising/proposals"
            className="ml-auto shrink-0 text-sm font-semibold text-ink underline underline-offset-2"
          >
            Open the proposal inbox
          </a>
        </div>
      )}

      <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-canvas">
              <th className="px-3 py-2 text-xs font-semibold text-muted">Platform</th>
              <th className="px-3 py-2 text-xs font-semibold text-muted">Capabilities</th>
              <th className="px-3 py-2 text-xs font-semibold text-muted">Linked accounts</th>
              <th className="px-3 py-2 text-xs font-semibold text-muted">Status</th>
              <th className="px-3 py-2 text-right text-xs font-semibold text-muted">Action</th>
            </tr>
          </thead>
          <tbody>
            {platforms.map((p) => {
              const linked = accountsByPlatform.get(p.key) ?? [];
              const connected = linked.filter((a) => a.status === "connected").length;
              return (
                <tr key={p.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  <td className="px-3 py-2.5 font-semibold text-ink">{p.displayName}</td>
                  <td className="px-3 py-2.5">{capabilityChips(p.key as keyof typeof ADS_PLATFORMS)}</td>
                  <td className="px-3 py-2.5 text-muted">
                    {linked.length === 0 ? (
                      <span className="text-subtle">None linked</span>
                    ) : (
                      linked.map((a) => a.name ?? a.externalAccountId).join(", ")
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {connected > 0 ? (
                      <span className={chipOnInk}>{connected} connected</span>
                    ) : (
                      <span className={chip}>Not connected</span>
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

      <p className="rounded-lg bg-paper px-3 py-2 text-sm text-muted shadow-hairline">
        Your ad accounts bill to you directly on each platform — Marketr never holds or moves ad spend.
        Campaign connectors (launch, reporting) land in the following Phase 18 slices; the proposal inbox
        below is live now.
      </p>

      <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-xs font-semibold text-muted">Conversational-intent campaigns</span>
          <a
            href="/dashboard/media/advertising/chatgpt"
            className="text-sm font-semibold text-ink underline underline-offset-2"
          >
            Open ChatGPT Ads
          </a>
        </div>
        <p className="px-3 py-3 text-sm text-muted">
          Target users inside ChatGPT — Free and Go tiers, by topic intent — bought through your StackAdapt
          account. Propose a campaign and it lands in the proposal inbox; nothing spends until you approve.
        </p>
      </div>
    </div>
  );
}
