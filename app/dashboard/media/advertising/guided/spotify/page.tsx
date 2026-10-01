// Marketr — Phase 18 slice 5: Spotify guided setup page (server component).
//
// GUIDED: Spotify's self-serve path is Spotify Ads Manager — Marketr cannot
// connect, launch, or read campaign data via API. This page walks the user
// through the Ads Manager path (checklist), plans budget ($250 minimum
// floor), checks creative against the official specs, and provides UTM +
// pixel helpers. Spend enters Marketr only through CSV imports.

import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowLeft,
  ListChecks,
  Calculator,
  FileAudio,
  Link2,
  Megaphone,
  Upload,
  TriangleAlert,
} from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { ensureAdPlatforms } from "@/lib/adplatforms/oauth";
import {
  SPOTIFY_GUIDED_STEPS,
  SPOTIFY_AUDIO_SPECS,
  SPOTIFY_CSV_TEMPLATE,
} from "@/lib/adplatforms/spotify/guided";
import GuidedChecklist from "./_components/GuidedChecklist";
import BudgetPlanner from "./_components/BudgetPlanner";
import CreativeSpecChecker from "./_components/CreativeSpecChecker";
import UtmBuilder from "./_components/UtmBuilder";
import LinkAdvertiserForm from "./_components/LinkAdvertiserForm";
import RegisterCampaignForm from "./_components/RegisterCampaignForm";
import CsvImportForm from "./_components/CsvImportForm";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Spotify guided setup — Marketr",
  description: "Guided Spotify setup: Ads Manager checklist, budget planner, creative specs, and CSV spend import.",
};

export default async function SpotifyGuidedPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  await ensureAdPlatforms(workspace.id);
  const accounts = await prisma.adAccount.findMany({
    where: { workspaceId: workspace.id, platform: { key: "spotify" } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, externalAccountId: true },
  });

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <Link
          href="/dashboard/media/advertising"
          className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-stone-500 hover:text-stone-800"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Advertising
        </Link>

        <h1 className="text-xl font-bold tracking-tight text-stone-900">Spotify — guided setup</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          Self-serve setup for Spotify Ads Manager: account checklist, budget planner, creative specs, and spend
          tracking — without an API connection.
        </p>
      </div>

      {/* Guided framing: honest about what Marketr can and cannot do here. */}
      <div className="mt-4 flex gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div className="text-[12px] leading-relaxed text-amber-900">
          <p className="font-medium">Guided, not connected.</p>
          <p className="mt-0.5">
            Spotify advertising is managed entirely in Spotify Ads Manager. Marketr has no API connection here:
            it cannot create accounts, launch campaigns, or read performance data. You set up and launch in Ads
            Manager, register what you launched below, and import daily spend via CSV — Marketr tracks everything
            you import. Programmatic alternative: Spotify audio inventory can also be bought programmatically
            through the StackAdapt connector in the Advertising hub.
          </p>
        </div>
      </div>

      {/* 1 — Account checklist */}
      <section>
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-stone-900">
          <ListChecks className="h-4 w-4" />
          1. Ads Manager account checklist
        </h2>
        <p className="mt-0.5 text-[12px] text-stone-500">
          The self-serve account path from Spotify's help center. Steps happen in Ad Studio — check them off as you
          go.
        </p>
        <div className="mt-2">
          <GuidedChecklist steps={SPOTIFY_GUIDED_STEPS} />
        </div>
      </section>

      {/* 2 — Budget planner */}
      <section>
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-stone-900">
          <Calculator className="h-4 w-4" />
          2. Audience &amp; budget planner
        </h2>
        <p className="mt-0.5 text-[12px] text-stone-500">
          Plan the audience worksheet and sanity-check the budget against the $250 Ad Studio minimum before you
          build the campaign.
        </p>
        <div className="mt-2">
          <BudgetPlanner />
        </div>
      </section>

      {/* 3 — Creative specs */}
      <section>
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-stone-900">
          <FileAudio className="h-4 w-4" />
          3. Audio creative specs
        </h2>
        <p className="mt-0.5 text-[12px] text-stone-500">
          The official Ad Studio specs, from Spotify's help center. Upload your files below to check them against
          these rules before launch.
        </p>
        <div className="mt-2 overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className="w-full text-left text-[12px]">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50">
                <th className="px-3 py-2 font-medium text-stone-600">Asset</th>
                <th className="px-3 py-2 font-medium text-stone-600">Spec</th>
                <th className="px-3 py-2 font-medium text-stone-600">Source</th>
              </tr>
            </thead>
            <tbody>
              {SPOTIFY_AUDIO_SPECS.map((g) => (
                <tr key={g.asset} className="border-b border-stone-100 last:border-0 hover:bg-[var(--brand-50)]/40">
                  <td className="px-3 py-2 font-medium text-stone-900">{g.asset}</td>
                  <td className="px-3 py-2 text-stone-500">
                    <ul className="flex list-disc flex-col gap-0.5 pl-4">
                      {g.specs.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ul>
                  </td>
                  <td className="px-3 py-2">
                    <a
                      href={g.source}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-[var(--brand-700)] underline"
                    >
                      Spotify help center ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2">
          <CreativeSpecChecker />
        </div>
      </section>

      {/* 4 — UTM + pixel */}
      <section>
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-stone-900">
          <Link2 className="h-4 w-4" />
          4. UTM builder &amp; Spotify Pixel
        </h2>
        <p className="mt-0.5 text-[12px] text-stone-500">
          Tag landing URLs with utm_source=spotify and grab the pixel base code for conversion tracking.
        </p>
        <div className="mt-2">
          <UtmBuilder />
        </div>
      </section>

      {/* 5 — Link ad account */}
      <section>
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-stone-900">
          <Link2 className="h-4 w-4" />
          5. Link an ad account
        </h2>
        <p className="mt-0.5 text-[12px] text-stone-500">
          Copy the ad account ID from Ad Studio (Manage ad accounts) and link it here. No credentials are stored —
          this is manual linkage only.
        </p>
        <div className="mt-2">
          <LinkAdvertiserForm />
        </div>
      </section>

      {/* 6 — Register campaign */}
      <section>
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-stone-900">
          <Megaphone className="h-4 w-4" />
          6. Register a launched campaign
        </h2>
        <p className="mt-0.5 text-[12px] text-stone-500">
          After launching in Spotify Ads Manager, register the campaign here with its Spotify campaign ID so
          imported spend can attach to it.
        </p>
        <div className="mt-2">
          <RegisterCampaignForm accounts={accounts} />
        </div>
      </section>

      {/* 7 — Import spend */}
      <section>
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-stone-900">
          <Upload className="h-4 w-4" />
          7. Import spend (CSV)
        </h2>
        <p className="mt-0.5 text-[12px] text-stone-500">
          Pull the daily report from Spotify Ads Manager, paste or upload it as CSV. Strict format — the import is
          rejected if any row is malformed.
        </p>
        <div className="mt-2">
          <CsvImportForm accounts={accounts} template={SPOTIFY_CSV_TEMPLATE} />
        </div>
      </section>
    </div>
  );
}
