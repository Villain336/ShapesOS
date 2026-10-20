"use client";

// ShapesOS — Phase 18.2 (WS=comms): one person's card (/dashboard/contacts/[id]).
// Every linked record (each opens in its own app; editors can unlink one),
// the timeline across them, pending merge suggestions about them, and
// actions: email them (Mail compose), remind me, ask an agent.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlarmClock, ArrowLeft, ArrowUpRight, Bot, Loader2, Mail, Unlink } from "lucide-react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { aosButton } from "@/components/aos/button";
import { Card, Chip, ErrorLine, iconBtnCls, PersonTile } from "./ui";
import { SuggestionsList } from "./ContactsApp";
import { openNewTask } from "@/components/command-bar/NewTaskDialog";
import { ShareMenu } from "@/components/share/ShareMenu";

type Kind = "lead" | "ops_contact" | "connector_person" | "funding_contact";
type TimelineType = "mail" | "sms" | "meeting" | "call" | "deal" | "ticket" | "invoice" | "note" | "funding" | "booking";

interface Detail {
  identity: { id: string; name: string; emails: string[]; phones: string[]; companies: string[]; recordCount: number; kinds: Kind[] };
  records: { kind: Kind; id: string; name: string; emails: string[]; phones: string[]; company: string | null; title: string | null; href: string; linkedVia: string; confirmedAt: string | null }[];
  timeline: { key: string; at: string; type: TimelineType; title: string; detail: string | null; href: string | null }[];
}

