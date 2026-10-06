"use client";

// ShapesOS — Phase 18.2 (WS=comms): the Contacts app (/dashboard/contacts).
// One address book: one row per PERSON across the four people stores
// (identity links — lib/comms/contacts/store.ts), searchable; and the merge
// suggestions a person confirms ("Merge") or rejects ("Not the same
// person", remembered). Nothing merges on its own.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, GitMerge, Loader2, Search, Users } from "lucide-react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { aosButton } from "@/components/aos/button";
import { FilterPill } from "@/components/aos/FilterPill";
import { cn } from "@/lib/utils";
import { Card, Chip, EmptyState, ErrorLine, inputCls, PageHeader, PersonTile } from "./ui";

type Kind = "lead" | "ops_contact" | "connector_person" | "funding_contact";

interface ContactRow {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  companies: string[];
  recordCount: number;
  kinds: Kind[];
}

interface Side {
  kind: Kind;
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  company: string | null;
  href: string;
  identityId: string | null;
}

export interface SuggestionItem {
  id: string;
  score: number;
  reasons: ("email" | "phone" | "name_company" | "name_domain" | "name")[];
  status: string;
  proposedVia: string;
  a: Side;
  b: Side;
}

async function readError(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export function ContactsApp({ canMerge, initialTab = "people" }: { canMerge: boolean; initialTab?: "people" | "suggestions" }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"people" | "suggestions">(initialTab);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ContactRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0);

  const load = useCallback(
    async (query: string, offset = 0) => {
      const my = ++seq.current;
      try {
        const res = await fetch(`/api/comms/contacts?q=${encodeURIComponent(query)}&offset=${offset}`, { cache: "no-store" });
        if (!res.ok) throw new Error(await readError(res));
        const j = (await res.json()) as { items: ContactRow[]; total: number; pendingSuggestions: number };
        if (my !== seq.current) return;
        setItems((prev) => (offset > 0 && prev ? [...prev, ...j.items] : j.items));
        setTotal(j.total);
        setPending(j.pendingSuggestions);
        setError(null);
      } catch (e) {
        if (my === seq.current) setError(t("comms.common.loadError", { error: e instanceof Error ? e.message : "" }));
        setItems((prev) => prev ?? []);
      }
    },
    [t],
  );

  useEffect(() => {
    const h = setTimeout(() => void load(q), q ? 200 : 0);
    return () => clearTimeout(h);
  }, [q, load]);

  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-4">
      <PageHeader title={t("comms.contacts.title")} subtitle={t("comms.contacts.subtitle")} />
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("comms.contacts.title")}>
        <FilterPill selected={tab === "people"} onClick={() => setTab("people")}>
          {t("comms.contacts.people")}
        </FilterPill>
        <FilterPill selected={tab === "suggestions"} onClick={() => setTab("suggestions")} count={pending}>
          {t("comms.contacts.suggestions")}
        </FilterPill>
      </div>
      <ErrorLine message={error} />
      {tab === "people" ? (
        <Card>
          <div className="border-b border-line p-3">
            <label htmlFor="contacts-search" className="sr-only">
              {t("comms.contacts.searchLabel")}
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <input id="contacts-search" type="search" className={cn(inputCls, "pl-10")} placeholder={t("comms.contacts.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {items ? <p className="mt-2 text-sm text-muted" aria-live="polite">{t("comms.contacts.count", { count: total })}</p> : null}
          </div>
          {items === null ? (
            <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t("common.loading")}
            </p>
          ) : items.length === 0 ? (
            q ? <EmptyState icon={Search} title={t("comms.contacts.noMatches", { q })} /> : <EmptyState icon={Users} title={t("comms.contacts.emptyTitle")} body={t("comms.contacts.emptyBody")} />
          ) : (
            <ul className="divide-y divide-line">
              {items.map((c) => (
                <li key={c.id}>
                  <Link href={`/dashboard/contacts/${encodeURIComponent(c.id)}`} className="flex min-h-row items-center gap-3 px-4 py-2.5 hover:bg-hover-paper">
                    <PersonTile name={c.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-md font-semibold text-ink">{c.name}</span>
                      <span className="block truncate text-sm text-muted">{[c.companies[0], c.emails[0], c.phones[0]].filter(Boolean).join(" · ") || "—"}</span>
                    </span>
                    <span className="hidden flex-wrap justify-end gap-1 sm:flex">
                      {c.kinds.map((k) => (
                        <Chip key={k}>{t(`comms.contacts.kinds.${k}`)}</Chip>
                      ))}
                    </span>
                    {c.recordCount > 1 ? <span className="shrink-0 text-xs font-semibold text-muted tabular-nums">{t("comms.contacts.records", { count: c.recordCount })}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {items && items.length < total ? (
            <div className="border-t border-line p-3">
              <button
                type="button"
                className={aosButton({ variant: "secondary", size: "sm" })}
                disabled={loadingMore}
                onClick={async () => {
                  setLoadingMore(true);
                  await load(q, items.length);
                  setLoadingMore(false);
                }}
              >
                {t("comms.contacts.loadMore")}
              </button>
            </div>
          ) : null}
        </Card>
      ) : (
        <SuggestionsList canMerge={canMerge} onChanged={() => void load(q)} />
      )}
    </div>
  );
}

export function SuggestionsList({ canMerge, onChanged, identityId }: { canMerge: boolean; onChanged?: () => void; identityId?: string }) {
  const { t } = useI18n();
  const [items, setItems] = useState<SuggestionItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, "merged" | "rejected">>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/comms/contacts/suggestions", { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      const j = (await res.json()) as { items: SuggestionItem[] };
      setItems(identityId ? j.items.filter((s) => s.a.identityId === identityId || s.b.identityId === identityId) : j.items);
    } catch (e) {
      setError(t("comms.common.loadError", { error: e instanceof Error ? e.message : "" }));
      setItems([]);
    }
  }, [identityId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(id: string, decision: "confirm" | "reject") {
    setBusy(`${id}:${decision}`);
    setError(null);
    try {
      const res = await fetch(`/api/comms/contacts/suggestions/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setDone((d) => ({ ...d, [id]: decision === "confirm" ? "merged" : "rejected" }));
      onChanged?.();
    } catch (e) {
      setError(t("comms.common.saveError", { error: e instanceof Error ? e.message : "" }));
    } finally {
      setBusy(null);
    }
  }

  if (items === null) {
    return (
      <p className="flex items-center gap-2 px-1 py-4 text-sm text-muted" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("common.loading")}
      </p>
    );
  }
  if (items.length === 0) {
    if (identityId) return null;
    return (
      <Card>
        <EmptyState icon={GitMerge} title={t("comms.contacts.suggestionsEmptyTitle")} body={t("comms.contacts.suggestionsEmptyBody")} />
      </Card>
    );
  }
  const side = (s: Side) => (
    <div className="min-w-0 flex-1 rounded-md bg-canvas p-3">
      <div className="flex items-center gap-2">
        <Chip>{t(`comms.contacts.kinds.${s.kind}`)}</Chip>
        <a href={s.href} className="truncate text-md font-semibold text-ink hover:underline">
          {s.name}
        </a>
      </div>
      <p className="mt-1.5 truncate text-sm text-muted">{[s.company, ...s.emails, ...s.phones].filter(Boolean).join(" · ") || "—"}</p>
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      <ErrorLine message={error} />
      {!canMerge ? <p className="text-sm text-muted">{t("comms.contacts.editorOnly")}</p> : null}
      {items.map((s) => (
        <Card key={s.id} as="article" aria-label={t("comms.contacts.suggestionTitle")} className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-ink">{t("comms.contacts.suggestionTitle")}</h2>
            <div className="flex flex-wrap items-center gap-1.5">
              {s.reasons.map((r) => (
                <Chip key={r}>{t(`comms.contacts.reasons.${r}`)}</Chip>
              ))}
              <span className="text-xs font-semibold text-muted tabular-nums">{t("comms.contacts.confidence", { score: Math.round(s.score * 100) })}</span>
              {s.proposedVia === "agent" ? <Chip>{t("comms.contacts.proposedByAgent")}</Chip> : null}
            </div>
          </div>
          <div className="mt-3 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            {side(s.a)}
            <ArrowRight className="hidden size-4 shrink-0 text-muted sm:block" aria-hidden />
            {side(s.b)}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            {done[s.id] ? (
              <p role="status" className="text-sm font-semibold text-ink">
                {done[s.id] === "merged" ? t("comms.contacts.merged") : t("comms.contacts.rejected")}
              </p>
            ) : canMerge ? (
              <>
                <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} disabled={!!busy} onClick={() => decide(s.id, "reject")}>
                  {t("comms.contacts.notSame")}
                </button>
                <button type="button" className={aosButton({ variant: "primary", size: "sm" })} disabled={!!busy} onClick={() => decide(s.id, "confirm")}>
                  {busy === `${s.id}:confirm` ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <GitMerge className="size-4" aria-hidden />}
                  {busy === `${s.id}:confirm` ? t("comms.contacts.merging") : t("comms.contacts.merge")}
                </button>
              </>
            ) : null}
          </div>
        </Card>
      ))}
    </div>
  );
}
