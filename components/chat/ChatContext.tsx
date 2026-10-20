"use client";

// Marketr — chat state provider. Mounted once in the dashboard layout so the
// thread list can live in the single AppSidebar (as a contextual section on
// the assistant page) while the transcript + composer live in the page.
// Owns: project session, AI/Team tab, threads, active thread, messages.
//
// Phase 22 (chat): the transcript is a BLOCK LIST (lib/chat/blocks.ts) —
// the persisted rows map to blocks, and a turn in flight folds every AG-UI
// frame into the same model (tool calls with their results inline, held
// calls as an approval block, generative UI, sub-agent plans). Decisions on
// held calls post to POST /api/chat/threads/[id]/decisions and the turn
// continues in that stream; the thread's mode (ask / plan / auto), the panel
// rail and the composer's mentions live here too.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatToolCall } from "@/lib/chat/agent";
import { confirmAction } from "@/lib/ui/feedback";
import { emptyStreamingTurn, foldAguiEvent, liveStatusLine, optimisticSend, streamChatFrames, type AguiFrame, type StreamingTurn } from "./agui-stream";
import { blocksFromThread, emptyBlockFold, foldBlockFrame, pendingApproval, type BlockFold, type ChatBlock } from "@/lib/chat/blocks";
import type { ChatDecisionInput } from "./blocks/ApprovalBlock";

export interface ChatThread {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: string;
  content: string;
  toolCalls: ChatToolCall[] | null;
  createdAt: string;
}

/** A file already uploaded/referenced for the project, staged to ride along
 * with the next sent message (milestone 21, part D2). */
export interface PendingAttachment {
  id: string;
  filename: string;
}

/** Phase 22 (chat): a record / file / person / agent the composer mentions with @ (a context chip). */
export interface ChatMention {
  kind: string;
  id: string;
  title: string;
  href: string;
}

export type ChatTab = "ai" | "team";

/** Phase 22 (chat): how a thread's agent treats actions that change something. */
export type ChatMode = "ask" | "plan" | "auto";

/** Phase 5: the open thread's task profile (server-computed). */
export interface ThreadTask {
  agentKey: string;
  /** Effective tool groups (lib/agents/grants.ts). */
  allowedTools: string[];
  /** The run working right now (Stop targets it), if any. */
  liveRunId: string | null;
  /** Phase 22: the thread's mode and today's model spend in this workspace (micro-USD). */
  mode: ChatMode;
  spendTodayMicroUsd: number;
}

export interface ChatSession {
  projectId: string;
  projectDomain: string;
  canEdit: boolean;
  mockMode: boolean;
}

/** Phase 22 (chat): the panel rail's state (mirrored in the URL by the page). */
export interface PanelState {
  open: boolean;
  tab: "artifacts" | "window" | "run";
  /** The artifact open in the Artifacts tab. */
  artifactId: string | null;
  /** The /dashboard page open in the Window tab (sanitised). */
  paneHref: string | null;
}

