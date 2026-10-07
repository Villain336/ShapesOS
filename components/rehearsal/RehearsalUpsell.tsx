// ShapesOS — Phase 19B (WS=panel): the honest upsell below Pro.
// Server component: what Dress Rehearsal is, that its results are synthetic,
// and which plan includes it. Admins get the Billing link; others are told
// who can upgrade.

import Link from "next/link";
import { Drama } from "lucide-react";
import { aosButton } from "@/components/aos";
import { getI18n } from "@/lib/i18n/server";

export async function RehearsalUpsell({ canManageBilling }: { canManageBilling: boolean }) {
  const { t } = await getI18n();
  return (
    <div className="flex flex-col gap-6">
      <div className="min-w-0">
        <h1 className="aos-heading">{t("rehearsal.title")}</h1>
        <p className="mt-1 max-w-[72ch] text-md text-muted">{t("rehearsal.subtitle")}</p>
      </div>
      <section aria-labelledby="rehearsal-upsell" className="flex max-w-[72ch] flex-col gap-3 rounded-lg bg-paper p-5 shadow-hairline">
        <div className="flex items-center gap-2">
          <Drama className="size-5 text-muted" aria-hidden />
          <h2 id="rehearsal-upsell" className="aos-subheading">
            {t("rehearsal.upsell.title")}
          </h2>
        </div>
        <p className="text-sm text-ink">{t("rehearsal.upsell.body")}</p>
        {canManageBilling ? (
          <Link href="/dashboard/billing" className={aosButton({ size: "md", className: "self-start" })}>
            {t("rehearsal.upsell.cta")}
          </Link>
        ) : (
          <p className="text-sm text-muted">{t("rehearsal.upsell.askAdmin")}</p>
        )}
      </section>
    </div>
  );
}
