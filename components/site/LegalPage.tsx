// ShapesOS — the shell every public legal page renders through (beta
// readiness, WS=legal): website header, title, revision date, "English only"
// note, the draft banner, the English prose, website footer. The prose uses
// plain semantic HTML styled by `.site-prose` in app/globals.css (tokens
// only). Server component.

import type { ReactNode } from "react";
import { getI18n } from "@/lib/i18n/server";
import { legalPage, type LegalPageKey } from "@/lib/legal/public-pages";
import { SiteHeader } from "./SiteHeader";
import { SiteFooter } from "./SiteFooter";
import { DraftBanner } from "./DraftBanner";

export interface LegalPageSection {
  id: string;
  title: string;
}

export async function LegalPage({
  pageKey,
  path,
  title,
  lede,
  sections,
  children,
}: {
  pageKey: LegalPageKey;
  path: `/${string}`;
  title: string;
  lede: string;
  /** For the "On this page" list; each section is an <h2 id>. */
  sections?: readonly LegalPageSection[];
  children: ReactNode;
}) {
  const { t, format } = await getI18n();
  const entry = legalPage(path);
  const updated = entry ? format.date(entry.updated, "date") : "";
  return (
    <div className="min-h-screen bg-canvas">
      <SiteHeader />
      <main id="main-content" className="mx-auto max-w-3xl px-6 pb-20 pt-12" data-legal-page={pageKey}>
        <h1 className="aos-display text-ink">{title}</h1>
        <p className="mt-3 text-lg text-muted">{lede}</p>
        <p className="mt-3 text-sm text-muted">
          {t("legal.page.updated", { date: updated })} · {t("legal.page.englishOnly")}
        </p>
        <div className="mt-6">
          <DraftBanner />
        </div>
        {sections && sections.length > 0 ? (
          <nav aria-label={t("legal.page.onThisPage")} className="mt-8 rounded-lg bg-paper p-5 shadow-hairline">
            <h2 className="text-xs font-semibold text-muted">{t("legal.page.onThisPage")}</h2>
            <ol className="mt-2 grid gap-x-6 text-sm sm:grid-cols-2">
              {sections.map((s, i) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} className="flex min-h-8 items-center rounded-sm text-ink underline-offset-2 hover:underline">
                    {i + 1}. {s.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        <article lang="en" className="site-prose mt-8">
          {children}
        </article>
      </main>
      <SiteFooter />
    </div>
  );
}

/** A numbered section with an anchor the "On this page" list points at. */
export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-heading`} className="mt-10">
      <h2 id={id} className="aos-subheading text-ink">
        <span id={`${id}-heading`}>{title}</span>
      </h2>
      {children}
    </section>
  );
}

/** A marked placeholder the lawyer must fill in (visible, never silent). */
export function Placeholder({ children }: { children: ReactNode }) {
  return (
    <mark className="rounded-key bg-hover px-1 text-ink" data-legal-placeholder="">
      [{children}]
    </mark>
  );
}
