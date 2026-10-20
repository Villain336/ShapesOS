// ShapesOS — website header shared by the legal and trust pages (beta
// readiness, WS=legal). Same shape and classes as app/pricing/page.tsx:
// wordmark, quiet pill links, black primary CTA. Server component (getI18n).

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getI18n } from "@/lib/i18n/server";

const quietNav =
  "inline-flex h-control-sm items-center rounded-full px-4 text-base font-semibold text-muted transition-colors hover:bg-hover hover:text-ink";
const primaryCta =
  "aos-press inline-flex h-control items-center gap-2 rounded-full bg-ink px-5.5 text-base font-semibold text-paper hover:bg-ink-hover";

export async function SiteHeader({ current }: { current?: "/pricing" | "/status" }) {
  const { t } = await getI18n();
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4">
        <Link href="/" className="text-xl font-heading stretch-heading text-ink">
          ShapesOS
        </Link>
        <nav aria-label={t("legal.site.menu")} className="flex flex-wrap items-center gap-2">
          <Link href="/pricing" aria-current={current === "/pricing" ? "page" : undefined} className={quietNav}>
            {t("legal.site.pricing")}
          </Link>
          <Link href="/status" aria-current={current === "/status" ? "page" : undefined} className={quietNav}>
            {t("legal.footer.status")}
          </Link>
          <Link href="/login" className={quietNav}>
            {t("legal.site.signIn")}
          </Link>
          <Link href="/signup" className={primaryCta}>
            {t("legal.site.startTrial")}
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </nav>
      </div>
    </header>
  );
}
