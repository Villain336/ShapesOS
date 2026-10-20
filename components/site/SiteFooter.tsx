"use client";

// ShapesOS — website footer with the legal and trust links (beta readiness,
// WS=legal). Used by the landing page, /pricing and every legal page. The
// link groups come from lib/legal/public-pages.ts FOOTER_GROUPS (its unit
// test checks they cover every page). A client component on purpose: it
// renders synchronously (useI18n; the root layout's provider carries the
// visitor's locale), so pages that are rendered synchronously — /pricing in
// lib/billing/__tests__/pricing-page.test.tsx — never suspend on it.

import Link from "next/link";
import { useI18n } from "@/components/i18n/I18nProvider";
import { FOOTER_GROUPS, LEGAL_PAGES, type LegalPageKey } from "@/lib/legal/public-pages";

const linkCls = "text-sm text-muted underline-offset-2 hover:text-ink hover:underline";

export function SiteFooter() {
  const { t } = useI18n();
  const byKey = (key: LegalPageKey) => LEGAL_PAGES.find((p) => p.key === key)!;
  const group = (heading: string, keys: readonly LegalPageKey[]) => (
    <div>
      <h2 className="text-xs font-semibold text-subtle">{heading}</h2>
      <ul className="mt-2 flex flex-col gap-1.5">
        {keys.map((key) => (
          <li key={key}>
            <Link href={byKey(key).path} className={linkCls}>
              {t(`legal.footer.${key}`)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid max-w-6xl gap-8 px-6 py-8 text-xs text-muted sm:grid-cols-[1fr_auto_auto] sm:gap-12">
        <div className="flex flex-col gap-2">
          <span>{t("legal.footer.tagline")}</span>
          <Link href="https://github.com/Villain336/ShapesOS" className={linkCls}>
            {t("legal.footer.source")} (AGPLv3)
          </Link>
          <Link href="/login" className={linkCls}>
            {t("legal.site.signIn")}
          </Link>
        </div>
        {group(t("legal.footer.legal"), FOOTER_GROUPS.legal)}
        {group(t("legal.footer.trust"), FOOTER_GROUPS.trust)}
      </div>
    </footer>
  );
}
