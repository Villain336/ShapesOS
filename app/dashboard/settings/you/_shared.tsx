// ShapesOS — Phase 18.1 (WS=find): shared frame for Settings → You pages.
// Any signed-in member: these are the person's own preferences (no workspace
// role needed — they never touch workspace data).

import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/session";
import SettingsNav from "@/components/settings/SettingsNav";
import { getUserPreferencesCached, type UserPreferences } from "@/lib/preferences";
import { getI18n, type ServerI18n } from "@/lib/i18n/server";

export async function youContext(): Promise<{ userId: string; email: string | null; name: string | null; prefs: UserPreferences; i18n: ServerI18n }> {
  const user = await requireUser();
  if (!user?.id) redirect("/login");
  const [prefs, i18n] = await Promise.all([getUserPreferencesCached(user.id), getI18n()]);
  return { userId: user.id, email: user.email ?? null, name: user.name ?? null, prefs, i18n };
}

export function YouFrame({ title, subtitle, note, children }: { title: string; subtitle: string; note?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">{title}</h1>
        <p className="mt-0.5 text-sm text-muted">{subtitle}</p>
      </div>
      <SettingsNav />
      <div className="flex max-w-3xl flex-col gap-4">
        {children}
        {note ? <p className="text-sm text-muted">{note}</p> : null}
      </div>
    </div>
  );
}
