// ShapesOS — /contact: the support, privacy and security address (beta
// readiness, WS=legal). The address comes from SUPPORT_EMAIL; unset shows
// "set SUPPORT_EMAIL" rather than an invented one (lib/legal/public-pages.ts).

import Link from "next/link";
import { LifeBuoy, Mail, ShieldCheck } from "lucide-react";
import { getI18n } from "@/lib/i18n/server";
import { hasSupportEmail, supportEmail } from "@/lib/legal/public-pages";
import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("legal.contact.title")} — ShapesOS`, description: t("legal.contact.subtitle") };
}

export default async function ContactPage() {
  const { t } = await getI18n();
  const email = supportEmail();
  const configured = hasSupportEmail();
  const address = configured ? (
    <a href={`mailto:${email}`} className="font-mono text-base text-ink underline underline-offset-2">
      {email}
    </a>
  ) : (
    <span className="font-mono text-base text-ink" data-testid="support-email-unset">
      {email}
    </span>
  );
  const cards = [
    { icon: LifeBuoy, title: t("legal.contact.support"), body: t("legal.contact.supportBody") },
    { icon: Mail, title: t("legal.contact.privacy"), body: t("legal.contact.privacyBody") },
    { icon: ShieldCheck, title: t("legal.contact.security"), body: t("legal.contact.securityBody") },
  ];
  return (
    <div className="min-h-screen bg-canvas">
      <SiteHeader />
      <main id="main-content" className="mx-auto max-w-3xl px-6 pb-20 pt-12">
        <h1 className="aos-display text-ink">{t("legal.contact.title")}</h1>
        <p className="mt-3 text-lg text-muted">{t("legal.contact.subtitle")}</p>
        {!configured ? (
          <p className="mt-4 rounded-md bg-paper px-4 py-3 text-sm text-muted shadow-hairline" role="note">
            {t("legal.contact.unset")}
          </p>
        ) : null}
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {cards.map((c) => (
            <section key={c.title} className="rounded-lg bg-paper p-5 shadow-hairline">
              <c.icon className="size-5 text-ink" aria-hidden />
              <h2 className="mt-3 text-base font-semibold text-ink">{c.title}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{c.body}</p>
              <p className="mt-3 break-all">{address}</p>
            </section>
          ))}
        </div>
        <section aria-labelledby="targets" className="mt-10">
          <h2 id="targets" className="aos-subheading text-ink">
            {t("legal.contact.targets")}
          </h2>
          <ul className="mt-3 flex flex-col gap-2 text-sm text-ink">
            <li>{t("legal.contact.targetSupport")}</li>
            <li>{t("legal.contact.targetPrivacy")}</li>
            <li>{t("legal.contact.targetSecurity")}</li>
          </ul>
          <p className="mt-4 text-sm text-muted">
            <Link href="/status" className="text-ink underline underline-offset-2">
              {t("legal.contact.statusLink")}
            </Link>
          </p>
        </section>
        <section aria-labelledby="postal" className="mt-10">
          <h2 id="postal" className="aos-subheading text-ink">
            {t("legal.contact.address")}
          </h2>
          <p className="mt-2 text-sm text-muted">{t("legal.contact.addressUnset")}</p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
