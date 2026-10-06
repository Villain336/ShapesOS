"use client";

// ShapesOS — Phase 18.2 (WS=comms): the Mail app (/dashboard/mail).
// One inbox over the sources that already exist (lib/comms/mail): your own
// Gmail / Outlook, the CRM lead conversations and social DMs. Three panes:
// folders + sources + labels · the thread list · the open thread with its
// reply box. The inbox agent summarizes, suggests labels (you accept them)
// and drafts replies (drafts only); "Triage with an agent" hands the whole
// inbox to the Drafter as a run. Sending is your click, through each
// source's own send action.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bot,
  Inbox,
  Loader2,
  Mail,
  MailOpen,
  MessageCircle,
  PenLine,
  RefreshCw,
  Search,
  Send,
  Smartphone,
  Sparkles,
  Tag,
  X,
  type LucideIcon,
} from "lucide-react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { aosButton } from "@/components/aos/button";
import { cn } from "@/lib/utils";
import type { MailFolder, MailMessageView, MailSource, MailThreadView } from "@/lib/comms/mail/types";
import { Card, Chip, EmptyState, ErrorLine, iconBtnCls, inputCls, inputSmCls, labelCls, MockChip, Note, PersonTile, textareaCls } from "./ui";
import { Modal } from "./Modal";

interface SourceStatus {
  source: MailSource;
  connected: boolean;
  accounts: { connectionId?: string; label: string }[];
  mock: boolean;
  error: string | null;
}

interface Detail {
  thread: MailThreadView;
  messages: MailMessageView[];
  reply: { source: MailSource; to: string[]; subject: string | null; channels: string[]; connectionId?: string; replyToMessageId?: string | null };
}

const SOURCE_ICON: Record<MailSource, LucideIcon> = { gmail: Mail, outlook: Mail, crm: Smartphone, social: MessageCircle };
const FOLDERS: { id: MailFolder; icon: LucideIcon }[] = [
  { id: "inbox", icon: Inbox },
  { id: "unread", icon: Mail },
  { id: "archived", icon: Archive },
];

