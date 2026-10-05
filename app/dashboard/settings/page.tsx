// ShapesOS — workspace settings index (Phase 13 A1; grouped in Phase 3).
// Every settings page, grouped into six sections (components/settings/
// settingsSections.ts — the same source as the SettingsNav tab strip).

import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import SettingsNav from "@/components/settings/SettingsNav";
import { SETTINGS_GROUPS } from "@/components/settings/settingsSections";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Settings — ShapesOS",
  description: "Workspace settings: members, billing, integrations, brand, and developer access.",
};

export default async function SettingsLandingPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  return (
    <div className="bg-canvas p-4 md:p-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <div>
          <h1 className="aos-heading">Settings</h1>
          <p className="mt-0.5 text-sm text-muted">{workspace.name}: every workspace setting, by section.</p>
        </div>
        <SettingsNav />
        <div className="flex flex-col gap-6">
          {SETTINGS_GROUPS.map((group) => {
            const GroupIcon = group.icon;
            return (
              <section key={group.id} aria-labelledby={`settings-${group.id}`}>
                <h2 id={`settings-${group.id}`} className="aos-subheading flex items-center gap-2">
                  <GroupIcon size={18} aria-hidden />
                  {group.label}
                </h2>
                <ul className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                  {group.pages.map((s) => {
                    const Icon = s.icon;
                    return (
                      <li key={s.href}>
                        <Link
                          href={s.href}
                          className="group flex items-start gap-3 rounded-sm px-3 py-2.5 transition-colors hover:bg-hover"
                        >
                          <Icon size={16} className="mt-0.5 shrink-0 text-muted transition-colors group-hover:text-ink" aria-hidden />
                          <span className="min-w-0">
                            <span className="block text-base font-semibold text-ink">{s.label}</span>
                            <span className="block text-sm leading-snug text-muted">{s.description}</span>
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