interface ChatContextValue {
  session: ChatSession | null;
  setSession: (s: ChatSession | null) => void;
  tab: ChatTab;
  setTab: (t: ChatTab) => void;
  threads: ChatThread[];
  activeId: string | null;
  messages: ChatMessage[];
  /** Phase 22: the transcript — persisted blocks plus the turn in flight. */
  blocks: ChatBlock[];
  sending: boolean;
  loadingThreads: boolean;
  openThread: (id: string) => Promise<void>;
  newThread: () => Promise<void>;
  deleteThread: (id: string) => Promise<void>;
  sendMessage: (text: string, opts?: { mentions?: ChatMention[] }) => Promise<void>;
  /** Files staged to attach to the next sent message. */
  pendingAttachments: PendingAttachment[];
  addPendingAttachment: (a: PendingAttachment) => void;
  removePendingAttachment: (id: string) => void;
  clearPendingAttachments: () => void;
  /**
   * Phase 4d: queue a task from the New task composer. The assistant page
   * sends it as the first message of a new thread once `projectId` is open.
   */
  queueTask: (task: QueuedTask) => void;
  /** Phase 5: the open thread's agent + tool grant. */
  threadTask: ThreadTask | null;
  /**
   * Phase 17: the turn in flight — set the moment a message is sent (before
   * any network wait) and folded from the AG-UI frames as they arrive; the
   * status line (liveStatus) reads it. Null when nothing is in flight.
   */
  liveTurn: StreamingTurn | null;
  liveStatus: { label: string; live: boolean } | null;
  /** Phase 5: stop whatever the open thread's agent is doing. */
  stop: () => Promise<void>;
  stopping: boolean;
  /**
   * Phase 5: let an agent run one kind of action without asking (a per-agent
   * automation rule). Resolves to an error message, or null on success.
   */
  setAutoApprove: (agentKey: string, action: string, on: boolean) => Promise<string | null>;
  /** Phase 22: decide held calls inline; the turn continues in the same stream. Resolves to an error message or null. */
  decide: (decisions: ChatDecisionInput[]) => Promise<string | null>;
  /** Phase 22: y / n / e on the newest pending approval (the composer forwards them). */
  decideFirstPending: (key: "y" | "n" | "e") => boolean;
  /** Phase 22: the thread's mode (ask / plan / auto). */
  setMode: (mode: ChatMode) => Promise<string | null>;
  /** Phase 22: a generated button's action, through the tool gate (a Tier 3 tool yields an approval, never a run). */
  runUiAction: (input: { tool: string; args: Record<string, unknown>; label: string }) => Promise<void>;
  /** Phase 22: form state the person left on a generative block (persisted on the message). */
  saveUiState: (toolUseId: string, state: Record<string, unknown>) => Promise<void>;
  /** Phase 22: the panel rail. */
  panel: PanelState;
  setPanel: (next: Partial<PanelState>) => void;
  /** Phase 22: the composer's draft, so a slash command or a chip can set it. */
  draft: string;
  setDraft: (v: string) => void;
  /** Phase 22: the last user message (↑ edits it). */
  lastUserText: string | null;
  /** The rest of a capped tool result (the block's "Load more"). */
  loadMoreResult: (handle: string, offset: number, runId?: string) => Promise<{ text: string; next: number | null }>;
}

/** A composed task waiting for the assistant page to open its project. */
export interface QueuedTask {
  projectId: string;
  content: string;
  attachmentIds: string[];
  /** Phase 5: the agent the task is handed to (default the lead). */
  agentKey?: string;
  /** Phase 5: tool groups to limit the task to (empty = agent defaults). */
  tools?: string[];
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used inside <ChatProvider>");
  return ctx;
}

/** Phase 14: the chat context when there is one (cards also render outside the chat). */
export function useOptionalChat(): ChatContextValue | null {
  return useContext(ChatContext);
}

/**
 * Phase 5 / 14: save a "do this without asking" rule (PUT /api/automation/settings).
 * Returns null on success, else the server's message. setAutoApprove uses it;
 * so do approval cards rendered outside the chat.
 */
export async function putAutoApproveRule(agentKey: string, action: string, on: boolean): Promise<string | null> {
  const res = await fetch("/api/automation/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentKey, action, behavior: on ? "auto" : "ask" }),
  });
  if (res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? "Couldn't save the rule.";
}

/** Phase 22: the mentions line appended to a sent message (the server validates the hrefs). */
export function mentionsSuffix(mentions: readonly ChatMention[]): string {
  if (!mentions.length) return "";
  return `\n\nMentioned:\n${mentions.map((m) => `- ${m.kind}: ${m.title} (${m.href})`).join("\n")}`;
}

