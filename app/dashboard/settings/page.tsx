// ShapesOS — workspace settings index (Phase 13 A1; grouped in Phase 3).
// Every settings page, grouped into six sections (components/settings/
// settingsSections.ts — the same source as the SettingsNav tab strip).

import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import SettingsNav from "@/components/settings/SettingsNav";
// Phase 18.3 (WS=trust): the two halves of System Settings.
import { settingsHalf, type SettingsHalf } from "@/components/settings/settingsSections";
// Phase 18.1 (WS=find): "You" first, every label in the person's language.
import { getI18n } from "@/lib/i18n/server";
import { settingsPageText } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Settings — ShapesOS",
  description: "Your preferences and the workspace's settings: members, billing, integrations, brand, and developer access.",
};

export default async function SettingsLandingPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const { t, messages } = await getI18n();
  const groupLabels = messages.settings.groups as Record<string, string>;

  return (
    <div className="bg-canvas p-4 md:p-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <div>
          <h1 className="aos-heading">{t("settings.title")}</h1>
          <p className="mt-0.5 text-sm text-muted">{t("settings.subtitle", { workspace: workspace.name })}</p>
        </div>
        <SettingsNav />
        <div className="flex flex-col gap-8">
          {(["you", "workspace"] as SettingsHalf[]).map((half) => (
            <section key={half} aria-labelledby={`settings-half-${half}`} className="flex flex-col gap-5">
              <h2 id={`settings-half-${half}`} className="aos-subheading border-b border-line pb-2">
                {t(`settings.halves.${half}`)}
              </h2>
              {settingsHalf(half).map((group) => {
                const GroupIcon = group.icon;
                return (
                  <section key={group.id} aria-labelledby={`settings-${group.id}`}>
                    <h3 id={`settings-${group.id}`} className="flex items-center gap-2 text-base font-bold stretch-heading text-ink">
                      <GroupIcon size={18} aria-hidden />
                      {groupLabels[group.id] ?? group.label}
                    </h3>
                    <ul className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                      {group.pages.map((s) => {
                        const Icon = s.icon;
                        const text = settingsPageText(messages, s.href);
                        return (
                          <li key={s.href}>
                            <Link
                              href={s.href}
                              className="group flex items-start gap-3 rounded-sm px-3 py-2.5 transition-colors hover:bg-hover"
                            >
                              <Icon size={16} className="mt-0.5 shrink-0 text-muted transition-colors group-hover:text-ink" aria-hidden />
                              <span className="min-w-0">
                                <span className="block text-base font-semibold text-ink">{text.label ?? s.label}</span>
                                <span className="block text-sm leading-snug text-muted">{text.description ?? s.description}</span>
                              </span>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
