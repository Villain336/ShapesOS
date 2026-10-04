"use client";

// Marketr — chat state provider. Mounted once in the dashboard layout so the
// thread list can live in the single AppSidebar (as a contextual section on
// the assistant page) while the transcript + composer live in the page.
// Owns: project session, AI/Team tab, threads, active thread, messages.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ChatToolCall } from "@/lib/chat/agent";
import { confirmAction } from "@/lib/ui/feedback";

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

export type ChatTab = "ai" | "team";

/** Phase 5: the open thread's task profile (server-computed). */
export interface ThreadTask {
  agentKey: string;
  /** Effective tool groups (lib/agents/grants.ts). */
  allowedTools: string[];
  /** The run working right now (Stop targets it), if any. */
  liveRunId: string | null;
}

export interface ChatSession {
  projectId: string;
  projectDomain: string;
  canEdit: boolean;
  mockMode: boolean;
}

interface ChatContextValue {
  session: ChatSession | null;
  setSession: (s: ChatSession | null) => void;
  tab: ChatTab;
  setTab: (t: ChatTab) => void;
  threads: ChatThread[];
  activeId: string | null;
  messages: ChatMessage[];
  sending: boolean;
  loadingThreads: boolean;
  openThread: (id: string) => Promise<void>;
  newThread: () => Promise<void>;
  deleteThread: (id: string) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
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
  /** Phase 5: stop whatever the open thread's agent is doing. */
  stop: () => Promise<void>;
  stopping: boolean;
  /**
   * Phase 5: let an agent run one kind of action without asking (a per-agent
   * automation rule). Resolves to an error message, or null on success.
   */
  setAutoApprove: (agentKey: string, action: string, on: boolean) => Promise<string | null>;
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
  const [stopping, setStopping] = useState(false);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const sendingRef = useRef(false);
  const sessionRef = useRef<ChatSession | null>(null);
  sessionRef.current = session;
  const pendingRef = useRef<PendingAttachment[]>([]);
  pendingRef.current = pendingAttachments;

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

  // (Re)load threads whenever the project session changes; reset when cleared.
  useEffect(() => {
    setThreads([]);
    setActiveId(null);
    setMessages([]);
    setThreadTask(null);
    setSending(false);
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
          if (!cancelled) setMessages(tData.messages ?? []);
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
            setThreadTask(null);
          }
        }
        return rest;
      });
    },
    [activeId, openThread],
  );

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
      let threadId = threadIdIn;
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
          if (!res.ok) return;
          const data = await res.json();
          threadId = data.thread.id as string;
          setThreads((prev) => [data.thread, ...prev]);
          setActiveId(threadId);
          setThreadTask(toThreadTask(data.thread));
          if (!threadIdIn) setMessages([]);
        }
        const optimistic: ChatMessage = {
          id: `tmp-${Date.now()}`,
          role: "user",
          content: text,
          toolCalls: null,
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, optimistic]);
        setSending(true);
        const res = await fetch(`/api/chat/threads/${threadId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: text,
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setMessages((prev) => [
            ...prev.filter((m) => m.id !== optimistic.id),
            {
              id: `err-${Date.now()}`,
              role: "assistant",
              content: `Something went wrong: ${data.error ?? "unknown error"}`,
              toolCalls: null,
              createdAt: new Date().toISOString(),
            },
          ]);
          return;
        }
        // Attachments were accepted — clear the staged tray.
        if (staged && attachmentIds.length > 0) setPendingAttachments([]);
        // Re-fetch the thread for the authoritative message list (includes tool rows).
        const threadRes = await fetch(`/api/chat/threads/${threadId}`);
        if (threadRes.ok) {
          const tdata = await threadRes.json();
          setMessages(tdata.messages ?? []);
          setThreadTask(toThreadTask(tdata.thread));
        }
        if (data.threadTitle) {
          setThreads((prev) =>
            prev.map((t) => (t.id === threadId ? { ...t, title: data.threadTitle } : t)),
          );
        }
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [],
  );

  const sendMessage = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || sending) return;
      await deliver(activeId, text, pendingRef.current.map((a) => a.id), true);
    },
    [activeId, sending, deliver],
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

  const setAutoApprove = useCallback(async (agentKey: string, action: string, on: boolean) => {
    const res = await fetch("/api/automation/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentKey, action, behavior: on ? "auto" : "ask" }),
    });
    if (res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return data.error ?? "Couldn't save the rule.";
  }, []);

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
        stop,
        stopping,
        setAutoApprove,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

/** Phase 5: read the task profile off a thread payload. */
function toThreadTask(t: unknown): ThreadTask | null {
  if (!t || typeof t !== "object") return null;
  const o = t as { agentKey?: unknown; allowedTools?: unknown; liveRunId?: unknown };
  return {
    agentKey: typeof o.agentKey === "string" ? o.agentKey : "lead",
    allowedTools: Array.isArray(o.allowedTools) ? o.allowedTools.filter((x): x is string => typeof x === "string") : [],
    liveRunId: typeof o.liveRunId === "string" ? o.liveRunId : null,
  };
}
