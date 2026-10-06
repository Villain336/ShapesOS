"use client";

// ShapesOS — Phase 18.2 (WS=comms): the Messages app (/dashboard/messages).
// Workspace channels, project chats and direct messages, with threads,
// mentions and presence. Agents are members: "@Researcher …" hands it the
// task; its reply lands in the thread, and anything it wants to change shows
// inline as an approval card (Approve runs it through the same gate as the
// chat; Discard drops it; Open in chat shows the whole conversation).
// Live: one Server-Sent Events stream per open channel (it polls the
// database, so it works across server instances); presence is a heartbeat
// each minute while the page is visible.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpRight,
  AtSign,
  CornerDownRight,
  FolderKanban,
  Hash,
  Loader2,
  Lock,
  LogOut,
  MessageSquareText,
  Pencil,
  Plus,
  Send,
  Trash2,
  UserPlus,
  Users,
  X,
  Archive,
  ArchiveRestore,
  Video,
} from "lucide-react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { aosButton } from "@/components/aos/button";
import { AgentAvatar, CountBadge } from "@/components/aos/AgentAvatar";
import { ApprovalCard } from "@/components/aos/ApprovalCard";
import { StatusShape } from "@/components/aos/StatusShape";
import { cn } from "@/lib/utils";
import { mentionSegments, PRESENCE_HEARTBEAT_MS, type MentionTarget, type PresenceStatus } from "@/lib/comms/messages/model";
import type { ChannelMemberView, ChannelView, MessageView, PresenceView } from "@/lib/comms/messages/store.server";
import { Chip, EmptyState, ErrorLine, iconBtnCls, inputCls, labelCls, MockChip, Note, PersonTile, textareaCls } from "./ui";
import { Modal } from "./Modal";

import { MESSAGES_UNREAD_EVENT } from "./useMessagesUnread";

/** Tell every mounted dock to re-read the Messages count. */
const pingDock = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(MESSAGES_UNREAD_EVENT));
};

interface People {
  me: string;
  people: { key: string; userId: string; label: string; email: string | null }[];
  agents: { key: string; agentKey: string; label: string }[];
  targets: MentionTarget[];
}

async function readError(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

function upsert(list: MessageView[], m: MessageView): MessageView[] {
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    const next = list.slice();
    next[i] = m;
    return next;
  }
  const next = [...list, m];
  next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return next;
}

const ROLE_RANK: Record<string, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

