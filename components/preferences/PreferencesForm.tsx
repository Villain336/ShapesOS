"use client";

// ShapesOS — Phase 18.1 (WS=find): Settings → You forms.
//
// One component per "You" page section, all saving through
// PATCH /api/preferences (the session's own row; zod-validated server-side).
// Appearance changes apply to <html> at once (the same classes the server
// renders — lib/preferences/shell.ts), then the server re-renders so every
// server component agrees. A language or time-zone change re-renders the
// page in the new language / zone.
//
// House style (docs/design/DESIGN.md): white cards with a hairline, 44px
// rows, pills for choices, Switch for on/off, tokens only, sentence case.

import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Segmented, Switch } from "@/components/aos/Controls";
import { StatusShape } from "@/components/aos/StatusShape";
import { aosButton } from "@/components/aos/button";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toast, toastError } from "@/lib/ui/feedback";
import {
  CONTRASTS,
  DENSITIES,
  FONT_SCALES,
  HOUR_CYCLES,
  LANGUAGES,
  MOTIONS,
  NOTIFICATION_KINDS,
  THEMES,
  // Phase 18.3 (WS=trust): Notifications 2.0 channels.
  EMAIL_DIGESTS,
  NOTIFICATION_CHANNELS,
  type EmailDigest,
  type NotificationChannel,
  type NotificationKindPref,
  type PreferencesPatch,
  type UserPreferences,
} from "@/lib/preferences/schema";
import { cellAvailable, channelOn, kindChannelChoice } from "@/lib/notifications/channels";
import { SHELL_CLASS_PREFIXES, shellClassNames, shellFrom } from "@/lib/preferences/shell";
import { formatDate } from "@/lib/i18n/format";

/** Apply the shell classes to <html> now (the server does the same on the next render). */
export function applyShellClasses(prefs: UserPreferences): void {
  const root = document.documentElement;
  for (const c of [...root.classList]) {
    if (c === "dark" || SHELL_CLASS_PREFIXES.some((p) => c.startsWith(p))) root.classList.remove(c);
  }
  for (const c of shellClassNames(shellFrom(prefs))) root.classList.add(c);
}

