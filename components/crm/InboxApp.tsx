// ShapesOS CRM — conversation inbox (Phase 4b).
//
// Left: every lead with messages, newest activity first (GET
// /api/crm/inbox/threads), filtered by channel / unread / assignee / search.
// Right: the lead's thread — outbound sends and inbound replies merged from
// the messaging ledger — and a reply composer. Replies go through POST
// …/reply, which queues them via the messaging dispatcher (consent, quiet
// hours, daily cap, human approval). Read state is per user. Both panes
// poll while the tab is visible.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Inbox,
  Loader2,
  Mail,
  MailOpen,
  MessageSquareText,
  RefreshCw,
  Search,
  Send,
  SquareArrowOutUpRight,
} from "lucide-react";
import { toast, toastError } from "@/lib/ui/feedback";
import { btnGhostSm, btnPrimary, errorBoxCls, inputCls, labelCls, noteBoxCls, selectCls } from "./ui";
import {
  CHANNEL_LABEL,
  consentHint,
  defaultReplyChannel,
  messageMark,
  newestAt,
  shortAge,
  type ConsentStatus,
} from "./inbox-view";

const LIST_POLL_MS = 15_000;
const THREAD_POLL_MS = 10_000;

interface ThreadSummary {
  leadId: string;
  leadName: string;
  leadEmail: string | null;
  leadPhone: string | null;
  ownerName: string | null;
  lastMessageAt: string;
  lastChannel: string;
  lastDirection: string;
  lastSnippet: string;
  messageCount: number;
  unreadCount: number;
  channels: string[];
}

interface ThreadList {
  threads: ThreadSummary[];
  nextCursor: string | null;
  unreadThreads: number;
  unmatchedInbound: number;
}

interface ThreadMessage {
  id: string;
  channel: string;
  direction: "inbound" | "outbound";
  kind: string;
  subject: string | null;
  body: string;
  status: string;
  suppressionReason: string | null;
  error: string | null;
  approvalStatus: string | null;
  createdAt: string;
}

interface ThreadDetail {
  lead: { id: string; name: string; email: string | null; phone: string | null; company: string | null; ownerName: string | null; stage: string };
  messages: ThreadMessage[];
  lastReadAt: string | null;
  unreadCount: number;
  lastEmailSubject: string | null;
}

type ChannelFilter = "all" | "sms" | "email";
type AssignedFilter = "any" | "me" | "unassigned";

const textareaCls =
  "min-h-24 w-full resize-y rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-[0.8125rem] text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]";

function chipToggleCls(pressed: boolean): string {
  return `inline-flex h-control-sm items-center gap-1.5 rounded-full px-3 text-[0.8125rem] font-semibold aos-press ${
    pressed ? "bg-ink text-white" : "bg-paper text-ink shadow-control hover:shadow-outline"
  }`;
}

function segmentCls(active: boolean): string {
  return `inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[0.78125rem] font-semibold ${
    active ? "bg-ink text-white" : "text-muted hover:text-ink"
  } disabled:cursor-not-allowed disabled:opacity-40`;
}

function ChannelIcon({ channel, size = 13 }: { channel: string; size?: number }) {
  return channel === "email" ? (
    <Mail size={size} aria-label="Email" className="shrink-0 text-subtle" />
  ) : (
    <MessageSquareText size={size} aria-label="SMS" className="shrink-0 text-subtle" />
  );
}

/** Delivery state as text. Status shapes are reserved for agent states
 *  (DESIGN.md); only a message waiting on approval keeps the needs-you
 *  triangle, since it sits in the approvals inbox. */
function StatusMark({ m }: { m: ThreadMessage }) {
  const { mark, label } = messageMark(m);
  return (
    <span
      className={`inline-flex items-center gap-1 text-[0.71875rem] font-semibold ${mark === "failed" ? "text-failed-text" : "text-muted"}`}
    >
      {mark === "needs" ? (
        <span aria-hidden className="aos-shape aos-shape--needs aos-shape--edged" style={{ ["--aos-shape-size" as string]: "9px" }} />
      ) : null}
      {label}
    </span>
  );
}

