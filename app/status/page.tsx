// ShapesOS — /status: the public status page (beta readiness, WS=legal).
// A website page (host routing serves it on WEBSITE_HOST like /pricing),
// readable signed out. Renders the same snapshot GET /api/status returns
// (lib/status/public.ts: live component health + the incident log).

import { getI18n } from "@/lib/i18n/server";
import { statusSnapshot } from "@/lib/status/public";
import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { StatusBoard } from "@/components/site/StatusBoard";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("legal.status.title")} — ShapesOS`, description: t("legal.status.subtitle") };
}

export default async function StatusPage() {
  const { t } = await getI18n();
  const snapshot = await statusSnapshot();
  return (
    <div className="min-h-screen bg-canvas">
      <SiteHeader current="/status" />
      <main id="main-content" className="mx-auto max-w-3xl px-6 pb-20 pt-12">
        <h1 className="aos-display text-ink">{t("legal.status.title")}</h1>
        <p className="mt-3 text-lg text-muted">{t("legal.status.subtitle")}</p>
        <div className="mt-8">
          <StatusBoard snapshot={snapshot} />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