function usePreferences(initial: UserPreferences) {
  const router = useRouter();
  const { t } = useI18n();
  const [prefs, setPrefs] = useState(initial);
  const [saving, setSaving] = useState(false);

  const save = useCallback(
    async (patch: PreferencesPatch, opts: { refresh?: boolean } = {}) => {
      const before = prefs;
      const next = { ...prefs, ...patch } as UserPreferences;
      setPrefs(next);
      applyShellClasses(next);
      setSaving(true);
      try {
        const res = await fetch("/api/preferences", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const body = (await res.json().catch(() => ({}))) as { preferences?: UserPreferences; error?: string };
        if (!res.ok || !body.preferences) throw new Error(body.error ?? `HTTP ${res.status}`);
        setPrefs(body.preferences);
        applyShellClasses(body.preferences);
        toast({ title: t("prefs.savedToast"), status: "done" });
        if (opts.refresh !== false) router.refresh();
      } catch (e) {
        setPrefs(before);
        applyShellClasses(before);
        toastError(t("prefs.saveFailed"), e instanceof Error ? e.message : t("common.couldNotReach"));
      } finally {
        setSaving(false);
      }
    },
    [prefs, router, t],
  );
  return { prefs, save, saving };
}

function Card({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-line rounded-lg bg-paper shadow-hairline">{children}</div>;
}

/** A labelled row: title + helper on the left, the control on the right (stacks on phones). */
function Row({ title, help, children }: { title: string; help?: string; children: (ids: { labelId: string; helpId?: string }) => ReactNode }) {
  const id = useId();
  const labelId = `${id}-l`;
  const helpId = help ? `${id}-h` : undefined;
  return (
    <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:gap-6 sm:px-5">
      <div className="min-w-0 flex-1">
        <p id={labelId} className="text-base font-semibold text-ink">
          {title}
        </p>
        {help ? (
          <p id={helpId} className="mt-0.5 text-sm text-muted">
            {help}
          </p>
        ) : null}
      </div>
      <div className="shrink-0">{children({ labelId, helpId })}</div>
    </div>
  );
}

function SavingNote({ saving }: { saving: boolean }) {
  const { t } = useI18n();
  return (
    <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted">
      {saving ? t("common.saving") : ""}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

export function AppearanceForm({ initial }: { initial: UserPreferences }) {
  const { t } = useI18n();
  const { prefs, save, saving } = usePreferences(initial);
  const fontOptions = FONT_SCALES.map((v) => ({ value: v, label: t(`prefs.fontScales.${v}`) }));
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <Row title={t("prefs.appearance.theme")} help={t("prefs.appearance.themeHelp")}>
          {({ labelId }) => (
            <Segmented
              labelledBy={labelId}
              value={prefs.theme}
              onChange={(theme) => void save({ theme }, { refresh: false })}
              options={THEMES.map((v) => ({ value: v, label: t(`prefs.appearance.themes.${v}`) }))}
            />
          )}
        </Row>
        <Row title={t("prefs.appearance.contrast")} help={t("prefs.appearance.contrastHelp")}>
          {({ labelId }) => (
            <Segmented
              labelledBy={labelId}
              value={prefs.contrast}
              onChange={(contrast) => void save({ contrast }, { refresh: false })}
              options={CONTRASTS.map((v) => ({ value: v, label: t(`prefs.appearance.contrasts.${v}`) }))}
            />
          )}
        </Row>
        <Row title={t("prefs.appearance.textSize")} help={t("prefs.appearance.textSizeHelp")}>
          {({ labelId }) => (
            <Segmented labelledBy={labelId} value={prefs.fontScale} onChange={(fontScale) => void save({ fontScale }, { refresh: false })} options={fontOptions} />
          )}
        </Row>
        <Row title={t("prefs.appearance.density")} help={t("prefs.appearance.densityHelp")}>
          {({ labelId }) => (
            <Segmented
              labelledBy={labelId}
              value={prefs.density}
              onChange={(density) => void save({ density }, { refresh: false })}
              options={DENSITIES.map((v) => ({ value: v, label: t(`prefs.appearance.densities.${v}`) }))}
            />
          )}
        </Row>
      </Card>
      <PreviewCard />
      <SavingNote saving={saving} />
    </div>
  );
}

/** What the current look does to real components (status shapes keep their meaning). */
function PreviewCard() {
  const { t } = useI18n();
  return (
    <section aria-labelledby="prefs-preview-h" className="rounded-lg bg-paper p-5 shadow-hairline">
      <h2 id="prefs-preview-h" className="aos-subheading">
        {t("prefs.appearance.preview")}
      </h2>
      <p className="mt-1 text-md text-muted">{t("prefs.appearance.previewBody")}</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {(["running", "needs", "done", "failed"] as const).map((s) => (
          <span
            key={s}
            className={
              s === "running"
                ? "inline-flex h-badge items-center gap-1.5 rounded-full bg-running px-3 text-sm font-semibold text-paper"
                : s === "needs"
                  ? "inline-flex h-badge items-center gap-1.5 rounded-full bg-needs px-3 text-sm font-semibold text-ink"
                  : s === "done"
                    ? "inline-flex h-badge items-center gap-1.5 rounded-full bg-done px-3 text-sm font-semibold text-paper"
                    : "inline-flex h-badge items-center gap-1.5 rounded-full bg-failed px-3 text-sm font-semibold text-paper"
            }
          >
            <StatusShape status={s} size={10} tone="inherit" live={false} />
            {t(`status.${s}`)}
          </span>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={aosButton({ variant: "primary", size: "sm" })}>
          {t("shell.newTask")}
        </button>
        <button type="button" className={aosButton({ variant: "secondary", size: "sm" })}>
          {t("common.cancel")}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Language and region
// ---------------------------------------------------------------------------

function allTimeZones(): string[] {
  try {
    const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    if (zones?.length) return zones.includes("UTC") ? zones : ["UTC", ...zones];
  } catch {
    // older runtime
  }
  return ["UTC"];
}

export function LanguageForm({ initial }: { initial: UserPreferences }) {
  const { t, locale } = useI18n();
  const { prefs, save, saving } = usePreferences(initial);
  const zones = useMemo(allTimeZones, []);
  const device = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return null;
    }
  }, []);
  const langId = useId();
  const tzId = useId();
  const example = formatDate(new Date(), { locale, timeZone: prefs.timeZone, hourCycle: prefs.hourCycle }, "dateTime");
  const selectCls =
    "h-control w-full min-w-[16rem] rounded-md border-[1.5px] border-control bg-paper px-3 text-base text-ink focus:border-focus focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus:outline-none sm:w-72";
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <Row title={t("prefs.language.language")} help={t("prefs.language.languageHelp")}>
          {({ labelId, helpId }) => (
            <select
              id={langId}
              aria-labelledby={labelId}
              aria-describedby={helpId}
              className={selectCls}
              value={prefs.language ?? ""}
              onChange={(e) => void save({ language: (e.target.value || null) as UserPreferences["language"] })}
            >
              <option value="">{t("prefs.language.matchBrowser")}</option>
              {LANGUAGES.map((l) => (
                <option key={l} value={l} lang={l}>
                  {t(`prefs.language.languages.${l}`)}
                </option>
              ))}
            </select>
          )}
        </Row>
        <Row title={t("prefs.language.timeZone")} help={t("prefs.language.timeZoneHelp")}>
          {({ labelId, helpId }) => (
            <div className="flex flex-col items-start gap-2">
              <select
                id={tzId}
                aria-labelledby={labelId}
                aria-describedby={helpId}
                className={selectCls}
                value={prefs.timeZone ?? ""}
                onChange={(e) => void save({ timeZone: e.target.value || null })}
              >
                <option value="">{t("prefs.language.notSet")}</option>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
              {device && device !== prefs.timeZone ? (
                <button type="button" className={aosButton({ variant: "quiet", size: "xs" })} onClick={() => void save({ timeZone: device })}>
                  {t("prefs.language.useDevice", { zone: device.replace(/_/g, " ") })}
                </button>
              ) : null}
            </div>
          )}
        </Row>
        <Row title={t("prefs.language.hourCycle")} help={t("prefs.language.example", { date: example })}>
          {({ labelId }) => (
            <Segmented
              labelledBy={labelId}
              value={prefs.hourCycle}
              onChange={(hourCycle) => void save({ hourCycle })}
              options={HOUR_CYCLES.map((v) => ({ value: v, label: t(`prefs.language.hourCycles.${v}`) }))}
            />
          )}
        </Row>
      </Card>
      <SavingNote saving={saving} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

export function AccessibilityForm({ initial }: { initial: UserPreferences }) {
  const { t } = useI18n();
  const { prefs, save, saving } = usePreferences(initial);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <Row title={t("prefs.accessibility.motion")} help={t("prefs.accessibility.motionHelp")}>
          {({ labelId }) => (
            <Segmented
              labelledBy={labelId}
              value={prefs.motion}
              onChange={(motion) => void save({ motion }, { refresh: false })}
              options={MOTIONS.map((v) => ({ value: v, label: t(`prefs.accessibility.motions.${v}`) }))}
            />
          )}
        </Row>
        <Row title={t("prefs.accessibility.contrast")} help={t("prefs.accessibility.contrastHelp")}>
          {({ labelId, helpId }) => (
            <Switch
              checked={prefs.contrast === "high"}
              labelledBy={labelId}
              describedBy={helpId}
              onChange={(on) => void save({ contrast: on ? "high" : "standard" }, { refresh: false })}
            />
          )}
        </Row>
        <Row title={t("prefs.accessibility.textSize")} help={t("prefs.appearance.textSizeHelp")}>
          {({ labelId }) => (
            <Segmented
              labelledBy={labelId}
              value={prefs.fontScale}
              onChange={(fontScale) => void save({ fontScale }, { refresh: false })}
              options={FONT_SCALES.map((v) => ({ value: v, label: t(`prefs.fontScales.${v}`) }))}
            />
          )}
        </Row>
      </Card>
      <p className="rounded-md border border-line bg-canvas px-4 py-3 text-sm text-muted">{t("prefs.accessibility.focusNote")}</p>
      <SavingNote saving={saving} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export function NotificationPrefsForm({ initial }: { initial: UserPreferences }) {
  const { t } = useI18n();
  const { prefs, save, saving } = usePreferences(initial);
  const n = prefs.notifications;
  const kindsId = useId();
  const put = (patch: Partial<typeof n>) => void save({ notifications: { ...n, ...patch } }, { refresh: false });
  // Phase 18.3 (WS=trust): kind × channel. A cell is a checkbox; its channel's
  // switch above (or a muted kind) turns the whole column / row off.
  const setCell = (kind: NotificationKindPref, channel: NotificationChannel, on: boolean) =>
    put({ channels: { ...n.channels, [kind]: { ...(n.channels[kind] ?? {}), [channel]: on } } });
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <Row title={t("prefs.notifications.inApp")} help={t("prefs.notifications.inAppHelp")}>
          {({ labelId, helpId }) => <Switch checked={n.inApp} labelledBy={labelId} describedBy={helpId} onChange={(inApp) => put({ inApp })} />}
        </Row>
        <Row title={t("prefs.notifications.push")} help={t("prefs.notifications.pushHelp")}>
          {({ labelId, helpId }) => (
            <Switch checked={n.inApp && n.push} disabled={!n.inApp} labelledBy={labelId} describedBy={helpId} onChange={(push) => put({ push })} />
          )}
        </Row>
        <Row title={t("trust.notifications.webPush")} help={t("trust.notifications.webPushHelp")}>
          {({ labelId, helpId }) => <Switch checked={n.webPush} labelledBy={labelId} describedBy={helpId} onChange={(webPush) => put({ webPush })} />}
        </Row>
        <Row title={t("trust.notifications.emailDigest")} help={t("trust.notifications.emailDigestHelp")}>
          {({ labelId }) => (
            <Segmented<EmailDigest>
              value={n.emailDigest}
              labelledBy={labelId}
              onChange={(emailDigest) => put({ emailDigest })}
              options={EMAIL_DIGESTS.map((d) => ({ value: d, label: t(`trust.notifications.digest.${d}`) }))}
            />
          )}
        </Row>
        <Row title={t("trust.notifications.slack")} help={t("trust.notifications.slackHelp")}>
          {({ labelId, helpId }) => <Switch checked={n.slack} labelledBy={labelId} describedBy={helpId} onChange={(slack) => put({ slack })} />}
        </Row>
        <Row title={t("trust.notifications.summary")} help={t("trust.notifications.summaryHelp")}>
          {({ labelId, helpId }) => <Switch checked={n.summary} labelledBy={labelId} describedBy={helpId} onChange={(summary) => put({ summary })} />}
        </Row>
      </Card>
      <section aria-labelledby={kindsId} className="rounded-lg bg-paper shadow-hairline">
        <div className="px-4 pt-4 sm:px-5">
          <h2 id={kindsId} className="aos-subheading">
            {t("trust.notifications.channelsTitle")}
          </h2>
          <p className="mt-0.5 text-sm text-muted">{t("trust.notifications.channelsHelp")}</p>
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm" data-testid="notification-grid">
            <caption className="sr-only">{t("trust.notifications.channelsTitle")}</caption>
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-muted sm:px-5">
                  {t("trust.notifications.kind")}
                </th>
                {NOTIFICATION_CHANNELS.map((c) => (
                  <th key={c} scope="col" className="px-2 py-2.5 text-center text-xs font-semibold text-muted">
                    {t(`trust.notifications.channels.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {NOTIFICATION_KINDS.map((kind) => {
                const muted = n.mutedKinds.includes(kind);
                const kindName = t(`prefs.notifications.kindNames.${kind}`);
                return (
                  <tr key={kind} className="border-b border-line last:border-0" data-kind={kind}>
                    <th scope="row" className="px-4 py-2 text-left font-normal sm:px-5">
                      <span className="flex items-center gap-3">
                        <Switch
                          checked={!muted}
                          label={kindName}
                          onChange={(on) => put({ mutedKinds: on ? n.mutedKinds.filter((k) => k !== kind) : [...n.mutedKinds, kind] })}
                        />
                        <span className={`text-base font-semibold ${muted ? "text-muted" : "text-ink"}`}>{kindName}</span>
                      </span>
                    </th>
                    {NOTIFICATION_CHANNELS.map((c) => {
                      const available = cellAvailable(kind, c);
                      const columnOn = channelOn(n, c);
                      const checked = available && kindChannelChoice(n, kind, c);
                      return (
                        <td key={c} className="px-2 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={muted || !available || !columnOn || c === "inApp"}
                            onChange={(e) => setCell(kind, c, e.target.checked)}
                            aria-label={t("trust.notifications.channelFor", { kind: kindName, channel: t(`trust.notifications.channels.${c}`) })}
                            className="size-5 cursor-pointer accent-[var(--aos-ink)] disabled:cursor-not-allowed disabled:opacity-40"
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <p className="text-sm text-muted">{t("trust.notifications.focusNote")}</p>
      <p className="text-sm text-muted">{t("prefs.notifications.workspaceDefaults")}</p>
      <SavingNote saving={saving} />
    </div>
  );
}
