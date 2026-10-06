// ShapesOS — Phase 18.1 (WS=find): Settings → You → General. Who you are
// signed in as, and the state of every personal preference at a glance,
// each linking to its page. (WS=desk adds the Keyboard page for the
// shortcut cheat-sheet and rebinding; the shortcut map is stored in
// UserPreference.shortcuts through lib/preferences.)

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { SETTINGS_GROUPS } from "@/components/settings/settingsSections";
import { settingsPageText } from "@/lib/i18n";
import { YouFrame, youContext } from "./_shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "You — ShapesOS" };

export default async function YouGeneralPage() {
  const { prefs, email, name, i18n } = await youContext();
  const { t, messages, format } = i18n;
  const you = SETTINGS_GROUPS.find((g) => g.id === "you")!;
  const summary: Record<string, string> = {
    "/dashboard/settings/you/appearance": [
      t(`prefs.appearance.themes.${prefs.theme}`),
      t(`prefs.appearance.contrasts.${prefs.contrast}`),
      t(`prefs.fontScales.${prefs.fontScale}`),
      t(`prefs.appearance.densities.${prefs.density}`),
    ].join(" · "),
    "/dashboard/settings/you/language": [
      prefs.language ? t(`prefs.language.languages.${prefs.language}`) : t("prefs.language.matchBrowser"),
      (prefs.timeZone ?? t("prefs.language.notSet")).replace(/_/g, " "),
      format.date(new Date(), "time"),
    ].join(" · "),
    "/dashboard/settings/you/accessibility": t(`prefs.accessibility.motions.${prefs.motion}`),
    "/dashboard/settings/you/notifications": [
      `${t("prefs.notifications.inApp")}: ${prefs.notifications.inApp ? t("common.on") : t("common.off")}`,
      `${t("prefs.notifications.push")}: ${prefs.notifications.inApp && prefs.notifications.push ? t("common.on") : t("common.off")}`,
    ].join(" · "),
  };
  return (
    <YouFrame title={t("prefs.general.title")} subtitle={t("prefs.general.subtitle")} note={t("prefs.appliesEverywhere")}>
      <section className="rounded-lg bg-paper p-5 shadow-hairline">
        <p className="text-base font-semibold text-ink">{name ?? email ?? t("shell.signedIn")}</p>
        {email ? <p className="mt-0.5 text-sm text-muted">{t("prefs.general.signedInAs", { email })}</p> : null}
        <p className="mt-3 text-sm text-muted">
          <span className="font-semibold text-ink">{t("prefs.general.shortcutsTitle")}: </span>
          {t("prefs.general.shortcutsBody", { count: Object.keys(prefs.shortcuts).length })}
        </p>
      </section>
      <section aria-labelledby="you-links-h" className="rounded-lg bg-paper shadow-hairline">
        <h2 id="you-links-h" className="sr-only">
          {t("prefs.general.quickLinks")}
        </h2>
        <ul className="divide-y divide-line">
          {you.pages
            .filter((p) => p.href !== "/dashboard/settings/you")
            .map((p) => {
              const text = settingsPageText(messages, p.href);
              const Icon = p.icon;
              return (
                <li key={p.href}>
                  <Link href={p.href} className="flex min-h-row items-center gap-3 px-4 py-3 hover:bg-hover-paper sm:px-5">
                    <Icon size={16} className="shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-base font-semibold text-ink">{text.label ?? p.label}</span>
                      <span className="block truncate text-sm text-muted">{summary[p.href] ?? text.description ?? p.description}</span>
                    </span>
                    <ChevronRight size={16} className="shrink-0 text-muted" aria-hidden />
                  </Link>
                </li>
              );
            })}
        </ul>
      </section>
    </YouFrame>
  );
}
