// ShapesOS — Phase 18.3 (WS=trust): Settings → You → Keyboard.
//
// The 18.1 shortcut registry (lib/keyboard/shortcuts.ts) with the person's
// own bindings (UserPreference.shortcuts, read through the desk adapter so a
// stale or clashing binding is dropped exactly as the keyboard host drops
// it). Rebinding happens in the existing shortcut sheet — this page opens it.

import { headers } from "next/headers";
import { KeyCaps } from "@/components/aos/AgentAvatar";
import { SHORTCUTS, comboKeycaps, effectiveCombo, type ShortcutGroup } from "@/lib/keyboard/shortcuts";
import { getUserPreferences as getDeskPreferences } from "@/lib/desktop/prefs";
import { shortcutText } from "@/lib/i18n";
import { OpenShortcutsButton } from "@/components/trust/OpenShortcutsButton";
import { YouFrame, youContext } from "../_shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "Keyboard — ShapesOS" };

const GROUP_ORDER: ShortcutGroup[] = ["General", "Navigation", "Agents", "App switcher", "Split view", "Desktop"];

export default async function KeyboardSettingsPage() {
  const { userId, i18n } = await youContext();
  const { t, messages } = i18n;
  const ua = (await headers()).get("user-agent") ?? "";
  const mac = /mac|iphone|ipad/i.test(ua);
  const overrides = (await getDeskPreferences(userId).catch(() => null))?.shortcuts ?? {};
  const groups = GROUP_ORDER.map((g) => ({ group: g, items: SHORTCUTS.filter((s) => s.group === g) })).filter((g) => g.items.length);
  return (
    <YouFrame title={t("trust.keyboard.title")} subtitle={t("trust.keyboard.subtitle")} note={t("prefs.appliesEverywhere")}>
      <section className="flex flex-col gap-3 rounded-lg bg-paper p-5 shadow-hairline sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-ink">{t("prefs.general.shortcutsBody", { count: Object.keys(overrides).length })}</p>
          <p className="mt-0.5 text-sm text-muted">{t("trust.keyboard.changeHelp")}</p>
        </div>
        <OpenShortcutsButton label={t("trust.keyboard.change")} />
      </section>
      {groups.map(({ group, items }) => {
        const id = `kb-${group.replace(/\s+/g, "-").toLowerCase()}`;
        return (
          <section key={group} aria-labelledby={id} className="rounded-lg bg-paper shadow-hairline">
            <h2 id={id} className="px-4 pt-4 text-base font-bold stretch-heading text-ink sm:px-5">
              {t(`desk.shortcuts.groups.${group}`)}
            </h2>
            <ul className="mt-2 divide-y divide-line">
              {items.map((s) => {
                const text = shortcutText(messages, s.id);
                const changed = !!overrides[s.id];
                return (
                  <li key={s.id} className="flex min-h-row flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 sm:px-5" data-shortcut={s.id}>
                    <span className="min-w-0 flex-1">
                      <span className="block text-base font-medium text-ink">{text.label ?? s.label}</span>
                      {s.hint ? <span className="block text-xs text-muted">{text.hint ?? s.hint}</span> : null}
                    </span>
                    {changed ? (
                      <span className="inline-flex h-6 items-center rounded-full bg-canvas px-2.5 text-xs font-semibold text-ink">{t("trust.keyboard.changed")}</span>
                    ) : !s.rebindable ? (
                      <span className="text-xs text-subtle">{t("trust.keyboard.fixed")}</span>
                    ) : null}
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      {comboKeycaps(effectiveCombo(s.id, overrides), mac).map((step, i) => (
                        <span key={i} className="inline-flex items-center gap-1">
                          {i > 0 ? <span className="text-xs text-muted">{t("desk.shortcuts.then")}</span> : null}
                          <KeyCaps keys={step} />
                        </span>
                      ))}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </YouFrame>
  );
}
