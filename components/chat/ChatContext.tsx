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
    setSending(false);
    setPendingAttachments([]);
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
        if (!cancelled) setLoadingThreads(false);
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
  }, []);

  const deleteThread = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/chat/threads/${id}`, { method: "DELETE" });
      if (!res.ok) return;
      setThreads((prev) => {
        const rest = prev.filter((t) => t.id !== id);
        if (activeId === id) {
          if (rest.length > 0) void openThread(rest[0]!.id);
          else {
            setActiveId(null);
            setMessages([]);
          }
        }
        return rest;
      });
    },
    [activeId, openThread],
  );

  const sendMessage = useCallback(
    async (raw: string) => {
      const s = sessionRef.current;
      const text = raw.trim();
      if (!text || sending || !s || !s.canEdit) return;
      const attachmentIds = pendingRef.current.map((a) => a.id);
      let threadId = activeId;
      if (!threadId) {
        const res = await fetch("/api/chat/threads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: s.projectId }),
        });
        if (!res.ok) return;
        const data = await res.json();
        threadId = data.thread.id as string;
        setThreads((prev) => [data.thread, ...prev]);
        setActiveId(threadId);
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
      try {
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
        if (attachmentIds.length > 0) setPendingAttachments([]);
        // Re-fetch the thread for the authoritative message list (includes tool rows).
        const threadRes = await fetch(`/api/chat/threads/${threadId}`);
        if (threadRes.ok) {
          const tdata = await threadRes.json();
          setMessages(tdata.messages ?? []);
        }
        if (data.threadTitle) {
          setThreads((prev) =>
            prev.map((t) => (t.id === threadId ? { ...t, title: data.threadTitle } : t)),
          );
        }
      } finally {
        setSending(false);
      }
    },
    [activeId, sending],
  );

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
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}