async function readJson<T>(res: Response, fallback: string): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? fallback);
  return body;
}

/** Poll fn every ms while the document is visible (and once on becoming visible). */
function useVisiblePoll(fn: () => void, ms: number, enabled = true) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") ref.current();
    };
    const id = window.setInterval(tick, ms);
    const onVis = () => {
      if (document.visibilityState === "visible") ref.current();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [ms, enabled]);
}

export function InboxApp({ canReply, initialLeadId }: { canReply: boolean; initialLeadId: string | null }) {
  const router = useRouter();
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [assigned, setAssigned] = useState<AssignedFilter>("any");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [list, setList] = useState<ThreadList | null>(null);
  const [extra, setExtra] = useState<ThreadSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [selected, setSelected] = useState<string | null>(initialLeadId);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(id);
  }, [query]);

  const listParams = useMemo(() => {
    const p = new URLSearchParams();
    if (channel !== "all") p.set("channel", channel);
    if (unreadOnly) p.set("unread", "1");
    if (assigned !== "any") p.set("assigned", assigned);
    if (debounced) p.set("q", debounced);
    return p;
  }, [channel, unreadOnly, assigned, debounced]);

  const fetchList = useCallback(async (): Promise<ThreadList> => {
    const res = await fetch(`/api/crm/inbox/threads?${listParams.toString()}`, { cache: "no-store" });
    return readJson<ThreadList>(res, "Couldn't load conversations.");
  }, [listParams]);

  // Filters changed: replace the list (first page) and reset paging.
  const applyFirstPage = useCallback((body: ThreadList) => {
    setList(body);
    setCursor(body.nextCursor);
    setExtra([]);
    setListError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchList()
      .then((body) => {
        if (!cancelled) applyFirstPage(body);
      })
      .catch((e: unknown) => {
        if (!cancelled) setListError(e instanceof Error ? e.message : "Couldn't load conversations.");
      });
    return () => {
      cancelled = true;
    };
  }, [fetchList, applyFirstPage]);

  /** Background refresh: newest first page, paging left alone, errors silent. */
  const refreshQuietly = useCallback(() => {
    fetchList()
      .then((body) => {
        setList(body);
        setListError(null);
      })
      .catch(() => {});
  }, [fetchList]);
  useVisiblePoll(refreshQuietly, LIST_POLL_MS);

  async function refreshNow() {
    setLoadingList(true);
    try {
      applyFirstPage(await fetchList());
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Couldn't load conversations.");
    } finally {
      setLoadingList(false);
    }
  }

  async function loadMore() {
    if (!cursor) return;
    try {
      const p = new URLSearchParams(listParams);
      p.set("cursor", cursor);
      const res = await fetch(`/api/crm/inbox/threads?${p.toString()}`, { cache: "no-store" });
      const body = await readJson<ThreadList>(res, "Couldn't load more conversations.");
      setExtra((cur) => [...cur, ...body.threads]);
      setCursor(body.nextCursor);
    } catch (e) {
      toastError("Couldn't load more conversations.", e instanceof Error ? e.message : undefined);
    }
  }

  const threads = useMemo(() => {
    const seen = new Set<string>();
    return [...(list?.threads ?? []), ...extra].filter((t) => (seen.has(t.leadId) ? false : (seen.add(t.leadId), true)));
  }, [list, extra]);

  function open(leadId: string) {
    setSelected(leadId);
    router.replace(`/dashboard/crm/inbox?lead=${encodeURIComponent(leadId)}`, { scroll: false });
  }

  function onThreadRead(leadId: string) {
    setList((cur) =>
      cur
        ? {
            ...cur,
            unreadThreads: Math.max(0, cur.unreadThreads - (cur.threads.find((t) => t.leadId === leadId)?.unreadCount ? 1 : 0)),
            threads: cur.threads.map((t) => (t.leadId === leadId ? { ...t, unreadCount: 0 } : t)),
          }
        : cur,
    );
    setExtra((cur) => cur.map((t) => (t.leadId === leadId ? { ...t, unreadCount: 0 } : t)));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Filter toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="inbox-channel">
          Channel
        </label>
        <select id="inbox-channel" className={selectCls} value={channel} onChange={(e) => setChannel(e.target.value as ChannelFilter)}>
          <option value="all">All channels</option>
          <option value="sms">SMS</option>
          <option value="email">Email</option>
        </select>
        <label className="sr-only" htmlFor="inbox-assigned">
          Assigned to
        </label>
        <select id="inbox-assigned" className={selectCls} value={assigned} onChange={(e) => setAssigned(e.target.value as AssignedFilter)}>
          <option value="any">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="unassigned">Unassigned</option>
        </select>
        <button type="button" aria-pressed={unreadOnly} className={chipToggleCls(unreadOnly)} onClick={() => setUnreadOnly((v) => !v)}>
          <MailOpen size={14} /> Unread
          {list && list.unreadThreads > 0 ? (
            <span className={`rounded-full px-1.5 text-[0.6875rem] ${unreadOnly ? "bg-paper text-ink" : "bg-ink text-white"}`}>{list.unreadThreads}</span>
          ) : null}
        </button>
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            type="search"
            aria-label="Search conversations"
            placeholder="Search name, email, phone"
            className={`${inputCls} w-full pl-8`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button type="button" className={btnGhostSm} onClick={() => void refreshNow()} disabled={loadingList} aria-label="Refresh conversations">
          {loadingList ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          <span className="hidden sm:inline">Refresh</span>
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden rounded-lg border border-line bg-paper md:grid-cols-[340px_1fr]">
        {/* Thread list */}
        <div className={`min-h-0 overflow-y-auto border-line md:border-r ${selected ? "hidden md:block" : ""}`}>
          {listError ? <div className={`${errorBoxCls} m-3`}>{listError}</div> : null}
          {!list && !listError ? (
            <div className="flex items-center gap-2 p-4 text-[0.8125rem] text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading conversations
            </div>
          ) : null}
          {list && threads.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
              <Inbox size={22} className="text-subtle" />
              <p className="text-[0.8125rem] font-semibold text-ink">
                {listParams.toString() ? "No conversations match these filters." : "No conversations yet."}
              </p>
              <p className="text-[0.78125rem] text-muted">
                {listParams.toString()
                  ? "Clear a filter to see more."
                  : "Text or email a lead from the CRM and the thread shows up here, with their replies."}
              </p>
            </div>
          ) : null}
          <ul>
            {threads.map((t) => {
              const active = t.leadId === selected;
              return (
                <li key={t.leadId}>
                  <button
                    type="button"
                    onClick={() => open(t.leadId)}
                    aria-current={active ? "true" : undefined}
                    className={`flex w-full flex-col gap-0.5 border-b border-line px-4 py-3 text-left ${
                      active ? "bg-canvas" : "hover:bg-hover-paper"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className={`min-w-0 flex-1 truncate text-[0.84375rem] ${t.unreadCount ? "font-bold text-ink" : "font-semibold text-ink"}`}>
                        {t.leadName}
                      </span>
                      <span className="shrink-0 text-[0.71875rem] text-subtle">{shortAge(t.lastMessageAt)}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <ChannelIcon channel={t.lastChannel} />
                      <span className={`min-w-0 flex-1 truncate text-[0.78125rem] ${t.unreadCount ? "text-ink" : "text-muted"}`}>
                        {t.lastDirection === "outbound" ? "You: " : ""}
                        {t.lastSnippet || "(no text)"}
                      </span>
                      {t.unreadCount > 0 ? (
                        <span className="shrink-0 rounded-full bg-ink px-1.5 text-[0.6875rem] font-semibold text-white" aria-label={`${t.unreadCount} unread`}>
                          {t.unreadCount}
                        </span>
                      ) : null}
                    </span>
                    {t.ownerName ? <span className="truncate text-[0.71875rem] text-subtle">Owner: {t.ownerName}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {cursor ? (
            <div className="p-3">
              <button type="button" className={`${btnGhostSm} w-full`} onClick={() => void loadMore()}>
                Load more
              </button>
            </div>
          ) : null}
          {list && list.unmatchedInbound > 0 ? (
            <p className="px-4 py-3 text-[0.75rem] text-muted">
              {list.unmatchedInbound} inbound {list.unmatchedInbound === 1 ? "text" : "texts"} came from numbers that match no lead.
            </p>
          ) : null}
        </div>

        {/* Conversation */}
        <div className={`min-h-0 ${selected ? "flex" : "hidden md:flex"} flex-col`}>
          {selected ? (
            <ThreadPane
              key={selected}
              leadId={selected}
              channelFilter={channel === "all" ? null : channel}
              canReply={canReply}
              onBack={() => {
                setSelected(null);
                router.replace("/dashboard/crm/inbox", { scroll: false });
              }}
              onRead={() => onThreadRead(selected)}
              onReplied={refreshQuietly}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <MessageSquareText size={22} className="text-subtle" />
              <p className="text-[0.8125rem] text-muted">Pick a conversation to read it and reply.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ThreadPane({
  leadId,
  channelFilter,
  canReply,
  onBack,
  onRead,
  onReplied,
}: {
  leadId: string;
  channelFilter: "sms" | "email" | null;
  canReply: boolean;
  onBack: () => void;
  onRead: () => void;
  onReplied: () => void;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [consent, setConsent] = useState<{ sms: ConsentStatus; email: ConsentStatus } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null = not chosen yet: follow the thread (derived below).
  const [pickedChannel, setReplyChannel] = useState<"sms" | "email" | null>(null);
  const [pickedSubject, setSubject] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const lastAcked = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const lastCount = useRef(0);

  type ThreadResponse = { thread: ThreadDetail; consent: { sms: ConsentStatus; email: ConsentStatus } };
  const fetchThread = useCallback(async (): Promise<ThreadResponse> => {
    const qs = channelFilter ? `?channel=${channelFilter}` : "";
    const res = await fetch(`/api/crm/inbox/threads/${encodeURIComponent(leadId)}${qs}`, { cache: "no-store" });
    return readJson<ThreadResponse>(res, "Couldn't load this conversation.");
  }, [leadId, channelFilter]);

  const apply = useCallback((d: ThreadResponse) => {
    setDetail(d.thread);
    setConsent(d.consent);
    setError(null);
  }, []);

  const load = useCallback(
    (): Promise<void> =>
      fetchThread()
        .then(apply)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load this conversation.")),
    [fetchThread, apply],
  );

  useEffect(() => {
    let cancelled = false;
    fetchThread()
      .then((d) => {
        if (!cancelled) apply(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load this conversation.");
      });
    return () => {
      cancelled = true;
    };
  }, [fetchThread, apply]);
  const poll = useCallback(() => void load(), [load]);
  useVisiblePoll(poll, THREAD_POLL_MS);

  const available = useMemo(
    () => ({ sms: !!detail?.lead.phone?.trim(), email: !!detail?.lead.email?.trim() }),
    [detail],
  );

  // The composer follows the thread until the user picks a channel / edits the subject.
  const replyChannel = pickedChannel ?? (detail ? defaultReplyChannel(detail.messages, available) : null);
  const defaultSubject = detail?.lastEmailSubject?.trim()
    ? /^re:/i.test(detail.lastEmailSubject.trim())
      ? detail.lastEmailSubject.trim()
      : `Re: ${detail.lastEmailSubject.trim()}`
    : "";
  const subject = pickedSubject ?? defaultSubject;

  // Acknowledge what is on screen (only messages already shown count as read).
  useEffect(() => {
    if (!detail) return;
    const at = newestAt(detail.messages);
    if (!at || at === lastAcked.current || detail.unreadCount === 0) {
      if (at) lastAcked.current = at;
      return;
    }
    lastAcked.current = at;
    void fetch(`/api/crm/inbox/threads/${encodeURIComponent(leadId)}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ at }),
    })
      .then((r) => (r.ok ? onRead() : undefined))
      .catch(() => {});
  }, [detail, leadId, onRead]);

  // Keep the newest message in view when messages arrive.
  useEffect(() => {
    const n = detail?.messages.length ?? 0;
    if (n !== lastCount.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    lastCount.current = n;
  }, [detail]);

  async function markUnread() {
    try {
      const res = await fetch(`/api/crm/inbox/threads/${encodeURIComponent(leadId)}/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unread: true }),
      });
      await readJson(res, "Couldn't mark it unread.");
      toast({ status: "done", title: "Marked unread" });
      onBack();
      onReplied();
    } catch (e) {
      toastError("Couldn't mark it unread.", e instanceof Error ? e.message : undefined);
    }
  }

  async function send() {
    if (!replyChannel) return;
    const text = body.trim();
    if (!text) return setFormError("Write a message first.");
    if (replyChannel === "email" && !subject.trim()) return setFormError("Add a subject.");
    setSending(true);
    setFormError(null);
    try {
      const res = await fetch(`/api/crm/inbox/threads/${encodeURIComponent(leadId)}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: replyChannel, subject: replyChannel === "email" ? subject.trim() : undefined, body: text }),
      });
      const d = await readJson<{ outcome: string; message: ThreadMessage }>(res, "Couldn't queue the reply.");
      if (d.outcome === "suppressed" || d.outcome === "failed") {
        toast({
          status: "failed",
          title: "Reply not sent",
          description:
            d.message.suppressionReason === "no_consent"
              ? "No consent on file for this channel."
              : d.message.suppressionReason === "opt_out"
                ? "The lead opted out of this channel."
                : d.message.suppressionReason === "cap"
                  ? "The daily send cap is reached."
                  : "The messaging rules blocked it.",
        });
      } else if (d.outcome === "sent") {
        toast({ status: "done", title: "Reply sent" });
      } else {
        toast({
          status: "needs",
          title: "Reply queued for approval",
          description: "It goes out once someone approves it.",
          action: { label: "Review", onClick: () => router.push("/dashboard/approvals?source=messaging") },
        });
      }
      setBody("");
      await load();
      onReplied();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Couldn't queue the reply.");
    } finally {
      setSending(false);
    }
  }

  if (error && !detail) {
    return (
      <div className="p-4">
        <button type="button" onClick={onBack} className={`${btnGhostSm} mb-3 md:hidden`}>
          <ArrowLeft size={14} /> Back
        </button>
        <div className={errorBoxCls}>{error}</div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="flex items-center gap-2 p-4 text-[0.8125rem] text-muted">
        <Loader2 size={14} className="animate-spin" /> Loading conversation
      </div>
    );
  }

  const hint = replyChannel ? consentHint(replyChannel, consent?.[replyChannel]) : null;

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <button type="button" onClick={onBack} aria-label="Back to conversations" className="rounded-full p-1.5 text-subtle hover:bg-hover-paper hover:text-ink md:hidden">
          <ArrowLeft size={16} />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[0.9375rem] font-bold text-ink">{detail.lead.name}</h2>
          <p className="truncate text-[0.78125rem] text-muted">
            {[detail.lead.phone, detail.lead.email, detail.lead.company].filter(Boolean).join(" · ") || "No contact details"}
          </p>
        </div>
        <button type="button" className={btnGhostSm} onClick={() => void markUnread()}>
          <Mail size={14} /> <span className="hidden sm:inline">Mark unread</span>
        </button>
        <Link href={`/dashboard/crm?lead=${encodeURIComponent(detail.lead.id)}`} className={btnGhostSm}>
          <SquareArrowOutUpRight size={14} /> <span className="hidden sm:inline">Open lead</span>
        </Link>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-canvas px-4 py-4" aria-live="polite">
        {detail.messages.length === 0 ? (
          <p className="text-center text-[0.8125rem] text-muted">No messages{channelFilter ? ` on ${CHANNEL_LABEL[channelFilter]}` : ""} yet.</p>
        ) : null}
        {detail.messages.map((m) => {
          const inbound = m.direction === "inbound";
          return (
            <div key={m.id} className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
              <div className={`max-w-[80%] rounded-lg px-3 py-2 ${inbound ? "bg-paper shadow-hairline" : "bg-paper shadow-outline"}`}>
                <div className="mb-1 flex items-center gap-1.5 text-[0.71875rem] text-subtle">
                  <ChannelIcon channel={m.channel} size={12} />
                  <span>{inbound ? detail.lead.name : "You"}</span>
                  <span aria-hidden>·</span>
                  <time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleString()}</time>
                </div>
                {m.subject ? <p className="mb-0.5 text-[0.8125rem] font-semibold text-ink">{m.subject}</p> : null}
                <p className="whitespace-pre-wrap break-words text-[0.84375rem] text-ink">{m.body}</p>
                {!inbound ? (
                  <div className="mt-1.5 flex justify-end">
                    <StatusMark m={m} />
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-line p-3">
        {!canReply ? (
          <p className={noteBoxCls}>You can read conversations. Editors and above can reply.</p>
        ) : !replyChannel ? (
          <p className={noteBoxCls}>Add a phone number or email address to this lead to reply.</p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-full bg-canvas p-0.5" role="group" aria-label="Reply channel">
                <button type="button" className={segmentCls(replyChannel === "sms")} aria-pressed={replyChannel === "sms"} disabled={!available.sms} onClick={() => setReplyChannel("sms")}>
                  <MessageSquareText size={13} /> SMS
                </button>
                <button type="button" className={segmentCls(replyChannel === "email")} aria-pressed={replyChannel === "email"} disabled={!available.email} onClick={() => setReplyChannel("email")}>
                  <Mail size={13} /> Email
                </button>
              </div>
              <span className="text-[0.75rem] text-muted">Replies wait for approval before they go out.</span>
            </div>
            {replyChannel === "email" ? (
              <div>
                <label className={labelCls} htmlFor="inbox-subject">
                  Subject
                </label>
                <input id="inbox-subject" className={`${inputCls} w-full`} maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>
            ) : null}
            <label className="sr-only" htmlFor="inbox-body">
              Reply
            </label>
            <textarea
              id="inbox-body"
              className={textareaCls}
              placeholder={replyChannel === "sms" ? `Text ${detail.lead.name}` : `Email ${detail.lead.name}`}
              maxLength={replyChannel === "sms" ? 1600 : 5000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
              }}
              aria-invalid={formError ? true : undefined}
              aria-describedby={formError ? "inbox-error" : hint ? "inbox-hint" : undefined}
            />
            {hint ? (
              <p id="inbox-hint" className="text-[0.78125rem] text-muted">
                {hint}
              </p>
            ) : null}
            {formError ? (
              <p id="inbox-error" className="flex items-center gap-1.5 text-[0.78125rem] text-failed-text">
                <span className="aos-shape aos-shape--failed" aria-hidden style={{ ["--aos-shape-size" as string]: "8px" }} />
                {formError}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              {replyChannel === "sms" ? <span className="text-[0.75rem] text-subtle">{body.length}/1600</span> : null}
              <button type="button" className={btnPrimary} onClick={() => void send()} disabled={sending || !body.trim()}>
                {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                {sending ? "Queuing" : "Queue reply"}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