export function MessagesApp({
  userId,
  role,
  initialChannel,
  initialThread,
  callsEnabled,
}: {
  userId: string;
  role: string;
  initialChannel?: string | null;
  initialThread?: string | null;
  /** Meet: whether "Start a call" is offered (the Meet app labels LiveKit's state itself). */
  callsEnabled?: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  // One live stream per open channel (in Conversation); the thread pane listens to it.
  const listeners = useRef(new Set<(m: MessageView) => void>());
  const subscribe = useCallback((fn: (m: MessageView) => void) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);
  const broadcast = useCallback((m: MessageView) => {
    for (const fn of listeners.current) fn(m);
  }, []);
  const [channels, setChannels] = useState<ChannelView[] | null>(null);
  const [people, setPeople] = useState<People | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialChannel ?? null);
  const [threadId, setThreadId] = useState<string | null>(initialThread ?? null);
  const [dialog, setDialog] = useState<"channel" | "dm" | "members" | null>(null);
  const me = `user:${userId}`;
  const canEdit = (ROLE_RANK[role] ?? 0) >= ROLE_RANK.editor!;
  const isAdmin = (ROLE_RANK[role] ?? 0) >= ROLE_RANK.admin!;

  const loadChannels = useCallback(async () => {
    try {
      const j = await api<{ channels: ChannelView[] }>("/api/comms/messages/channels");
      setChannels(j.channels);
      setError(null);
      return j.channels;
    } catch (e) {
      setError(t("comms.common.loadError", { error: e instanceof Error ? e.message : "" }));
      setChannels((prev) => prev ?? []);
      return null;
    }
  }, [t]);

  useEffect(() => {
    void loadChannels();
    void api<People>("/api/comms/messages/people").then(setPeople, () => undefined);
  }, [loadChannels]);

  // Presence: "still here" each minute while the page is visible.
  useEffect(() => {
    const beat = () => {
      if (document.visibilityState === "visible") void fetch("/api/comms/messages/presence", { method: "POST" }).catch(() => undefined);
    };
    beat();
    const h = setInterval(beat, PRESENCE_HEARTBEAT_MS);
    document.addEventListener("visibilitychange", beat);
    return () => {
      clearInterval(h);
      document.removeEventListener("visibilitychange", beat);
    };
  }, []);

  // Keep ?c= / ?t= in the address bar (shareable, back button).
  useEffect(() => {
    const p = new URLSearchParams();
    if (selected) p.set("c", selected);
    if (selected && threadId) p.set("t", threadId);
    const qs = p.toString();
    router.replace(`/dashboard/messages${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [selected, threadId, router]);

  const channel = channels?.find((c) => c.id === selected) ?? null;
  const select = (id: string | null) => {
    setSelected(id);
    setThreadId(null);
  };

  const applyUnread = useCallback(
    (map: Record<string, { unread: number; mentioned: boolean }>) => {
      setChannels((prev) => {
        if (!prev) return prev;
        if (Object.keys(map).some((id) => !prev.some((c) => c.id === id))) void loadChannels(); // a new DM or channel for me
        return prev.map((c) => ({ ...c, unread: map[c.id]?.unread ?? 0, mentioned: map[c.id]?.mentioned ?? false }));
      });
      pingDock();
    },
    [loadChannels],
  );

  const groups: { id: string; label: string; items: ChannelView[] }[] = useMemo(() => {
    const list = channels ?? [];
    const byName = (a: ChannelView, b: ChannelView) => a.name.localeCompare(b.name);
    return [
      { id: "channel", label: t("comms.messages.channels"), items: list.filter((c) => c.kind === "channel").sort(byName) },
      { id: "dm", label: t("comms.messages.directMessages"), items: list.filter((c) => c.kind === "dm") },
      { id: "project", label: t("comms.messages.projects"), items: list.filter((c) => c.kind === "project").sort(byName) },
    ];
  }, [channels, t]);

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="aos-heading text-ink">{t("comms.messages.title")}</h1>
          <p className="mt-1 max-w-[80ch] text-sm text-muted">{t("comms.messages.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => setDialog("channel")}>
            <Hash className="size-4" aria-hidden />
            {t("comms.messages.newChannel")}
          </button>
          <button type="button" className={aosButton({ variant: "primary", size: "sm" })} onClick={() => setDialog("dm")}>
            <Plus className="size-4" aria-hidden />
            {t("comms.messages.newDm")}
          </button>
        </div>
      </div>
      <ErrorLine message={error} />
      <div
        className={cn(
          "grid gap-4 lg:h-[calc(100dvh-220px)] lg:min-h-[560px]",
          threadId ? "lg:grid-cols-[250px_minmax(0,1fr)_minmax(300px,380px)]" : "lg:grid-cols-[250px_minmax(0,1fr)]",
        )}
      >
        <nav aria-label={t("comms.messages.conversations")} className={cn("min-h-0 flex-col gap-4 overflow-y-auto", selected ? "hidden lg:flex" : "flex")}>
          {channels === null ? (
            <p className="flex items-center gap-2 px-3 text-sm text-muted">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t("comms.messages.conversations")}
            </p>
          ) : (
            groups.map((g) => (
              <div key={g.id}>
                <h2 className="px-3 pb-1 text-xs font-semibold text-subtle">{g.label}</h2>
                {g.items.length === 0 ? (
                  <p className="px-3 text-sm text-muted">—</p>
                ) : (
                  <ul className="flex flex-col gap-0.5">
                    {g.items.map((c) => (
                      <li key={c.id}>
                        <ChannelRow channel={c} active={c.id === selected} onSelect={() => select(c.id)} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))
          )}
        </nav>
        {channel ? (
          <Conversation
            key={channel.id}
            channel={channel}
            me={me}
            canEdit={canEdit}
            isAdmin={isAdmin}
            people={people}
            threadId={threadId}
            onOpenThread={setThreadId}
            onBack={() => select(null)}
            onUnread={applyUnread}
            onChanged={() => void loadChannels()}
            onMembers={() => setDialog("members")}
            onGone={() => {
              select(null);
              void loadChannels();
            }}
            onIncoming={broadcast}
            callsEnabled={!!callsEnabled}
          />
        ) : (
          <section className={cn("min-h-0 rounded-lg bg-paper shadow-hairline", selected ? "flex" : "hidden lg:flex", "items-center justify-center")}>
            <EmptyState icon={MessageSquareText} title={t("comms.messages.noChannel")} body={t("comms.messages.noChannelBody")} />
          </section>
        )}
        {channel && threadId ? (
          <ThreadPane key={`${channel.id}:${threadId}`} channel={channel} rootId={threadId} me={me} canEdit={canEdit} isAdmin={isAdmin} people={people} subscribe={subscribe} onClose={() => setThreadId(null)} />
        ) : null}
      </div>
      <NewChannelDialog
        open={dialog === "channel"}
        onOpenChange={(o) => setDialog(o ? "channel" : null)}
        people={people}
        onCreated={(c) => {
          setDialog(null);
          void loadChannels().then(() => select(c.id));
        }}
      />
      <NewDmDialog
        open={dialog === "dm"}
        onOpenChange={(o) => setDialog(o ? "dm" : null)}
        people={people}
        onOpened={(c) => {
          setDialog(null);
          void loadChannels().then(() => select(c.id));
        }}
      />
      {channel ? (
        <MembersDialog
          open={dialog === "members"}
          onOpenChange={(o) => setDialog(o ? "members" : null)}
          channel={channel}
          people={people}
          me={me}
          isAdmin={isAdmin}
          onChanged={(left) => {
            if (left) select(null);
            void loadChannels();
          }}
        />
      ) : null}
    </div>
  );
}

function ChannelIcon({ channel, className }: { channel: ChannelView; className?: string }) {
  if (channel.kind === "project") return <FolderKanban className={className} aria-hidden />;
  if (channel.kind === "dm") {
    const agent = channel.dmWith?.length === 1 && channel.dmWith[0]!.kind === "agent";
    return agent ? <AgentAvatar name={channel.dmWith![0]!.label} size="xs" /> : <AtSign className={className} aria-hidden />;
  }
  return channel.isPrivate ? <Lock className={className} aria-hidden /> : <Hash className={className} aria-hidden />;
}

function ChannelRow({ channel, active, onSelect }: { channel: ChannelView; active: boolean; onSelect: () => void }) {
  const { t } = useI18n();
  const unread = active ? 0 : channel.unread;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-sm px-3 text-left text-sm",
        active ? "bg-ink font-semibold text-paper" : unread ? "font-semibold text-ink hover:bg-hover" : "text-muted hover:bg-hover",
      )}
    >
      <ChannelIcon channel={channel} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{channel.name}</span>
      {channel.mentioned && !active ? <AtSign className="size-3.5 shrink-0" aria-label={t("comms.messages.mentioned")} /> : null}
      {unread > 0 ? <CountBadge count={unread} tone={active ? "paper" : "ink"} label={t("comms.messages.unreadLabel", { count: unread })} /> : null}
    </button>
  );
}

function presenceText(t: ReturnType<typeof useI18n>["t"], p: PresenceView | undefined, relative: (d: string) => string): string {
  if (!p) return t("comms.messages.presence.offline");
  // "Active 5 minutes ago" while away; "Last seen …" once offline.
  if (p.status === "away" && p.lastSeenAt) return t("comms.messages.activeAgo", { ago: relative(p.lastSeenAt) });
  if (p.status === "offline" && p.lastSeenAt) return t("comms.messages.lastSeen", { ago: relative(p.lastSeenAt) });
  return t(`comms.messages.presence.${p.status}`);
}

/** Neutral presence mark: filled = active, ring = away, none = offline / focusing (never a status colour). */
function PresenceDot({ status }: { status: PresenceStatus | undefined }) {
  if (status === "active") return <span aria-hidden className="inline-block size-2 shrink-0 rounded-full bg-ink" />;
  if (status === "away") return <span aria-hidden className="inline-block size-2 shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_var(--aos-ink)]" />;
  return null;
}

function Body({ text, targets, me }: { text: string; targets: MentionTarget[]; me: string }) {
  const segs = useMemo(() => mentionSegments(text, targets), [text, targets]);
  return (
    <p className="text-md break-words whitespace-pre-wrap text-ink">
      {segs.map((s, i) =>
        s.key ? (
          <span key={i} className={cn("rounded-key px-0.5 font-semibold", s.key === me ? "bg-ink text-paper" : "bg-hover text-ink")}>
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </p>
  );
}

function Conversation({
  channel,
  me,
  canEdit,
  isAdmin,
  people,
  threadId,
  onOpenThread,
  onBack,
  onUnread,
  onChanged,
  onMembers,
  onGone,
  onIncoming,
  callsEnabled,
}: {
  channel: ChannelView;
  me: string;
  canEdit: boolean;
  isAdmin: boolean;
  people: People | null;
  threadId: string | null;
  onOpenThread: (id: string | null) => void;
  onBack: () => void;
  onUnread: (map: Record<string, { unread: number; mentioned: boolean }>) => void;
  onChanged: () => void;
  onMembers: () => void;
  onGone: () => void;
  onIncoming: (m: MessageView) => void;
  callsEnabled: boolean;
}) {
  const { t, format } = useI18n();
  const [messages, setMessages] = useState<MessageView[] | null>(null);
  // The stream's callbacks, read through a ref so a re-render never reconnects it.
  const handlers = useRef({ onUnread, onGone, onIncoming });
  handlers.current = { onUnread, onGone, onIncoming };
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [presence, setPresence] = useState<Record<string, PresenceView>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const targets = people?.targets ?? [];

  const markRead = useCallback(() => {
    if (readTimer.current) clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      void fetch(`/api/comms/messages/channels/${encodeURIComponent(channel.id)}/read`, { method: "POST" })
        .then(() => pingDock())
        .catch(() => undefined);
    }, 800);
  }, [channel.id]);

  const load = useCallback(
    async (before?: string) => {
      try {
        const p = new URLSearchParams();
        if (before) p.set("before", before);
        const j = await api<{ messages: MessageView[]; hasMore: boolean }>(`/api/comms/messages/channels/${encodeURIComponent(channel.id)}/messages?${p}`);
        setMessages((prev) => (before && prev ? [...j.messages, ...prev] : j.messages));
        setHasMore(j.hasMore);
        setError(null);
      } catch (e) {
        setError(t("comms.common.loadError", { error: e instanceof Error ? e.message : "" }));
        setMessages((prev) => prev ?? []);
      }
    },
    [channel.id, t],
  );

  useEffect(() => {
    void load();
    markRead();
  }, [load, markRead]);

  // Live updates for this channel.
  useEffect(() => {
    const es = new EventSource(`/api/comms/messages/stream?channel=${encodeURIComponent(channel.id)}`);
    es.addEventListener("ready", () => setLive("live"));
    es.addEventListener("message", (e) => {
      const m = JSON.parse((e as MessageEvent).data) as MessageView;
      if (!m.parentId) setMessages((prev) => upsert(prev ?? [], m));
      handlers.current.onIncoming(m);
      if (m.userId !== me.slice("user:".length)) markRead();
    });
    es.addEventListener("unread", (e) => handlers.current.onUnread((JSON.parse((e as MessageEvent).data) as { channels: Record<string, { unread: number; mentioned: boolean }> }).channels));
    es.addEventListener("presence", (e) => {
      const list = (JSON.parse((e as MessageEvent).data) as { presence: PresenceView[] }).presence;
      setPresence(Object.fromEntries(list.map((p) => [p.userId, p])));
    });
    es.addEventListener("gone", () => {
      es.close();
      handlers.current.onGone();
    });
    es.onerror = () => setLive("reconnecting");
    return () => es.close();
  }, [channel.id, me, markRead]);

  // Stick to the bottom while the reader is there.
  useEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const dmAgent = channel.kind === "dm" && channel.dmWith?.length === 1 && channel.dmWith[0]!.kind === "agent" ? channel.dmWith[0]! : null;
  const dmPerson = channel.kind === "dm" && channel.dmWith?.length === 1 && channel.dmWith[0]!.kind === "user" ? channel.dmWith[0]! : null;
  const canPost = !channel.archived;
  const title = channel.kind === "channel" ? `#${channel.name}` : channel.name;

  const post = async (body: string) => {
    const out = await api<{ message: MessageView; agents: string[]; agentsSkipped: string | null }>(`/api/comms/messages/channels/${encodeURIComponent(channel.id)}/messages`, {
      method: "POST",
      json: { body },
    });
    atBottom.current = true;
    setMessages((prev) => upsert(prev ?? [], out.message));
    const names = out.agents.map((a) => people?.agents.find((x) => x.agentKey === a)?.label ?? a).join(", ");
    setNotice(
      out.agentsSkipped === "viewer"
        ? t("comms.messages.agentsViewer")
        : out.agentsSkipped === "too_many"
          ? t("comms.messages.agentsTooMany")
          : out.agents.length
            ? t("comms.messages.agentStarted", { agents: names })
            : null,
    );
    if (!channel.joined) onChanged();
  };

  return (
    <section aria-labelledby={`conv-${channel.id}`} className="flex min-h-[480px] min-w-0 flex-col rounded-lg bg-paper shadow-hairline lg:min-h-0">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <button type="button" onClick={onBack} className={cn(iconBtnCls, "lg:hidden")} aria-label={t("comms.messages.conversations")}>
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        <ChannelIcon channel={channel} className="size-4 shrink-0 text-ink" />
        <div className="min-w-0 flex-1">
          <h2 id={`conv-${channel.id}`} className="aos-subheading truncate text-ink">
            {title}
          </h2>
          {channel.topic ? <p className="truncate text-xs text-muted">{channel.topic}</p> : null}
          {dmPerson?.userId ? (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <PresenceDot status={presence[dmPerson.userId]?.status} />
              {presenceText(t, presence[dmPerson.userId], (d) => format.relative(d))}
            </p>
          ) : null}
          {dmAgent ? <p className="text-xs text-muted">{t("comms.messages.dmAgentHint", { agent: dmAgent.label })}</p> : null}
        </div>
        <span className="text-xs text-muted" role="status">
          {live === "live" ? t("comms.messages.live") : live === "reconnecting" ? t("comms.messages.reconnecting") : null}
        </span>
        {callsEnabled ? (
          <Link
            href={`/dashboard/meet?origin=channel&ref=${encodeURIComponent(channel.id)}&title=${encodeURIComponent(title)}`}
            className={aosButton({ variant: "secondary", size: "sm" })}
          >
            <Video className="size-4" aria-hidden />
            {t("comms.messages.startCall")}
          </Link>
        ) : null}
        {channel.kind !== "dm" ? (
          <button type="button" onClick={onMembers} className={aosButton({ variant: "quiet", size: "sm" })}>
            <Users className="size-4" aria-hidden />
            {t("comms.messages.memberCount", { count: channel.memberCount })}
          </button>
        ) : null}
        {channel.kind === "channel" && !channel.joined && !channel.isPrivate ? (
          <button
            type="button"
            className={aosButton({ variant: "primary", size: "sm" })}
            onClick={() =>
              void api(`/api/comms/messages/channels/${encodeURIComponent(channel.id)}/members`, { method: "POST", json: { join: true } })
                .then(onChanged)
                .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            }
          >
            {t("comms.messages.join")}
          </button>
        ) : null}
      </header>
      {channel.archived ? <Note className="m-3">{t("comms.messages.archived")}</Note> : null}
      {channel.kind === "channel" && !channel.joined && !channel.isPrivate ? <p className="px-4 pt-2 text-xs text-muted">{t("comms.messages.joinHint")}</p> : null}
      <ErrorLine message={error} className="px-4 pt-2" />
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        {hasMore && messages?.length ? (
          <div className="mb-3 flex justify-center">
            <button type="button" onClick={() => void load(messages[0]!.createdAt)} className={aosButton({ variant: "quiet", size: "xs" })}>
              {t("comms.messages.loadOlder")}
            </button>
          </div>
        ) : null}
        {messages === null ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden />
          </p>
        ) : messages.length === 0 ? (
          <EmptyState icon={MessageSquareText} title={t("comms.messages.empty")} body={t("comms.messages.emptyBody")} />
        ) : (
          <ol className="flex flex-col">
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const day = new Date(m.createdAt).toDateString();
              const newDay = !prev || new Date(prev.createdAt).toDateString() !== day;
              const compact = !newDay && !!prev && prev.userId === m.userId && prev.authorKind === m.authorKind && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000 && !prev.replyCount;
              return (
                <li key={m.id}>
                  {newDay ? (
                    <div className="my-3 flex items-center gap-3" role="separator">
                      <span className="h-px flex-1 bg-line" />
                      <span className="text-xs font-semibold text-subtle">{format.date(m.createdAt, "date")}</span>
                      <span className="h-px flex-1 bg-line" />
                    </div>
                  ) : null}
                  <MessageItem
                    m={m}
                    me={me}
                    compact={compact}
                    targets={targets}
                    canEdit={canEdit}
                    isAdmin={isAdmin}
                    people={people}
                    channel={channel}
                    onChanged={(next) => setMessages((p) => upsert(p ?? [], next))}
                    onThread={() => onOpenThread(threadId === m.id ? null : m.id)}
                    threadOpen={threadId === m.id}
                  />
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {notice ? (
        <p role="status" className="px-4 pb-1 text-sm text-muted">
          {notice}
        </p>
      ) : null}
      {canPost ? (
        <Composer
          targets={targets}
          me={me}
          placeholder={t("comms.messages.composerPlaceholder", { name: title })}
          onSend={post}
        />
      ) : null}
    </section>
  );
}

function MessageItem({
  m,
  me,
  compact,
  targets,
  canEdit,
  isAdmin,
  people,
  channel,
  onChanged,
  onThread,
  threadOpen,
  inThread,
}: {
  m: MessageView;
  me: string;
  compact: boolean;
  targets: MentionTarget[];
  canEdit: boolean;
  isAdmin: boolean;
  people: People | null;
  channel: ChannelView;
  onChanged: (m: MessageView) => void;
  onThread?: () => void;
  threadOpen?: boolean;
  inThread?: boolean;
}) {
  const { t, format } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.body);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = m.authorKind === "user" && `user:${m.userId}` === me;
  const isAgent = m.authorKind === "agent" || m.authorKind === "system";

  const save = async () => {
    try {
      const j = await api<{ message: MessageView }>(`/api/comms/messages/message/${encodeURIComponent(m.id)}`, { method: "PATCH", json: { body: draft } });
      onChanged({ ...j.message, replyCount: m.replyCount, lastReplyAt: m.lastReplyAt });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const remove = async () => {
    try {
      const j = await api<{ message: MessageView }>(`/api/comms/messages/message/${encodeURIComponent(m.id)}`, { method: "DELETE" });
      onChanged({ ...j.message, replyCount: m.replyCount, lastReplyAt: m.lastReplyAt });
      setConfirmRemove(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <article className={cn("group/msg relative flex gap-3 rounded-md px-2 hover:bg-hover-paper", compact ? "py-0.5" : "pt-2 pb-1")} aria-label={`${m.authorName}, ${format.date(m.createdAt, "dateTime")}`}>
      <div className="w-8 shrink-0">{compact ? null : isAgent ? <AgentAvatar name={m.authorName} size="md" /> : <PersonTile name={m.authorName} size={32} />}</div>
      <div className="min-w-0 flex-1">
        {compact ? null : (
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-md font-semibold text-ink">{m.authorName}</span>
            {isAgent ? <Chip className="h-5 px-2">{m.authorKind === "system" ? t("comms.messages.noteBadge") : t("comms.messages.agentBadge")}</Chip> : null}
            <time dateTime={m.createdAt} className="text-xs text-muted tabular-nums">
              {format.date(m.createdAt, "time")}
            </time>
            {m.editedAt && !m.removed && !isAgent ? <span className="text-xs text-muted">{t("comms.messages.edited")}</span> : null}
          </div>
        )}
        {m.removed ? (
          <p className="text-sm text-muted italic">{t("comms.messages.removed")}</p>
        ) : editing ? (
          <div className="mt-1 flex flex-col gap-2">
            <label className="sr-only" htmlFor={`edit-${m.id}`}>
              {t("comms.messages.editMessage")}
            </label>
            <textarea id={`edit-${m.id}`} value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} className={textareaCls} />
            <div className="flex gap-2">
              <button type="button" onClick={() => void save()} className={aosButton({ variant: "primary", size: "xs" })}>
                {t("comms.messages.save")}
              </button>
              <button type="button" onClick={() => setEditing(false)} className={aosButton({ variant: "quiet", size: "xs" })}>
                {t("comms.messages.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <Body text={m.body} targets={targets} me={me} />
        )}
        {m.call ? (
          <Link href={`/dashboard/meet?m=${encodeURIComponent(m.call.meetingId)}`} className={aosButton({ variant: "secondary", size: "xs", className: "mt-1.5 self-start" })}>
            <Video className="size-3.5" aria-hidden />
            {t("comms.messages.joinCall")}
          </Link>
        ) : null}
        {m.meta ? <AgentBlock m={m} me={me} canEdit={canEdit} isAdmin={isAdmin} people={people} onChanged={onChanged} /> : null}
        {confirmRemove ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink">
            {t("comms.messages.removeConfirm")}
            <button type="button" onClick={() => void remove()} className={aosButton({ variant: "deny", size: "xs" })}>
              {t("comms.messages.removeMessage")}
            </button>
            <button type="button" onClick={() => setConfirmRemove(false)} className={aosButton({ variant: "quiet", size: "xs" })}>
              {t("comms.messages.cancel")}
            </button>
          </div>
        ) : null}
        <ErrorLine message={error} />
        {!inThread && m.replyCount > 0 ? (
          <button type="button" onClick={onThread} aria-expanded={threadOpen} className="mt-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-sm font-semibold text-ink hover:bg-hover">
            <CornerDownRight className="size-3.5" aria-hidden />
            {t("comms.messages.replies", { count: m.replyCount })}
            {m.lastReplyAt ? <span className="font-normal text-muted">· {format.relative(m.lastReplyAt)}</span> : null}
          </button>
        ) : null}
      </div>
      {!m.removed && !editing ? (
        <div className="absolute top-1 right-2 hidden gap-0.5 rounded-full bg-paper p-0.5 shadow-hairline group-focus-within/msg:flex group-hover/msg:flex">
          {!inThread && onThread ? (
            <button type="button" onClick={onThread} className={cn(iconBtnCls, "size-7")} aria-label={t("comms.messages.replyInThread")} title={t("comms.messages.replyInThread")}>
              <CornerDownRight className="size-3.5" aria-hidden />
            </button>
          ) : null}
          {mine && !channel.archived ? (
            <button
              type="button"
              onClick={() => {
                setDraft(m.body);
                setEditing(true);
              }}
              className={cn(iconBtnCls, "size-7")}
              aria-label={t("comms.messages.editMessage")}
              title={t("comms.messages.editMessage")}
            >
              <Pencil className="size-3.5" aria-hidden />
            </button>
          ) : null}
          {mine || isAdmin ? (
            <button type="button" onClick={() => setConfirmRemove(true)} className={cn(iconBtnCls, "size-7")} aria-label={t("comms.messages.removeMessage")} title={t("comms.messages.removeMessage")}>
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/** An agent reply's extras: mock label, run link, and its inline proposal. */
function AgentBlock({ m, me, canEdit, isAdmin, people, onChanged }: { m: MessageView; me: string; canEdit: boolean; isAdmin: boolean; people: People | null; onChanged: (m: MessageView) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const meta = m.meta!;
  const requester = people?.people.find((p) => p.userId === meta.requestedBy)?.label ?? "";
  const iAsked = `user:${meta.requestedBy}` === me;
  const mayDecide = canEdit && (iAsked || isAdmin);
  const decide = async (decision: "approve" | "discard") => {
    setBusy(decision === "approve" ? "approve" : "deny");
    setError(null);
    try {
      const j = await api<{ meta: NonNullable<MessageView["meta"]> }>(`/api/comms/messages/message/${encodeURIComponent(m.id)}/decide`, { method: "POST", json: { decision } });
      onChanged({ ...m, meta: j.meta });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const d = meta.decision;
  const chatHref = iAsked && meta.chatThreadId && meta.projectId ? `/dashboard/assistant?project=${encodeURIComponent(meta.projectId)}&thread=${encodeURIComponent(meta.chatThreadId)}` : undefined;
  return (
    <div className="mt-1.5 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {meta.mock ? <MockChip label={t("comms.common.mock")} title={t("comms.messages.mockReply")} /> : null}
        {meta.runId ? (
          <Link href={`/dashboard/runs/${encodeURIComponent(meta.runId)}`} className="inline-flex items-center gap-1 text-sm font-semibold text-ink underline underline-offset-4">
            {t("comms.messages.openRun")}
            <ArrowUpRight className="size-3.5" aria-hidden />
          </Link>
        ) : null}
      </div>
      {meta.proposals.length && (meta.awaiting || d) ? (
        d ? (
          <p className="flex items-center gap-2 text-sm text-ink" role="status">
            <StatusShape status={d.decision === "discard" ? "done" : d.status === "running" ? "running" : d.status === "failed" ? "failed" : "done"} size={11} />
            {d.decision === "discard"
              ? t("comms.messages.discardedBy", { name: d.byName })
              : d.status === "running"
                ? t("comms.messages.approvedRunning", { name: d.byName })
                : d.status === "failed"
                  ? t("comms.messages.approvedFailed", { name: d.byName, note: d.note ?? "" })
                  : t("comms.messages.approvedDone", { name: d.byName })}
          </p>
        ) : (
          <ApprovalCard
            className="max-w-xl"
            agent={m.authorName}
            title={t("comms.messages.proposalTitle", { agent: m.authorName })}
            body={t("comms.messages.proposalBody")}
            items={meta.proposals.map((p, i) => ({ key: `${p.tool}-${i}`, label: p.tool, detail: p.summary }))}
            mode={mayDecide ? "decide" : "blocked"}
            approveLabel={t("comms.messages.approve")}
            denyLabel={t("comms.messages.discard")}
            editLabel={t("comms.messages.openChat")}
            editHref={chatHref}
            blockedReason={canEdit ? t("comms.messages.blockedRequester", { name: requester || "—" }) : t("comms.messages.blockedViewer")}
            openHref={meta.runId ? `/dashboard/runs/${encodeURIComponent(meta.runId)}` : undefined}
            openLabel={t("comms.messages.openRun")}
            onApprove={() => void decide("approve")}
            onDeny={() => void decide("discard")}
            busy={busy}
          />
        )
      ) : null}
      <ErrorLine message={error} />
    </div>
  );
}

function ThreadPane({
  channel,
  rootId,
  me,
  canEdit,
  isAdmin,
  people,
  subscribe,
  onClose,
}: {
  channel: ChannelView;
  rootId: string;
  me: string;
  canEdit: boolean;
  isAdmin: boolean;
  people: People | null;
  subscribe: (fn: (m: MessageView) => void) => () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<MessageView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const targets = people?.targets ?? [];

  useEffect(() => {
    let live = true;
    void api<{ messages: MessageView[] }>(`/api/comms/messages/channels/${encodeURIComponent(channel.id)}/messages?thread=${encodeURIComponent(rootId)}`)
      .then((j) => live && setMessages(j.messages))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    // Live: the open channel's stream (the root and its replies).
    const off = subscribe((m) => {
      if (m.id === rootId || m.parentId === rootId) setMessages((prev) => upsert(prev ?? [], m));
    });
    return () => {
      live = false;
      off();
    };
  }, [channel.id, rootId, subscribe]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages?.length]);

  const reply = async (body: string) => {
    const out = await api<{ message: MessageView }>(`/api/comms/messages/channels/${encodeURIComponent(channel.id)}/messages`, { method: "POST", json: { body, parentId: rootId } });
    setMessages((prev) => upsert(prev ?? [], out.message));
  };

  return (
    <aside aria-label={t("comms.messages.thread")} className="flex min-h-[420px] min-w-0 flex-col rounded-lg bg-paper shadow-hairline lg:min-h-0">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="aos-subheading min-w-0 flex-1 truncate text-ink">{t("comms.messages.thread")}</h2>
        <button type="button" onClick={onClose} className={iconBtnCls} aria-label={t("comms.messages.closeThread")}>
          <X className="size-4" aria-hidden />
        </button>
      </header>
      <ErrorLine message={error} className="px-4 pt-2" />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {messages === null ? (
          <Loader2 className="mx-3 size-4 animate-spin text-muted" aria-hidden />
        ) : (
          <ol className="flex flex-col gap-1">
            {messages.map((m, i) => (
              <li key={m.id} className={cn(i === 0 && "border-b border-line pb-2")}>
                <MessageItem m={m} me={me} compact={false} targets={targets} canEdit={canEdit} isAdmin={isAdmin} people={people} channel={channel} onChanged={(n) => setMessages((p) => upsert(p ?? [], n))} inThread />
              </li>
            ))}
          </ol>
        )}
        <div ref={bottom} />
      </div>
      {!channel.archived ? <Composer targets={targets} me={me} placeholder={t("comms.messages.replyPlaceholder")} onSend={reply} compact /> : null}
    </aside>
  );
}

/** The message box with @-mention suggestions (listbox, arrow keys, Enter / Tab to pick). */
function Composer({ targets, me, placeholder, onSend, compact }: { targets: MentionTarget[]; me: string; placeholder: string; onSend: (body: string) => Promise<void>; compact?: boolean }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState<{ q: string; start: number } | null>(null);
  const [active, setActive] = useState(0);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const listId = useRef(`mentions-${Math.random().toString(36).slice(2, 8)}`).current;

  const matches = useMemo(() => {
    if (!query) return [];
    const q = query.q.toLowerCase();
    return targets
      .filter((x) => x.key !== me && x.handles.length && (x.handles.some((h) => h.startsWith(q)) || x.label.toLowerCase().startsWith(q)))
      .slice(0, 8);
  }, [query, targets, me]);

  const detect = (value: string, caret: number) => {
    const m = /(^|[\s([{"'])@([\p{L}\p{N}._-]*)$/u.exec(value.slice(0, caret));
    if (m) {
      setQuery({ q: m[2]!, start: caret - m[2]!.length - 1 });
      setActive(0);
    } else setQuery(null);
  };

  const pick = (target: MentionTarget) => {
    if (!query) return;
    const el = area.current;
    const caret = el?.selectionStart ?? text.length;
    const handle = target.handles[0]!;
    const insert = `@${target.kind === "agent" ? target.label.replace(/\s+/g, "") : handle} `;
    const next = text.slice(0, query.start) + insert + text.slice(caret);
    setText(next);
    setQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = query.start + insert.length;
      el?.setSelectionRange(pos, pos);
    });
  };

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(body);
      setText("");
      setQuery(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (query && matches.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(matches[active]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const open = !!query && matches.length > 0;
  return (
    <div className={cn("relative border-t border-line", compact ? "p-2" : "p-3")}>
      {open ? (
        <ul id={listId} role="listbox" aria-label={t("comms.messages.mentionSuggestions")} className="absolute right-3 bottom-full left-3 z-10 mb-1 max-h-64 overflow-y-auto rounded-md bg-paper p-1 shadow-overlay">
          {matches.map((m, i) => (
            <li
              key={m.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
              className={cn("flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm", i === active ? "bg-ink text-paper" : "text-ink hover:bg-hover")}
            >
              {m.kind === "agent" ? <AgentAvatar name={m.label} size="xs" tone={i === active ? "paper" : "ink"} /> : <PersonTile name={m.label} size={20} />}
              <span className="font-semibold">{m.label}</span>
              <span className={cn("truncate text-xs", i === active ? "text-paper" : "text-muted")}>@{m.kind === "agent" ? m.label.replace(/\s+/g, "") : m.handles[0]}</span>
              {m.kind === "agent" ? <span className={cn("ml-auto text-xs", i === active ? "text-paper" : "text-muted")}>{t("comms.messages.agentBadge")}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-end gap-2">
        <label className="sr-only" htmlFor={`${listId}-input`}>
          {t("comms.messages.composerLabel")}
        </label>
        <textarea
          id={`${listId}-input`}
          ref={area}
          value={text}
          rows={compact ? 2 : 2}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            detect(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setQuery(null), 120)}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          aria-describedby={`${listId}-hint`}
          className={cn(textareaCls, "max-h-48 min-h-[44px] resize-y")}
        />
        <button type="button" onClick={() => void send()} disabled={sending || !text.trim()} className={aosButton({ variant: "primary", size: "sm" })} aria-label={t("comms.messages.send")}>
          {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
          <span className="hidden sm:inline">{t("comms.messages.send")}</span>
        </button>
      </div>
      <p id={`${listId}-hint`} className="mt-1 text-xs text-muted">
        {t("comms.messages.composerHint")}
      </p>
      <ErrorLine message={error} />
    </div>
  );
}

function PeoplePicker({ people, value, onChange, exclude = [] }: { people: People | null; value: string[]; onChange: (v: string[]) => void; exclude?: string[] }) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  if (!people) return <Loader2 className="size-4 animate-spin text-muted" aria-hidden />;
  const ql = q.trim().toLowerCase();
  const match = (label: string, extra?: string | null) => !ql || label.toLowerCase().includes(ql) || (extra ?? "").toLowerCase().includes(ql);
  const persons = people.people.filter((p) => p.key !== people.me && !exclude.includes(p.key) && match(p.label, p.email));
  const agents = people.agents.filter((a) => !exclude.includes(a.key) && match(a.label, a.agentKey));
  const toggle = (k: string) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  const row = (key: string, label: string, sub: string | null, icon: ReactNode) => (
    <li key={key}>
      <label className="flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 hover:bg-hover">
        <input type="checkbox" checked={value.includes(key)} onChange={() => toggle(key)} className="size-4 accent-[var(--aos-ink)]" />
        {icon}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-ink">{label}</span>
          {sub ? <span className="block truncate text-xs text-muted">{sub}</span> : null}
        </span>
      </label>
    </li>
  );
  return (
    <div className="flex flex-col gap-2">
      <label className="sr-only" htmlFor="people-search">
        {t("comms.messages.searchPeople")}
      </label>
      <input id="people-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("comms.messages.searchPeople")} className={inputCls} />
      <div className="max-h-72 overflow-y-auto">
        {persons.length ? (
          <>
            <h3 className="px-2 pt-1 text-xs font-semibold text-subtle">{t("comms.messages.people")}</h3>
            <ul>{persons.map((p) => row(p.key, p.label, p.email, <PersonTile name={p.label} size={24} />))}</ul>
          </>
        ) : null}
        {agents.length ? (
          <>
            <h3 className="px-2 pt-2 text-xs font-semibold text-subtle">{t("comms.messages.agents")}</h3>
            <ul>{agents.map((a) => row(a.key, a.label, null, <AgentAvatar name={a.label} size="sm" />))}</ul>
          </>
        ) : null}
        {!persons.length && !agents.length ? <p className="px-2 text-sm text-muted">{t("comms.messages.nobodyFound")}</p> : null}
      </div>
    </div>
  );
}

function NewChannelDialog({ open, onOpenChange, people, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; people: People | null; onCreated: (c: ChannelView) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [isPrivate, setPrivate] = useState(false);
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const j = await api<{ channel: ChannelView }>("/api/comms/messages/channels", { method: "POST", json: { name, topic: topic || null, isPrivate, members } });
      setName("");
      setTopic("");
      setMembers([]);
      setPrivate(false);
      onCreated(j.channel);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t("comms.messages.newChannel")}
      closeLabel={t("comms.messages.cancel")}
      footer={
        <>
          <button type="button" onClick={() => onOpenChange(false)} className={aosButton({ variant: "quiet", size: "sm" })}>
            {t("comms.messages.cancel")}
          </button>
          <button type="button" onClick={() => void submit()} disabled={busy || !name.trim()} className={aosButton({ variant: "primary", size: "sm" })}>
            {busy ? t("comms.messages.creating") : t("comms.messages.create")}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ch-name" className={labelCls}>
            {t("comms.messages.name")}
          </label>
          <input id="ch-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("comms.messages.namePlaceholder")} className={inputCls} maxLength={80} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ch-topic" className={labelCls}>
            {t("comms.messages.topic")}
          </label>
          <input id="ch-topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={t("comms.messages.topicPlaceholder")} className={inputCls} maxLength={250} />
        </div>
        <label className="flex items-start gap-2.5">
          <input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} className="mt-0.5 size-4 accent-[var(--aos-ink)]" />
          <span>
            <span className="block text-sm font-semibold text-ink">{t("comms.messages.private")}</span>
            <span className="block text-xs text-muted">{t("comms.messages.privateHint")}</span>
          </span>
        </label>
        <div className="flex flex-col gap-1.5">
          <span className={labelCls}>{t("comms.messages.addMembers")}</span>
          <PeoplePicker people={people} value={members} onChange={setMembers} />
        </div>
        <ErrorLine message={error} />
      </div>
    </Modal>
  );
}

function NewDmDialog({ open, onOpenChange, people, onOpened }: { open: boolean; onOpenChange: (o: boolean) => void; people: People | null; onOpened: (c: ChannelView) => void }) {
  const { t } = useI18n();
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const j = await api<{ channel: ChannelView }>("/api/comms/messages/dm", { method: "POST", json: { members } });
      setMembers([]);
      onOpened(j.channel);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t("comms.messages.newDm")}
      closeLabel={t("comms.messages.cancel")}
      footer={
        <>
          <button type="button" onClick={() => onOpenChange(false)} className={aosButton({ variant: "quiet", size: "sm" })}>
            {t("comms.messages.cancel")}
          </button>
          <button type="button" onClick={() => void submit()} disabled={busy || members.length === 0} className={aosButton({ variant: "primary", size: "sm" })}>
            {t("comms.messages.startDm")}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">{t("comms.messages.pickHint")}</p>
        <PeoplePicker people={people} value={members} onChange={setMembers} />
        <ErrorLine message={error} />
      </div>
    </Modal>
  );
}

function MembersDialog({
  open,
  onOpenChange,
  channel,
  people,
  me,
  isAdmin,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  channel: ChannelView;
  people: People | null;
  me: string;
  isAdmin: boolean;
  onChanged: (left: boolean) => void;
}) {
  const { t, format } = useI18n();
  const [members, setMembers] = useState<ChannelMemberView[] | null>(null);
  const [presence, setPresence] = useState<Record<string, PresenceView>>({});
  const [adding, setAdding] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void api<{ members: ChannelMemberView[] }>(`/api/comms/messages/channels/${encodeURIComponent(channel.id)}`)
      .then(async (j) => {
        if (!live) return;
        setMembers(j.members);
        const ids = j.members.filter((m) => m.userId).map((m) => m.userId!);
        if (ids.length) {
          const p = await api<{ presence: PresenceView[] }>(`/api/comms/messages/presence?ids=${encodeURIComponent(ids.join(","))}`);
          if (live) setPresence(Object.fromEntries(p.presence.map((x) => [x.userId, x])));
        }
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [open, channel.id]);

  const add = async () => {
    try {
      const j = await api<{ members: ChannelMemberView[] }>(`/api/comms/messages/channels/${encodeURIComponent(channel.id)}/members`, { method: "POST", json: { members: adding } });
      setMembers(j.members);
      setAdding([]);
      onChanged(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const leave = async () => {
    try {
      await api(`/api/comms/messages/channels/${encodeURIComponent(channel.id)}/members`, { method: "DELETE" });
      onOpenChange(false);
      onChanged(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const archive = async (archived: boolean) => {
    try {
      await api(`/api/comms/messages/channels/${encodeURIComponent(channel.id)}`, { method: "PATCH", json: { archived } });
      onOpenChange(false);
      onChanged(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const canManage = channel.kind === "channel" && (channel.myRole === "owner" || isAdmin);
  const canAdd = channel.kind === "channel" && channel.joined && !channel.archived;

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={`${t("comms.messages.members")} · ${channel.kind === "channel" ? `#${channel.name}` : channel.name}`} closeLabel={t("comms.messages.cancel")} wide>
      <div className="flex flex-col gap-4">
        {members === null ? (
          <Loader2 className="size-4 animate-spin text-muted" aria-hidden />
        ) : (
          <ul className="divide-y divide-line rounded-md shadow-hairline">
            {members.map((m) => (
              <li key={m.key} className="flex items-center gap-3 px-3 py-2">
                {m.kind === "agent" ? <AgentAvatar name={m.label} size="sm" /> : <PersonTile name={m.label} size={24} />}
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                  {m.label} {m.key === me ? <span className="font-normal text-muted">{t("comms.messages.you")}</span> : null}
                </span>
                {m.kind === "agent" ? (
                  <Chip>{t("comms.messages.agentBadge")}</Chip>
                ) : (
                  <span className="flex items-center gap-1.5 text-xs text-muted">
                    <PresenceDot status={presence[m.userId ?? ""]?.status} />
                    {presenceText(t, presence[m.userId ?? ""], (d) => format.relative(d))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {canAdd ? (
          <div className="flex flex-col gap-2">
            <span className={labelCls}>{t("comms.messages.addMembers")}</span>
            <PeoplePicker people={people} value={adding} onChange={setAdding} exclude={(members ?? []).map((m) => m.key)} />
            <div>
              <button type="button" onClick={() => void add()} disabled={!adding.length} className={aosButton({ variant: "primary", size: "sm" })}>
                <UserPlus className="size-4" aria-hidden />
                {t("comms.messages.add")}
              </button>
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {channel.kind === "channel" && channel.joined ? (
            <button type="button" onClick={() => void leave()} className={aosButton({ variant: "secondary", size: "sm" })}>
              <LogOut className="size-4" aria-hidden />
              {t("comms.messages.leave")}
            </button>
          ) : null}
          {canManage ? (
            <button type="button" onClick={() => void archive(!channel.archived)} className={aosButton({ variant: "secondary", size: "sm" })}>
              {channel.archived ? <ArchiveRestore className="size-4" aria-hidden /> : <Archive className="size-4" aria-hidden />}
              {channel.archived ? t("comms.messages.unarchive") : t("comms.messages.archive")}
            </button>
          ) : null}
        </div>
        <ErrorLine message={error} />
      </div>
    </Modal>
  );
}