async function readError(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export function MailApp({ canEdit, initialThread, initialCompose }: { canEdit: boolean; initialThread?: string | null; initialCompose?: { to?: string | null } | null }) {
  const { t, format } = useI18n();
  const [folder, setFolder] = useState<MailFolder>("inbox");
  const [source, setSource] = useState<MailSource | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [threads, setThreads] = useState<MailThreadView[] | null>(null);
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(initialThread ?? null);
  const [composeOpen, setComposeOpen] = useState(!!initialCompose);
  const [triage, setTriage] = useState<{ runId: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(
    async (refresh = false) => {
      const my = ++seq.current;
      setLoading(true);
      const p = new URLSearchParams({ folder });
      if (source) p.set("source", source);
      if (tag) p.set("tag", tag);
      if (q.trim()) p.set("q", q.trim());
      if (refresh) p.set("refresh", "1");
      try {
        const res = await fetch(`/api/comms/mail/threads?${p.toString()}`, { cache: "no-store" });
        if (!res.ok) throw new Error(await readError(res));
        const j = (await res.json()) as { threads: MailThreadView[]; sources: SourceStatus[] };
        if (my !== seq.current) return;
        setThreads(j.threads);
        setSources(j.sources);
        setError(null);
      } catch (e) {
        if (my === seq.current) setError(t("comms.common.loadError", { error: e instanceof Error ? e.message : "" }));
        setThreads((prev) => prev ?? []);
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [folder, source, tag, q, t],
  );

  useEffect(() => {
    const h = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(h);
  }, [load, q]);

  const mailboxes = sources.filter((s) => (s.source === "gmail" || s.source === "outlook") && s.connected);
  const noMailbox = sources.length > 0 && mailboxes.length === 0;
  const anyMock = sources.some((s) => s.mock) || (threads ?? []).some((x) => x.mock);
  const allTags = useMemo(() => [...new Set((threads ?? []).flatMap((x) => x.tags))].sort(), [threads]);

  async function startTriage() {
    setNotice(null);
    try {
      const res = await fetch("/api/comms/mail/triage", { method: "POST" });
      if (!res.ok) throw new Error(await readError(res));
      const j = (await res.json()) as { runId: string };
      setTriage({ runId: j.runId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const list = (
    <Card className="flex min-h-0 flex-col" aria-label={t(`comms.mail.folders.${folder}`)}>
      <div className="border-b border-line p-3">
        <label htmlFor="mail-search" className="sr-only">
          {t("comms.mail.searchLabel")}
        </label>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <input id="mail-search" type="search" className={cn(inputSmCls, "pl-9")} placeholder={t("comms.mail.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button type="button" className={iconBtnCls} onClick={() => void load(true)} aria-label={t("comms.mail.refresh")} disabled={loading}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} aria-hidden />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {threads === null ? (
          <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t("common.loading")}
          </p>
        ) : threads.length === 0 ? (
          <EmptyState icon={Inbox} title={t("comms.mail.noThreadsTitle")} body={t("comms.mail.noThreadsBody")} />
        ) : (
          <ul className="divide-y divide-line">
            {threads.map((x) => {
              const Icon = SOURCE_ICON[x.source];
              const who = x.from.name ?? x.from.address ?? x.subject;
              return (
                <li key={x.key}>
                  <button
                    type="button"
                    onClick={() => setOpenKey(x.key)}
                    aria-current={openKey === x.key ? "true" : undefined}
                    className={cn("flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-hover-paper", openKey === x.key && "bg-hover-paper shadow-[inset_3px_0_0_var(--aos-ink)]")}
                  >
                    <PersonTile name={who} size={28} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        {x.unread ? <span className="size-2 shrink-0 rounded-full bg-ink" aria-label={t("comms.mail.unread")} role="img" /> : null}
                        <span className={cn("truncate text-md", x.unread ? "font-bold text-ink" : "font-medium text-ink")}>{who}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted tabular-nums">{format.relative(x.lastMessageAt)}</span>
                      </span>
                      <span className={cn("block truncate text-sm", x.unread ? "font-semibold text-ink" : "text-ink")}>{x.subject || t("comms.common.noSubject")}</span>
                      {x.snippet || x.summary ? <span className="block truncate text-sm text-muted">{x.summary ?? x.snippet}</span> : null}
                      <span className="mt-1 flex flex-wrap items-center gap-1">
                        <Chip>
                          <Icon className="size-3" aria-hidden />
                          {x.via}
                        </Chip>
                        {x.tags.map((g) => (
                          <Chip key={g}>
                            <Tag className="size-3" aria-hidden />
                            {g}
                          </Chip>
                        ))}
                        {x.mock ? <MockChip label={t("comms.common.mock")} /> : null}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="aos-heading text-ink">{t("comms.mail.title")}</h1>
          <p className="mt-1 max-w-[80ch] text-sm text-muted">{t("comms.mail.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit ? (
            <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={startTriage}>
              <Bot className="size-4" aria-hidden />
              {t("comms.mail.triage")}
            </button>
          ) : null}
          <button type="button" className={aosButton({ variant: "primary", size: "sm" })} onClick={() => setComposeOpen(true)}>
            <PenLine className="size-4" aria-hidden />
            {t("comms.mail.compose")}
          </button>
        </div>
      </div>
      {triage ? (
        <Note action={<Link href={`/dashboard/runs/${encodeURIComponent(triage.runId)}`} className={aosButton({ variant: "secondary", size: "sm" })}>{t("comms.mail.triageOpen")}</Link>}>
          {t("comms.mail.triageStarted")}
        </Note>
      ) : null}
      {noMailbox ? (
        <Note
          action={
            <span className="flex flex-wrap gap-2">
              <Link href="/dashboard/settings/connectors" className={aosButton({ variant: "secondary", size: "sm" })}>
                {t("comms.mail.connectGmail")}
              </Link>
              <Link href="/dashboard/settings/connectors" className={aosButton({ variant: "secondary", size: "sm" })}>
                {t("comms.mail.connectOutlook")}
              </Link>
            </span>
          }
        >
          <span className="font-semibold text-ink">{t("comms.mail.connectTitle")}.</span> {t("comms.mail.connectBody")}
        </Note>
      ) : null}
      {anyMock ? <Note action={<MockChip label={t("comms.common.mock")} />}>{t("comms.mail.mockNote")}</Note> : null}
      <ErrorLine message={error} />
      {sources
        .filter((s) => s.error)
        .map((s) => (
          <ErrorLine key={s.source} message={t("comms.mail.sourceError", { source: t(`comms.mail.sources.${s.source}`), error: s.error ?? "" })} />
        ))}
      {notice ? (
        <p role="status" className="text-sm font-semibold text-ink">
          {notice}
        </p>
      ) : null}
      <div className="grid gap-4 lg:h-[calc(100dvh-260px)] lg:min-h-[560px] lg:grid-cols-[220px_minmax(280px,380px)_minmax(0,1fr)]">
        <nav aria-label={t("comms.mail.folderLabel")} className="flex flex-col gap-4">
          <ul className="flex flex-row flex-wrap gap-1 lg:flex-col">
            {FOLDERS.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => setFolder(f.id)}
                  aria-current={folder === f.id ? "page" : undefined}
                  className={cn("flex h-10 w-full items-center gap-2.5 rounded-sm px-3 text-md font-semibold", folder === f.id ? "bg-ink text-paper" : "text-ink hover:bg-hover")}
                >
                  <f.icon className="size-4" aria-hidden />
                  {t(`comms.mail.folders.${f.id}`)}
                </button>
              </li>
            ))}
          </ul>
          <div>
            <h2 className="px-3 pb-1 text-xs font-semibold text-subtle">{t("comms.mail.sourcesLabel")}</h2>
            <ul className="flex flex-row flex-wrap gap-1 lg:flex-col">
              <li>
                <button type="button" onClick={() => setSource(null)} aria-pressed={source === null} className={cn("flex h-9 w-full items-center gap-2 rounded-sm px-3 text-sm font-semibold", source === null ? "bg-hover text-ink" : "text-muted hover:bg-hover")}>
                  {t("comms.mail.allSources")}
                </button>
              </li>
              {sources.map((s) => {
                const Icon = SOURCE_ICON[s.source];
                return (
                  <li key={s.source}>
                    <button
                      type="button"
                      onClick={() => setSource(s.source)}
                      aria-pressed={source === s.source}
                      className={cn("flex h-9 w-full items-center gap-2 rounded-sm px-3 text-sm font-semibold", source === s.source ? "bg-hover text-ink" : "text-muted hover:bg-hover")}
                    >
                      <Icon className="size-4" aria-hidden />
                      <span className="truncate">{t(`comms.mail.sources.${s.source}`)}</span>
                      {!s.connected ? <span className="ml-auto text-xs font-medium text-subtle">{t("comms.common.notConnected")}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          {allTags.length || tag ? (
            <div>
              <h2 className="px-3 pb-1 text-xs font-semibold text-subtle">{t("comms.mail.labelsLabel")}</h2>
              <ul className="flex flex-row flex-wrap gap-1 lg:flex-col">
                {[...new Set([...(tag ? [tag] : []), ...allTags])].map((g) => (
                  <li key={g}>
                    <button type="button" onClick={() => setTag(tag === g ? null : g)} aria-pressed={tag === g} className={cn("flex h-9 w-full items-center gap-2 rounded-sm px-3 text-sm font-semibold", tag === g ? "bg-hover text-ink" : "text-muted hover:bg-hover")}>
                      <Tag className="size-3.5" aria-hidden />
                      {g}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </nav>
        <div className={cn("min-h-0", openKey ? "hidden lg:flex lg:flex-col" : "flex flex-col")}>{list}</div>
        <div className={cn("min-h-0 min-w-0", openKey ? "flex flex-col" : "hidden lg:flex lg:flex-col")}>
          {openKey ? (
            <ThreadPane
              key={openKey}
              threadKey={openKey}
              canEdit={canEdit}
              onBack={() => setOpenKey(null)}
              onChanged={(msg) => {
                if (msg) setNotice(msg);
                void load();
              }}
            />
          ) : (
            <Card className="flex flex-1 items-center justify-center">
              <EmptyState icon={MailOpen} title={t("comms.mail.selectThread")} />
            </Card>
          )}
        </div>
      </div>
      <ComposeDialog
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        mailboxes={mailboxes}
        initialTo={initialCompose?.to ?? ""}
        onSent={(msg) => {
          setComposeOpen(false);
          setNotice(msg);
          void load(true);
        }}
      />
    </div>
  );
}

function outcomeText(t: ReturnType<typeof useI18n>["t"], o: { outcome: string; detail: string | null }): string {
  if (o.outcome === "mock") return t("comms.mail.sentMock");
  if (o.outcome === "queued") return t("comms.mail.queued");
  if (o.outcome === "suppressed" || o.outcome === "failed") return t("comms.mail.suppressed", { reason: o.detail ?? o.outcome });
  return t("comms.mail.sent");
}

function ThreadPane({ threadKey, canEdit, onBack, onChanged }: { threadKey: string; canEdit: boolean; onBack: () => void; onChanged: (notice?: string) => void }) {
  const { t, format } = useI18n();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ text: string; tags: string[]; mock: boolean } | null>(null);
  const [reply, setReply] = useState("");
  const [subject, setSubject] = useState("");
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [newTag, setNewTag] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/comms/mail/thread?key=${encodeURIComponent(threadKey)}&read=1`, { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      const j = (await res.json()) as Detail;
      setD(j);
      setSubject(j.reply.subject ? (/^re:/i.test(j.reply.subject) ? j.reply.subject : `Re: ${j.reply.subject}`) : "");
      setChannel(j.reply.channels.includes("email") ? "email" : "sms");
      if (j.thread.summary) setSummary({ text: j.thread.summary, tags: j.thread.suggestedTags, mock: false });
      setError(null);
    } catch (e) {
      setError(t("comms.common.loadError", { error: e instanceof Error ? e.message : "" }));
    }
  }, [threadKey, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function organize(body: Record<string, unknown>) {
    setBusy("organize");
    try {
      const res = await fetch(`/api/comms/mail/thread?key=${encodeURIComponent(threadKey)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await readError(res));
      const j = (await res.json()) as { thread: MailThreadView };
      setD((prev) => (prev ? { ...prev, thread: j.thread } : prev));
      if (body.acceptSuggested) setSummary((s) => (s ? { ...s, tags: [] } : s));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function summarize() {
    setBusy("summarize");
    try {
      const res = await fetch(`/api/comms/mail/thread/summarize?key=${encodeURIComponent(threadKey)}`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res));
      const j = (await res.json()) as { summary: string; suggestedTags: string[]; mock: boolean };
      setSummary({ text: j.summary, tags: j.suggestedTags, mock: j.mock });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function draft() {
    setBusy("draft");
    try {
      const res = await fetch(`/api/comms/mail/thread/draft?key=${encodeURIComponent(threadKey)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!res.ok) throw new Error(await readError(res));
      const j = (await res.json()) as { draft: { id: string; body: string; subject: string | null } };
      setReply(j.draft.body);
      setDraftId(j.draft.id);
      if (j.draft.subject) setSubject(j.draft.subject);
      setStatus(t("comms.mail.draftReady"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!d || !reply.trim()) return;
    setBusy("send");
    setError(null);
    try {
      const res = await fetch("/api/comms/mail/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadKey, body: reply, subject: d.reply.source === "crm" && channel === "email" ? subject : undefined, channel: d.reply.source === "crm" ? channel : undefined, replyToMessageId: d.reply.replyToMessageId ?? undefined, draftId }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const out = (await res.json()) as { outcome: string; detail: string | null };
      setReply("");
      setDraftId(null);
      setStatus(outcomeText(t, out));
      onChanged(outcomeText(t, out));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (!d) {
    return (
      <Card className="flex flex-1 flex-col p-4">
        <button type="button" className={cn(aosButton({ variant: "quiet", size: "xs" }), "self-start lg:hidden")} onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden />
          {t("comms.mail.back")}
        </button>
        {error ? <ErrorLine message={error} /> : <p className="flex items-center gap-2 text-sm text-muted" role="status"><Loader2 className="size-4 animate-spin" aria-hidden />{t("common.loading")}</p>}
      </Card>
    );
  }
  const th = d.thread;
  const replyLocked = (th.source === "crm" || th.source === "social") && !canEdit;
  return (
    <Card as="article" className="flex min-h-0 flex-1 flex-col" aria-labelledby="mail-thread-title">
      <header className="flex flex-wrap items-start gap-2 border-b border-line px-4 py-3">
        <button type="button" className={cn(iconBtnCls, "lg:hidden")} onClick={onBack} aria-label={t("comms.mail.back")}>
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <h2 id="mail-thread-title" className="aos-subheading break-words text-ink">
            {th.subject || t("comms.common.noSubject")}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-muted">
            {t("comms.mail.via", { via: th.via })} · {t("comms.mail.messages", { count: d.messages.length })}
            {th.mock ? <MockChip label={t("comms.common.mock")} /> : null}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" className={aosButton({ variant: "secondary", size: "xs" })} onClick={summarize} disabled={busy === "summarize"}>
            {busy === "summarize" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
            {busy === "summarize" ? t("comms.mail.summarizing") : t("comms.mail.summarize")}
          </button>
          {th.organizable ? (
            <>
              <button type="button" className={iconBtnCls} onClick={() => organize({ unread: !th.unread })} aria-label={th.unread ? t("comms.mail.readMark") : t("comms.mail.unreadMark")}>
                {th.unread ? <MailOpen className="size-4" aria-hidden /> : <Mail className="size-4" aria-hidden />}
              </button>
              <button type="button" className={iconBtnCls} onClick={() => organize({ archived: !th.archived })} aria-label={th.archived ? t("comms.mail.unarchive") : t("comms.mail.archive")}>
                {th.archived ? <ArchiveRestore className="size-4" aria-hidden /> : <Archive className="size-4" aria-hidden />}
              </button>
            </>
          ) : null}
        </div>
      </header>
      {summary ? (
        <section aria-label={t("comms.mail.summary")} className="border-b border-line bg-canvas px-4 py-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-subtle">
            <Sparkles className="size-3.5" aria-hidden />
            {t("comms.mail.summary")}
            {summary.mock ? <MockChip label={t("comms.common.mock")} title={t("comms.mail.summaryMock")} /> : null}
          </p>
          <p className="mt-1 text-sm whitespace-pre-wrap text-ink">{summary.text}</p>
          {summary.mock ? <p className="mt-1 text-xs text-muted">{t("comms.mail.summaryMock")}</p> : null}
          {summary.tags.length && th.organizable ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold text-muted">{t("comms.mail.suggestedLabels")}:</span>
              {summary.tags.map((g) => (
                <Chip key={g}>{g}</Chip>
              ))}
              <button type="button" className={aosButton({ variant: "secondary", size: "xs" })} onClick={() => organize({ acceptSuggested: true })}>
                {t("comms.mail.acceptLabels")}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
      {th.organizable ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2">
          {th.tags.map((g) => (
            <span key={g} className="inline-flex h-7 items-center gap-1 rounded-full bg-paper pr-1 pl-2.5 text-xs font-semibold text-ink shadow-control">
              <Tag className="size-3" aria-hidden />
              {g}
              <button type="button" className="inline-flex size-5 items-center justify-center rounded-full hover:bg-hover" onClick={() => organize({ removeTags: [g] })} aria-label={t("comms.mail.removeLabel", { label: g })}>
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (newTag.trim()) void organize({ addTags: [newTag.trim()] });
              setNewTag("");
            }}
            className="flex items-center gap-1"
          >
            <label htmlFor="mail-new-tag" className="sr-only">
              {t("comms.mail.addLabel")}
            </label>
            <input id="mail-new-tag" className="h-7 w-32 rounded-full border-[1.5px] border-control bg-paper px-2.5 text-xs text-ink placeholder:text-subtle focus:border-focus focus:outline-none" placeholder={t("comms.mail.addLabelPlaceholder")} value={newTag} onChange={(e) => setNewTag(e.target.value)} maxLength={40} />
          </form>
        </div>
      ) : null}
      <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {d.messages.map((m) => {
          const who = m.direction === "outbound" ? t("comms.mail.you") : (m.from.name ?? m.from.address ?? "—");
          return (
            <li key={m.id} className={cn("rounded-md p-3", m.direction === "outbound" ? "ml-8 bg-canvas" : "mr-8 bg-paper shadow-[inset_0_0_0_1px_var(--aos-line)]")}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold text-ink">{who}</span>
                {m.from.address && m.direction !== "outbound" ? <span className="text-muted">{m.from.address}</span> : null}
                {m.channel === "sms" ? <Chip>{t("comms.mail.channelSms")}</Chip> : null}
                {m.status ? <Chip>{t(`comms.mail.status.${(["queued", "sent", "delivered", "failed", "suppressed", "received", "pending_approval"].includes(m.status) ? m.status : "sent") as "sent"}`)}</Chip> : null}
                <span className="ml-auto text-xs text-muted tabular-nums">{format.date(m.at, "dateTime")}</span>
              </div>
              {m.subject && m.channel !== "sms" ? <p className="mt-1 text-sm font-semibold text-ink">{m.subject}</p> : null}
              <p className="mt-1.5 text-md break-words whitespace-pre-wrap text-ink">{m.body}</p>
            </li>
          );
        })}
      </ol>
      <form onSubmit={send} className="flex flex-col gap-2 border-t border-line px-4 py-3" aria-label={t("comms.mail.reply")}>
        {replyLocked ? (
          <p className="text-sm text-muted">{t("comms.mail.editorReply")}</p>
        ) : (
          <>
            {th.source === "crm" && d.reply.channels.length > 1 ? (
              <div className="flex items-center gap-2">
                <label htmlFor="mail-channel" className={labelCls}>
                  {t("comms.mail.channel")}
                </label>
                <select id="mail-channel" className={cn(inputSmCls, "w-auto")} value={channel} onChange={(e) => setChannel(e.target.value as "email" | "sms")}>
                  <option value="email">{t("comms.mail.channelEmail")}</option>
                  <option value="sms">{t("comms.mail.channelSms")}</option>
                </select>
              </div>
            ) : null}
            {th.source === "crm" && channel === "email" ? (
              <div className="flex items-center gap-2">
                <label htmlFor="mail-reply-subject" className={cn(labelCls, "w-16 shrink-0")}>
                  {t("comms.mail.subject")}
                </label>
                <input id="mail-reply-subject" className={inputSmCls} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
              </div>
            ) : null}
            <label htmlFor="mail-reply" className="sr-only">
              {t("comms.mail.reply")}
            </label>
            <textarea id="mail-reply" className={textareaCls} rows={4} placeholder={t("comms.mail.replyPlaceholder")} value={reply} onChange={(e) => setReply(e.target.value)} />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={draft} disabled={busy === "draft"}>
                {busy === "draft" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Bot className="size-4" aria-hidden />}
                {busy === "draft" ? t("comms.mail.drafting") : t("comms.mail.draftReply")}
              </button>
              <button type="submit" className={aosButton({ variant: "primary", size: "sm", className: "ml-auto" })} disabled={!reply.trim() || busy === "send"}>
                {busy === "send" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
                {busy === "send" ? t("comms.mail.sending") : t("comms.mail.send")}
              </button>
            </div>
          </>
        )}
        {status ? (
          <p role="status" className="text-sm font-semibold text-ink">
            {status}
          </p>
        ) : null}
        <ErrorLine message={error} />
      </form>
    </Card>
  );
}

function ComposeDialog({ open, onClose, mailboxes, initialTo, onSent }: { open: boolean; onClose: () => void; mailboxes: SourceStatus[]; initialTo: string; onSent: (notice: string) => void }) {
  const { t } = useI18n();
  const accounts = mailboxes.flatMap((m) => m.accounts.filter((a) => a.connectionId).map((a) => ({ ...a, source: m.source })));
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(initialTo);
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<"send" | "draft" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (open) setFrom((f) => f || accounts[0]?.connectionId || "");
  }, [open, accounts]);

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy("send");
    setError(null);
    try {
      const res = await fetch("/api/comms/mail/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId: from, to, cc: cc || undefined, subject, body }) });
      if (!res.ok) throw new Error(await readError(res));
      const out = (await res.json()) as { outcome: string; detail: string | null };
      setTo("");
      setCc("");
      setSubject("");
      setBody("");
      onSent(outcomeText(t, out));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveDraft() {
    setBusy("draft");
    setError(null);
    try {
      const src = accounts.find((a) => a.connectionId === from)?.source ?? "gmail";
      const res = await fetch("/api/comms/mail/drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: src, connectionId: from || null, to, cc: cc || null, subject, body }) });
      if (!res.ok) throw new Error(await readError(res));
      setSaved(t("comms.mail.draftSaved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("comms.mail.compose")}
      closeLabel={t("common.close")}
      wide
      footer={
        accounts.length ? (
          <>
            {saved ? (
              <span role="status" className="mr-auto text-sm font-semibold text-ink">
                {saved}
              </span>
            ) : null}
            <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={saveDraft} disabled={busy !== null || !body.trim()}>
              {t("comms.mail.saveDraft")}
            </button>
            <button type="submit" form="mail-compose" className={aosButton({ variant: "primary", size: "sm" })} disabled={busy !== null || !to.trim() || !subject.trim() || !body.trim()}>
              {busy === "send" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
              {busy === "send" ? t("comms.mail.sending") : t("comms.mail.send")}
            </button>
          </>
        ) : null
      }
    >
      {accounts.length === 0 ? (
        <p className="text-sm text-muted">
          {t("comms.mail.noMailbox")}{" "}
          <Link href="/dashboard/settings/connectors" className="font-semibold text-ink underline">
            {t("comms.mail.connectGmail")}
          </Link>
        </p>
      ) : (
        <form id="mail-compose" onSubmit={send} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="mc-from" className={labelCls}>
              {t("comms.mail.from")}
            </label>
            <select id="mc-from" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.connectionId} value={a.connectionId}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="mc-to" className={labelCls}>
              {t("comms.mail.to")}
            </label>
            <input id="mc-to" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} autoComplete="off" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="mc-cc" className={labelCls}>
              {t("comms.mail.cc")}
            </label>
            <input id="mc-cc" className={inputCls} value={cc} onChange={(e) => setCc(e.target.value)} autoComplete="off" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="mc-subject" className={labelCls}>
              {t("comms.mail.subject")}
            </label>
            <input id="mc-subject" className={inputCls} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={998} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="mc-body" className={labelCls}>
              {t("comms.mail.body")}
            </label>
            <textarea id="mc-body" className={textareaCls} rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <ErrorLine message={error} />
        </form>
      )}
    </Modal>
  );
}

export default MailApp;