const DEFAULT_PANEL: PanelState = { open: false, tab: "artifacts", artifactId: null, paneHref: null };

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [session, setSessionState] = useState<ChatSession | null>(null);
  const [tab, setTab] = useState<ChatTab>("ai");
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  // Phase 4d: a task handed off from the New task composer, sent as the first
  // message of a fresh thread once the assistant has loaded that project.
  const [queuedTask, setQueuedTask] = useState<QueuedTask | null>(null);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [threadTask, setThreadTask] = useState<ThreadTask | null>(null);
  const [liveTurn, setLiveTurn] = useState<StreamingTurn | null>(null);
  const [liveFold, setLiveFold] = useState<BlockFold | null>(null);
  const [stopping, setStopping] = useState(false);
  const [panel, setPanelState] = useState<PanelState>(DEFAULT_PANEL);
  const [draft, setDraft] = useState("");
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const sendingRef = useRef(false);
  const sessionRef = useRef<ChatSession | null>(null);
  sessionRef.current = session;
  const pendingRef = useRef<PendingAttachment[]>([]);
  pendingRef.current = pendingAttachments;
  const blocksRef = useRef<ChatBlock[]>([]);

  const setSession = useCallback((s: ChatSession | null) => {
    setSessionState(s);
  }, []);

  const addPendingAttachment = useCallback((a: PendingAttachment) => {
    setPendingAttachments((prev) =>
      prev.some((p) => p.id === a.id) ? prev : [...prev, a],
    );
  }, []);

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const clearPendingAttachments = useCallback(() => {
    setPendingAttachments([]);
  }, []);

  const setPanel = useCallback((next: Partial<PanelState>) => {
    setPanelState((prev) => ({ ...prev, ...next }));
  }, []);

  // (Re)load threads whenever the project session changes; reset when cleared.
  useEffect(() => {
    setThreads([]);
    setActiveId(null);
    setMessages([]);
    setThreadTask(null);
    setSending(false);
    setLiveFold(null);
    setPendingAttachments([]);
    setLoadedProjectId(null);
    if (!session) {
      setLoadingThreads(false);
      return;
    }
    let cancelled = false;
    setLoadingThreads(true);
    (async () => {
      try {
        const res = await fetch(`/api/chat/threads?projectId=${session.projectId}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const list = (data.threads ?? []) as ChatThread[];
        if (cancelled) return;
        setThreads(list);
        if (list.length > 0) {
          const first = list[0]!;
          setActiveId(first.id);
          const tRes = await fetch(`/api/chat/threads/${first.id}`);
          if (!tRes.ok || cancelled) return;
          const tData = await tRes.json();
          if (!cancelled) {
            setMessages(tData.messages ?? []);
            setThreadTask(toThreadTask(tData.thread));
          }
        }
      } finally {
        if (!cancelled) {
          setLoadingThreads(false);
          setLoadedProjectId(session.projectId);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const openThread = useCallback(async (id: string) => {
    setActiveId(id);
    setLiveFold(null);
    const res = await fetch(`/api/chat/threads/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    setMessages(data.messages ?? []);
    setThreadTask(toThreadTask(data.thread));
  }, []);

  const newThread = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    const res = await fetch("/api/chat/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: s.projectId }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const t = data.thread as ChatThread;
    setThreads((prev) => [t, ...prev]);
    setActiveId(t.id);
    setMessages([]);
    setLiveFold(null);
    setThreadTask(toThreadTask(data.thread));
  }, []);

  const deleteThread = useCallback(
    async (id: string) => {
      const ok = await confirmAction({
        title: "Delete this chat?",
        description: "Its messages are deleted and can't be recovered.",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
      const res = await fetch(`/api/chat/threads/${id}`, { method: "DELETE" });
      if (!res.ok) return;
      setThreads((prev) => {
        const rest = prev.filter((t) => t.id !== id);
        if (activeId === id) {
          if (rest.length > 0) void openThread(rest[0]!.id);
          else {
            setActiveId(null);
            setMessages([]);
            setLiveFold(null);
            setThreadTask(null);
          }
        }
        return rest;
      });
    },
    [activeId, openThread],
  );

  /** Re-read the thread after a turn: the authoritative rows (tool rows, proposals, the final text). */
  const refreshThread = useCallback(async (threadId: string) => {
    const threadRes = await fetch(`/api/chat/threads/${threadId}`);
    if (!threadRes.ok) return false;
    const tdata = await threadRes.json();
    setMessages(tdata.messages ?? []);
    setThreadTask(toThreadTask(tdata.thread));
    const title = tdata.thread?.title as string | undefined;
    if (title) setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, title } : t)));
    return true;
  }, []);

  /**
   * Consume one AG-UI stream into the live view (the status line's turn and
   * the block fold). Shared by a sent message and a decision.
   */
  const consume = useCallback(async (body: ReadableStream<Uint8Array>, fold: BlockFold): Promise<{ live: StreamingTurn; fold: BlockFold }> => {
    let live = emptyStreamingTurn();
    let current = fold;
    const frames = streamChatFrames(body, {
      fetchResume: (url, lastEventId) =>
        fetch(url, { headers: lastEventId ? { "Last-Event-ID": lastEventId } : {}, cache: "no-store" }),
    });
    for await (const frame of frames) {
      const next = foldAguiEvent(live, frame);
      const nextFold = foldBlockFrame(current, frame as AguiFrame);
      if (next !== live || nextFold !== current) {
        live = next;
        current = nextFold;
        setLiveTurn(live);
        setLiveFold(current);
      }
    }
    return { live, fold: current };
  }, []);

  /**
   * Send `text` into `threadId` (null = a fresh thread on the current
   * project). `staged` = the attachments came from the staged tray and are
   * cleared once the server accepts them.
   */
  const deliver = useCallback(
    async (
      threadIdIn: string | null,
      text: string,
      attachmentIds: string[],
      staged: boolean,
      task?: { agentKey?: string; tools?: string[] },
    ) => {
      const s = sessionRef.current;
      if (!text || sendingRef.current || !s || !s.canEdit) return;
      sendingRef.current = true;
      // Phase 17: first visible feedback at once — the user's turn and the
      // "Sending" state show before any request leaves (no network wait);
      // the first frame of the stream reconciles them into "Working".
      const optimistic = { id: `tmp-${Date.now()}` };
      setMessages((prev) => optimisticSend(prev, text, { id: optimistic.id }).messages);
      setSending(true);
      setLiveTurn(emptyStreamingTurn());
      setLiveFold(emptyBlockFold());
      let threadId = threadIdIn;
      const failed = (message: string) => {
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== optimistic.id),
          { id: `err-${Date.now()}`, role: "assistant", content: `Something went wrong: ${message}`, toolCalls: null, createdAt: new Date().toISOString() },
        ]);
      };
      try {
        if (!threadId) {
          const res = await fetch("/api/chat/threads", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Phase 5: the server computes and enforces the task's grant.
            body: JSON.stringify({
              projectId: s.projectId,
              ...(task?.agentKey ? { agentKey: task.agentKey } : {}),
              ...(task?.tools?.length ? { tools: task.tools } : {}),
            }),
          });
          if (!res.ok) {
            failed("could not start a chat");
            return;
          }
          const data = await res.json();
          threadId = data.thread.id as string;
          setThreads((prev) => [data.thread, ...prev]);
          setActiveId(threadId);
          setThreadTask(toThreadTask(data.thread));
          // A fresh thread holds only the optimistic turn.
          setMessages((prev) => prev.filter((m) => m.id === optimistic.id));
        }
        // Phase 8: the turn streams (AG-UI SSE): the assistant's text shows
        // while it arrives; the thread is re-read at the end for the
        // authoritative rows (tool rows, proposals, the final text).
        const res = await fetch("/api/agents/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId,
            content: text,
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          }),
        });
        if (!res.ok || !res.body) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          failed(data.error ?? "unknown error");
          return;
        }
        // Attachments were accepted — clear the staged tray.
        if (staged && attachmentIds.length > 0) setPendingAttachments([]);
        const { live } = await consume(res.body, emptyBlockFold());
        // Re-fetch the thread for the authoritative message list (includes tool rows).
        const ok = await refreshThread(threadId);
        if (!ok && live.error) {
          setMessages((prev) => [
            ...prev,
            { id: `err-${Date.now()}`, role: "assistant", content: `Something went wrong: ${live.error}`, toolCalls: null, createdAt: new Date().toISOString() },
          ]);
        }
      } finally {
        sendingRef.current = false;
        setSending(false);
        setLiveTurn(null);
        setLiveFold(null);
      }
    },
    [consume, refreshThread],
  );

  const sendMessage = useCallback(
    async (raw: string, opts: { mentions?: ChatMention[] } = {}) => {
      const text = raw.trim();
      if (!text || sending) return;
      await deliver(activeId, text + mentionsSuffix(opts.mentions ?? []), pendingRef.current.map((a) => a.id), true);
    },
    [activeId, sending, deliver],
  );

  /**
   * Phase 22: decide held calls from the approval block. The decided calls
   * run (or are recorded as denied) and the turn continues in THIS stream,
   * so the result shows under the call without a reload.
   */
  const decide = useCallback(
    async (decisions: ChatDecisionInput[]): Promise<string | null> => {
      const threadId = activeIdRef.current;
      const s = sessionRef.current;
      if (!threadId || !s?.canEdit || decisions.length === 0) return "No chat is open.";
      if (sendingRef.current) return "Wait for the current turn to finish.";
      // "Always allow" = the Phase 14 rule, through its own (Tier 3-refusing) route.
      for (const d of decisions) {
        if (d.alwaysAllow && d.decision === "approve") {
          const item = blocksRef.current.flatMap((b) => (b.kind === "approval" ? b.items : [])).find((it) => (it.toolUseId ?? it.toolCallId) === (d.toolUseId ?? d.toolCallId));
          if (item?.autoAction && !item.needsClick) {
            const err = await putAutoApproveRule(item.agentKey ?? "lead", item.autoAction, true);
            if (err) return err;
          }
        }
      }
      sendingRef.current = true;
      setSending(true);
      setLiveTurn(emptyStreamingTurn());
      // The fold starts from the thread's blocks so the held call's block is
      // the one the continuation fills.
      const start: BlockFold = { ...emptyBlockFold(), blocks: [] };
      setLiveFold(start);
      try {
        const res = await fetch(`/api/chat/threads/${threadId}/decisions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decisions: decisions.map((d) => ({ toolUseId: d.toolUseId, tool: d.tool, decision: d.decision, ...(d.args ? { args: d.args } : {}) })) }),
        });
        if (!res.ok || !res.body) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          return data.error ?? `Couldn't send the decision (${res.status}).`;
        }
        await consume(res.body, start);
        await refreshThread(threadId);
        return null;
      } finally {
        sendingRef.current = false;
        setSending(false);
        setLiveTurn(null);
        setLiveFold(null);
      }
    },
    [consume, refreshThread],
  );

  const queueTask = useCallback((task: QueuedTask) => {
    setQueuedTask(task);
  }, []);

  // Phase 4d: the composer's task goes out once its project's threads have
  // loaded (so the load can't overwrite the new thread). Viewers can't post;
  // their queued task is dropped and the page stays read-only as before.
  useEffect(() => {
    const q = queuedTask;
    if (!q || !session || session.projectId !== q.projectId || loadedProjectId !== q.projectId) return;
    setQueuedTask(null);
    if (!session.canEdit) return;
    void deliver(null, q.content.trim(), q.attachmentIds, false, { agentKey: q.agentKey, tools: q.tools });
  }, [queuedTask, session, loadedProjectId, deliver]);

  // Phase 5: Stop. The message request is still open while the agent works,
  // so this is a separate request; the agent loop sees the stop before its
  // next model or tool call (and an in-flight model call is aborted).
  const stop = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return;
    setStopping(true);
    try {
      await fetch(`/api/chat/threads/${id}/stop`, { method: "POST" });
      const threadRes = await fetch(`/api/chat/threads/${id}`);
      if (threadRes.ok) {
        const tdata = await threadRes.json();
        // Don't clobber the optimistic turn while the request is in flight.
        if (!sendingRef.current) setMessages(tdata.messages ?? []);
        setThreadTask(toThreadTask(tdata.thread));
      }
    } finally {
      setStopping(false);
    }
  }, []);

  const setAutoApprove = useCallback(
    (agentKey: string, action: string, on: boolean) => putAutoApproveRule(agentKey, action, on),
    [],
  );

  // Phase 22: the thread's mode (PATCH /api/chat/threads/[id]).
  const setMode = useCallback(async (mode: ChatMode): Promise<string | null> => {
    const id = activeIdRef.current;
    if (!id) {
      setThreadTask((t) => (t ? { ...t, mode } : t));
      return null;
    }
    const res = await fetch(`/api/chat/threads/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return data.error ?? "Couldn't change the mode.";
    }
    const data = await res.json();
    setThreadTask(toThreadTask(data.thread));
    return null;
  }, []);

  // Phase 22 (genui): a generated button is a normal tool call through the
  // gate — sent as a turn whose content names the action; the server runs it
  // through executeTool (tiers, approvals, audit). A Tier 3 tool yields an
  // approval block, never a run.
  const runUiAction = useCallback(
    async (input: { tool: string; args: Record<string, unknown>; label: string }) => {
      const threadId = activeIdRef.current;
      const s = sessionRef.current;
      if (!threadId || !s?.canEdit || sendingRef.current) return;
      sendingRef.current = true;
      setSending(true);
      setLiveTurn(emptyStreamingTurn());
      setLiveFold(emptyBlockFold());
      try {
        const res = await fetch(`/api/chat/threads/${threadId}/actions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool: input.tool, args: input.args, label: input.label }),
        });
        if (!res.ok || !res.body) return;
        await consume(res.body, emptyBlockFold());
        await refreshThread(threadId);
      } finally {
        sendingRef.current = false;
        setSending(false);
        setLiveTurn(null);
        setLiveFold(null);
      }
    },
    [consume, refreshThread],
  );

  const saveUiState = useCallback(async (toolUseId: string, state: Record<string, unknown>) => {
    const threadId = activeIdRef.current;
    if (!threadId) return;
    await fetch(`/api/chat/threads/${threadId}/ui-state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolUseId, state }),
    }).catch(() => undefined);
  }, []);

  const loadMoreResult = useCallback(async (handle: string, offset: number, runId?: string) => {
    const threadId = activeIdRef.current;
    const owner = blocksRef.current.find((b): b is Extract<ChatBlock, { kind: "tool" }> => b.kind === "tool" && b.toolUseId === handle);
    const run = runId ?? owner?.runId;
    if (!threadId || !run) throw new Error("no run");
    const res = await fetch(`/api/chat/threads/${threadId}/results/${encodeURIComponent(handle)}?runId=${encodeURIComponent(run)}&offset=${offset}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`load more ${res.status}`);
    const data = (await res.json()) as { text: string; next: number | null };
    return { text: data.text, next: data.next };
  }, []);

  // Phase 22: the transcript = the persisted rows (minus the in-flight copies)
  // plus the live fold of the turn in progress.
  const blocks = useMemo(() => {
    const persisted = blocksFromThread(messages.filter((m) => !m.id.startsWith("live-")));
    if (!liveFold) return persisted;
    // The decision's continuation fills the held call's block: merge by tool_use id.
    const liveIds = new Set(liveFold.blocks.map((b) => ("toolUseId" in b ? b.toolUseId : null)).filter((x): x is string => !!x));
    const merged = persisted.map((b) => {
      if ((b.kind === "tool" || b.kind === "genui") && b.toolUseId && liveIds.has(b.toolUseId)) {
        const live = liveFold.blocks.find((x) => (x.kind === "tool" || x.kind === "genui") && x.toolUseId === b.toolUseId);
        if (!live) return b;
        // The continuation re-announces the call without its arguments: keep the persisted ones.
        if (live.kind === "tool" && b.kind === "tool") {
          return {
            ...b,
            status: live.status,
            resultText: live.resultText ?? b.resultText,
            ui: live.ui ?? b.ui,
            payload: live.payload ?? b.payload,
            ...(live.confirmed ? { confirmed: true } : {}),
            ...(live.autoApproved ? { autoApproved: live.autoApproved } : {}),
          };
        }
        return { ...live, id: b.id, messageId: b.messageId };
      }
      if (b.kind === "approval") {
        const items = b.items.map((it) => {
          const live = liveFold.blocks.find((x) => x.kind === "approval" && x.items.some((li) => li.toolUseId && li.toolUseId === it.toolUseId));
          const li = live?.kind === "approval" ? live.items.find((x) => x.toolUseId === it.toolUseId) : undefined;
          if (li && li.decision !== "pending") return { ...it, decision: li.decision };
          // The decision's continuation re-runs the held call: its outcome settles the item at once.
          const ran = it.toolUseId ? liveFold.blocks.find((x) => x.kind === "tool" && x.toolUseId === it.toolUseId) : undefined;
          if (ran?.kind === "tool" && it.decision === "pending") {
            if (ran.status === "cancelled") return { ...it, decision: "denied" as const };
            if (ran.status !== "running" && ran.status !== "pending_confirmation") return { ...it, decision: "approved" as const };
          }
          return it;
        });
        return { ...b, items };
      }
      return b;
    });
    const rest = liveFold.blocks.filter((b) => !(("toolUseId" in b && b.toolUseId && persisted.some((p) => "toolUseId" in p && p.toolUseId === b.toolUseId)) || (b.kind === "approval" && b.items.every((it) => it.toolUseId && persisted.some((p) => p.kind === "approval" && p.items.some((pi) => pi.toolUseId === it.toolUseId))))));
    return [...merged, ...rest];
  }, [messages, liveFold]);
  blocksRef.current = blocks;

  const decideFirstPending = useCallback(
    (key: "y" | "n" | "e"): boolean => {
      const block = pendingApproval(blocksRef.current);
      const item = block?.items.find((it) => it.decision === "pending");
      if (!block || !item) return false;
      if (key === "e") {
        const el = document.querySelector<HTMLButtonElement>(`[data-approval-item="${CSS.escape(item.toolUseId ?? item.toolCallId)}"] [data-decision="edit"]`);
        el?.click();
        return !!el;
      }
      void decide([{ toolUseId: item.toolUseId, toolCallId: item.toolCallId, tool: item.tool, decision: key === "y" ? "approve" : "deny" }]);
      return true;
    },
    [decide],
  );

  const lastUserText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === "user" && !(m.toolCalls ?? []).some((c) => c.tool === "chat_decision")) return m.content;
    }
    return null;
  }, [messages]);

  return (
    <ChatContext.Provider
      value={{
        session,
        setSession,
        tab,
        setTab,
        threads,
        activeId,
        messages,
        blocks,
        sending,
        loadingThreads,
        openThread,
        newThread,
        deleteThread,
        sendMessage,
        pendingAttachments,
        addPendingAttachment,
        removePendingAttachment,
        clearPendingAttachments,
        queueTask,
        threadTask,
        liveTurn,
        liveStatus: liveStatusLine(liveTurn, sending),
        stop,
        stopping,
        setAutoApprove,
        decide,
        decideFirstPending,
        setMode,
        runUiAction,
        saveUiState,
        panel,
        setPanel,
        draft,
        setDraft,
        lastUserText,
        loadMoreResult,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

/** Phase 5: read the task profile off a thread payload. */
function toThreadTask(t: unknown): ThreadTask | null {
  if (!t || typeof t !== "object") return null;
  const o = t as { agentKey?: unknown; allowedTools?: unknown; liveRunId?: unknown; mode?: unknown; spendTodayMicroUsd?: unknown };
  return {
    agentKey: typeof o.agentKey === "string" ? o.agentKey : "lead",
    allowedTools: Array.isArray(o.allowedTools) ? o.allowedTools.filter((x): x is string => typeof x === "string") : [],
    liveRunId: typeof o.liveRunId === "string" ? o.liveRunId : null,
    mode: o.mode === "plan" || o.mode === "auto" ? o.mode : "ask",
    spendTodayMicroUsd: typeof o.spendTodayMicroUsd === "number" ? o.spendTodayMicroUsd : 0,
  };
}
