// ShapesOS — settings navigation (Phase 3: grouped).
// Two tiers: the six setting groups as pills (the current group is the
// pressed, solid-black one), then the current group's pages as tabs
// (active = black underline). Groups and pages come from settingsSections.ts,
// shared with the /dashboard/settings index. Client component so the active
// state follows the pathname.
//
// Phase 18.3 (WS=trust): System Settings in two halves — the "You" pill, a
// divider, then the workspace's groups — and settings search: typing filters
// every page of both halves (label, description and group, in the person's
// language); the results replace the tabs until the search is cleared.

"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { Search, X } from "lucide-react";
import { SETTINGS_GROUPS, searchSettings, settingsLocation } from "./settingsSections";
// Phase 18.1 (WS=find): labels in the person's language.
import { useI18n } from "@/components/i18n/I18nProvider";

export default function SettingsNav() {
  const pathname = usePathname();
  const onIndex = pathname === "/dashboard/settings";
  const { group: current, page: currentPage } = settingsLocation(pathname);
  const { t, messages, settingsPage } = useI18n();
  const groupLabel = (id: string, fallback: string) => (messages.settings.groups as Record<string, string>)[id] ?? fallback;
  const [query, setQuery] = useState("");
  const searchId = useId();
  const results = useMemo(
    () =>
      searchSettings(query, (p, groupId) => {
        const g = SETTINGS_GROUPS.find((x) => x.id === groupId);
        return { ...settingsPage(p.href, p), group: g ? groupLabel(g.id, g.label) : "" };
      }),
    // groupLabel/settingsPage read `messages`, which is what changes them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, messages],
  );
  const searching = query.trim().length > 0;

  return (
    <div className="mb-4 flex flex-col gap-3">
      <div role="search" className="relative max-w-sm">
        <label htmlFor={searchId} className="sr-only">
          {t("settings.search.label")}
        </label>
        <Search size={16} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
          placeholder={t("settings.search.placeholder")}
          autoComplete="off"
          className="h-control w-full rounded-md border-[1.5px] border-control bg-paper pl-9 pr-10 text-base text-ink placeholder:text-subtle outline-none transition-[border-color,box-shadow] duration-150 focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]"
        />
        {searching ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label={t("settings.search.clear")}
            className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-ink"
          >
            <X size={15} aria-hidden />
          </button>
        ) : null}
      </div>

      <nav aria-label={t("settings.sections")} className="flex flex-wrap items-center gap-2">
        {SETTINGS_GROUPS.map((g, i) => {
          const active = !onIndex && !searching && g.id === current.id;
          const Icon = g.icon;
          const startsWorkspace = g.half === "workspace" && SETTINGS_GROUPS[i - 1]?.half === "you";
          return (
            <span key={g.id} className="contents">
              {startsWorkspace ? <span aria-hidden className="mx-1 h-6 w-px bg-line-strong" /> : null}
              <Link
                href={g.pages[0]!.href}
                aria-current={active ? "true" : undefined}
                className={`inline-flex h-chip items-center gap-1.5 rounded-full px-3 text-sm font-semibold transition-colors ${
                  active ? "bg-ink text-paper" : "bg-paper text-ink shadow-control hover:shadow-outline"
                }`}
              >
                <Icon size={14} aria-hidden />
                {groupLabel(g.id, g.label)}
              </Link>
            </span>
          );
        })}
      </nav>

      {searching ? (
        <section aria-label={t("settings.search.label")} className="rounded-lg bg-paper shadow-hairline">
          <p role="status" className="border-b border-line px-4 py-2 text-sm text-muted">
            {results.length ? t("settings.search.results", { count: results.length }) : t("settings.search.empty", { query: query.trim() })}
          </p>
          {results.length ? (
            <ul className="divide-y divide-line">
              {results.map((p) => {
                const Icon = p.icon;
                const text = settingsPage(p.href, p);
                const g = SETTINGS_GROUPS.find((x) => x.id === p.groupId);
                return (
                  <li key={p.href}>
                    <Link
                      href={p.href}
                      onClick={() => setQuery("")}
                      aria-current={currentPage?.href === p.href ? "page" : undefined}
                      className="flex min-h-row items-center gap-3 px-4 py-2.5 hover:bg-hover-paper"
                    >
                      <Icon size={16} aria-hidden className="shrink-0 text-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-base font-semibold text-ink">{text.label}</span>
                        <span className="block truncate text-sm text-muted">{text.description}</span>
                      </span>
                      {g ? <span className="shrink-0 text-xs font-semibold text-subtle">{groupLabel(g.id, g.label)}</span> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      ) : !onIndex ? (
        <nav aria-label={t("settings.groupSettings", { group: groupLabel(current.id, current.label) })} className="flex flex-wrap gap-1 border-b border-line">
          {current.pages.map((p) => {
            const active = currentPage?.href === p.href;
            const Icon = p.icon;
            return (
              <Link
                key={p.href}
                href={p.href}
                aria-current={active ? "page" : undefined}
                className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-md font-medium transition-colors ${
                  active ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
                }`}
              >
                <Icon size={15} aria-hidden />
                {settingsPage(p.href, p).label}
              </Link>
            );
          })}
        </nav>
      ) : null}
    </div>
  );
}