async function readError(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export function ContactCard({ identityId, canEdit }: { identityId: string; canEdit: boolean }) {
  const { t, format } = useI18n();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/comms/contacts/${encodeURIComponent(identityId)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      setD((await res.json()) as Detail);
      setError(null);
    } catch (e) {
      setError(t("comms.common.loadError", { error: e instanceof Error ? e.message : "" }));
    }
  }, [identityId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function unlink(kind: Kind, recordId: string) {
    setBusy(`${kind}:${recordId}`);
    try {
      const res = await fetch(`/api/comms/contacts/${encodeURIComponent(identityId)}/unlink`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, recordId }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setNote(t("comms.contacts.unlinked"));
      await load();
    } catch (e) {
      setError(t("comms.common.saveError", { error: e instanceof Error ? e.message : "" }));
    } finally {
      setBusy(null);
    }
  }

  async function remind() {
    if (!d) return;
    setBusy("remind");
    try {
      const res = await fetch("/api/comms/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t("comms.contacts.reminderTitle", { name: d.identity.name }) }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setNote(t("comms.contacts.reminderAdded"));
    } catch (e) {
      setError(t("comms.common.saveError", { error: e instanceof Error ? e.message : "" }));
    } finally {
      setBusy(null);
    }
  }

  if (!d) {
    return (
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-4">
        <BackLink />
        {error ? (
          <ErrorLine message={error} />
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t("common.loading")}
          </p>
        )}
      </div>
    );
  }
  const email = d.identity.emails[0];
  const ask = t("comms.contacts.askAgentPrompt", { name: d.identity.name });
  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-4">
      <BackLink />
      <div className="flex flex-wrap items-center gap-4">
        <PersonTile name={d.identity.name} size={56} className="rounded-md" />
        <div className="min-w-0 flex-1">
          <h1 className="aos-heading break-words text-ink">{d.identity.name}</h1>
          <p className="mt-1 text-sm text-muted">{[d.identity.companies.join(", "), t("comms.contacts.records", { count: d.records.length })].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2" aria-label={t("comms.contacts.actions")}>
          {email ? (
            <Link href={`/dashboard/mail?compose=1&to=${encodeURIComponent(email)}`} className={aosButton({ variant: "primary", size: "sm" })}>
              <Mail className="size-4" aria-hidden />
              {t("comms.contacts.email")}
            </Link>
          ) : null}
          <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={remind} disabled={busy === "remind"}>
            <AlarmClock className="size-4" aria-hidden />
            {t("comms.contacts.addReminder")}
          </button>
          <button type="button" onClick={() => openNewTask("lead", ask)} className={aosButton({ variant: "secondary", size: "sm" })}>
            <Bot className="size-4" aria-hidden />
            {t("comms.contacts.askAgent")}
          </button>
          {/* Phase 18.3 (WS=flow): the share sheet (Send to… / Open with). */}
          <ShareMenu record={{ kind: "contact", id: identityId, title: d.identity.name, href: `/dashboard/contacts/${encodeURIComponent(identityId)}` }} role={canEdit ? "editor" : "viewer"} size="sm" />
        </div>
      </div>
      <ErrorLine message={error} />
      {note ? (
        <p role="status" className="text-sm text-muted">
          {note}
        </p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card aria-labelledby="contact-details" className="p-4">
            <h2 id="contact-details" className="sr-only">
              {d.identity.name}
            </h2>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="font-semibold text-ink">{t("comms.contacts.emails")}</dt>
              <dd className="min-w-0 break-words text-muted">{d.identity.emails.join(", ") || "—"}</dd>
              <dt className="font-semibold text-ink">{t("comms.contacts.phones")}</dt>
              <dd className="min-w-0 break-words text-muted">{d.identity.phones.join(", ") || "—"}</dd>
              <dt className="font-semibold text-ink">{t("comms.contacts.companies")}</dt>
              <dd className="min-w-0 break-words text-muted">{d.identity.companies.join(", ") || "—"}</dd>
            </dl>
          </Card>
          <Card aria-labelledby="contact-records">
            <div className="px-4 pt-4">
              <h2 id="contact-records" className="aos-subheading text-ink">
                {t("comms.contacts.recordsTitle")}
              </h2>
              <p className="mt-1 text-sm text-muted">{t("comms.contacts.recordsHelp")}</p>
            </div>
            <ul className="mt-2 divide-y divide-line">
              {d.records.map((r) => {
                const kindLabel = t(`comms.contacts.kinds.${r.kind}`);
                return (
                  <li key={`${r.kind}:${r.id}`} className="flex min-h-row items-center gap-3 px-4 py-2.5">
                    <Chip>{kindLabel}</Chip>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-md font-semibold text-ink">{r.name}</span>
                      <span className="block truncate text-sm text-muted">
                        {[r.title, r.company, r.emails[0], r.phones[0]].filter(Boolean).join(" · ") || "—"}
                        {r.linkedVia === "merge" ? ` · ${t("comms.contacts.linkedByMerge")}` : ""}
                      </span>
                    </span>
                    <a href={r.href} className={iconBtnCls} aria-label={t("comms.contacts.openRecord", { kind: kindLabel })}>
                      <ArrowUpRight className="size-4" aria-hidden />
                    </a>
                    {canEdit && d.records.length > 1 ? (
                      <button
                        type="button"
                        className={iconBtnCls}
                        onClick={() => unlink(r.kind, r.id)}
                        disabled={busy === `${r.kind}:${r.id}`}
                        aria-label={`${t("comms.contacts.unlink")}: ${r.name} (${kindLabel})`}
                        title={t("comms.contacts.unlinkHelp")}
                      >
                        <Unlink className="size-4" aria-hidden />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </Card>
          <SuggestionsList canMerge={canEdit} identityId={identityId} onChanged={() => void load()} />
        </div>
        <Card aria-labelledby="contact-timeline" className="min-w-0">
          <h2 id="contact-timeline" className="aos-subheading px-4 pt-4 text-ink">
            {t("comms.contacts.timeline")}
          </h2>
          {d.timeline.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted">{t("comms.contacts.timelineEmpty")}</p>
          ) : (
            <ol className="mt-2 divide-y divide-line">
              {d.timeline.map((e) => {
                const body = (
                  <>
                    <span className="w-24 shrink-0 pt-0.5 text-xs font-semibold text-muted">{t(`comms.contacts.types.${e.type}`)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-md text-ink">{e.title}</span>
                      <span className="block truncate text-sm text-muted">{[format.date(e.at, "dateTime"), e.detail].filter(Boolean).join(" · ")}</span>
                    </span>
                  </>
                );
                return (
                  <li key={e.key}>
                    {e.href ? (
                      <Link href={e.href} className="flex items-start gap-3 px-4 py-2.5 hover:bg-hover-paper">
                        {body}
                      </Link>
                    ) : (
                      <div className="flex items-start gap-3 px-4 py-2.5">{body}</div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </Card>
      </div>
    </div>
  );
}

function BackLink() {
  const { t } = useI18n();
  return (
    <Link href="/dashboard/contacts" className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-ink hover:underline">
      <ArrowLeft className="size-4" aria-hidden />
      {t("comms.contacts.backToContacts")}
    </Link>
  );
}
