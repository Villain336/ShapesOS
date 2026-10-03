// Marketr — Phase 18 slice 4: Walmart Connect guided setup flow.
//
// Walmart is guided-only (outcome B — see docs/phases/PHASE18-SLICE4-WALMART.md):
// no advertiser OAuth exists, so Marketr cannot connect, launch, or report
// via API. This page is the honest product: the WCPN partner-application
// checklist, the placement planner (incl. Vibe CTV), creative specs, manual
// advertiser-ID linking, external campaign registration, and CSV spend
// import into AdReport. "Guided" framing throughout — never implied API control.

import { redirect } from "next/navigation";
import { ArrowLeft, ListChecks, Upload, Link2, Megaphone, LayoutGrid, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { ensureAdPlatforms } from "@/lib/adplatforms/oauth";
import {
  WALMART_GUIDED_STEPS,
  WALMART_PLACEMENT_OPTIONS,
  WALMART_CREATIVE_SPECS,
  WALMART_CSV_TEMPLATE,
} from "@/lib/adplatforms/walmart/guided";
import GuidedChecklist from "./_components/GuidedChecklist";
import LinkAdvertiserForm from "./_components/LinkAdvertiserForm";
import RegisterCampaignForm from "./_components/RegisterCampaignForm";
import CsvImportForm from "./_components/CsvImportForm";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Walmart Connect guided setup — ShapesOS",
  description: "Guided Walmart Connect setup: partner application, placement planning, and CSV spend import.",
};

const sectionTitle = "aos-subheading flex items-center gap-2";
const sectionIcon = "h-4 w-4 shrink-0 text-ink";
const note = "rounded-lg bg-paper px-3 py-2 text-sm text-muted shadow-hairline";

export default async function WalmartGuidedPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  await ensureAdPlatforms(workspace.id);
  const accounts = await prisma.adAccount.findMany({
    where: { workspaceId: workspace.id, platform: { key: "walmart" } },
    select: {
      id: true,
      name: true,
      externalAccountId: true,
      status: true,
      campaigns: { select: { id: true, name: true, externalId: true, status: true }, orderBy: { name: "asc" } },
    },
    orderBy: { name: "asc" },
  });

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <Link
          href="/dashboard/media/advertising"
          className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Advertising
        </Link>
        <h1 className="aos-heading">Walmart Connect — guided setup</h1>
        <p className="mt-0.5 text-sm text-muted">
          {workspace.name} — launch in Walmart Ad Center, track everything in ShapesOS.
        </p>
      </div>

      {/* Guided framing: honest about what Marketr can and cannot do here. */}
      <div className="mt-4 flex gap-2.5 rounded-lg bg-paper px-4 py-3 shadow-hairline">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-ink" />
        <div className="text-sm leading-relaxed text-muted">
          <p className="font-semibold text-ink">Guided — no API connection.</p>
          <p className="mt-0.5">
            Walmart Connect's ad API is only available to approved Partner Network members (a business
            application, not a self-serve signup), so there is nothing to OAuth here. You launch campaigns in
            Walmart Ad Center; ShapesOS tracks spend from the CSV imports below.
          </p>
        </div>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className={sectionTitle}>
          <ListChecks className={sectionIcon} />
          Unlock the API later: the partner-application checklist
        </h2>
        <GuidedChecklist steps={WALMART_GUIDED_STEPS} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className={sectionTitle}>
          <LayoutGrid className={sectionIcon} />
          Placement planner
        </h2>
        <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line bg-canvas">
                <th className="px-3 py-2 text-xs font-semibold text-muted">Placement</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">Pricing</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">Minimum</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">Notes</th>
              </tr>
            </thead>
            <tbody>
              {WALMART_PLACEMENT_OPTIONS.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  <td className="px-3 py-2 font-semibold text-ink">{p.name}</td>
                  <td className="px-3 py-2 text-muted">{p.pricing}</td>
                  <td className="px-3 py-2 text-muted">{p.minimum}</td>
                  <td className="px-3 py-2 text-muted">{p.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {WALMART_CREATIVE_SPECS.map((s) => (
          <div key={s.asset} className={note}>
            <span className="font-semibold text-ink">{s.asset}: </span>
            {s.specs.join(" · ")}
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className={sectionTitle}>
          <Link2 className={sectionIcon} />
          Link an advertiser account
        </h2>
        <LinkAdvertiserForm />
        <p className={note}>
          Paste the advertiser ID from Walmart Ad Center. No credential is stored — the account is tracked
          as pending until a Partner Network credential exists.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className={sectionTitle}>
          <Megaphone className={sectionIcon} />
          Register a campaign launched in Ad Center
        </h2>
        <RegisterCampaignForm accounts={accounts} />
        <p className={note}>
          Registered campaigns appear on the Campaigns tab and give imported spend rows somewhere to land.
          The status you set is what you report from Ad Center — ShapesOS can't read it from any API.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className={sectionTitle}>
          <Upload className={sectionIcon} />
          Import spend (CSV)
        </h2>
        <CsvImportForm accounts={accounts} template={WALMART_CSV_TEMPLATE} />
        <p className={note}>
          Export daily campaign performance from Walmart Ad Center, paste it below, and it lands in AdReport
          with full lineage (import batch id as the receipt). Rows for unregistered campaign IDs are skipped,
          never misattributed.
        </p>
      </section>
    </div>
  );
}
