"use client";

// ShapesOS — New task (Phase 4d): the kit composer in a dialog.
//
// Opened by the sidebar "New task" pill, the Overview button, the ⌘K
// "New task" action and ⌘N / Ctrl+N (where the browser lets a page have it).
// It hands the task to the lead agent (Strategist) by default, or straight to
// a sub-agent, through the EXISTING task path: an assistant chat thread on
// the workspace's project (lib/aos/composer.ts explains the message). Files
// upload with the attachment API the assistant already uses. Nothing here
// widens what an agent may do: write tools still propose and wait for the
// human's confirmation in the thread.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { TaskComposer, type ComposerFile } from "@/components/aos/Composer";
import { useChat } from "@/components/chat/ChatContext";
import {
  attachmentError,
  COMPOSER_TOOLS,
  composeTaskMessage,
  composerAgents,
  formatBytes,
  isComposerAgentKey,
  pickTaskProject,
  taskPromptError,
  type ComposerAgentKey,
  type ComposerToolKey,
} from "@/lib/aos/composer";
import { OPEN_COMPOSER_EVENT } from "./lib";

const AGENTS = composerAgents();

interface ProjectRow {
  id: string;
  createdAt: string;
}

interface DraftFile extends ComposerFile {
  /** FileAttachment id once uploaded. */
  attachmentId?: string;
  error?: string;
}

/** Open the composer from anywhere (optionally with an agent picked and a prompt typed). */
export function openNewTask(agent?: ComposerAgentKey, prompt?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_COMPOSER_EVENT, { detail: { agent, prompt } }));
}

export function NewTaskDialog() {
  const router = useRouter();
  const { queueTask, setTab, session } = useChat();
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState<ComposerAgentKey>("lead");
  const [prompt, setPrompt] = useState("");
  const [tools, setTools] = useState<ComposerToolKey[]>([]);
  const [files, setFiles] = useState<DraftFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const projectsRef = useRef<Promise<ProjectRow[]> | null>(null);

  const loadProjects = useCallback(async (): Promise<ProjectRow[]> => {
    if (!projectsRef.current) {
      projectsRef.current = (async () => {
        try {
          const res = await fetch("/api/projects", { cache: "no-store" });
          if (!res.ok) return [];
          const data = (await res.json()) as { projects?: Array<{ id: string; createdAt: string }> };
          return (data.projects ?? []).map((p) => ({ id: p.id, createdAt: String(p.createdAt) }));
        } catch {
          return [];
        }
      })();
    }
    const list = await projectsRef.current;
    setProjects(list);
    return list;
  }, []);

  const show = useCallback(
    (picked?: unknown, typed?: unknown) => {
      if (isComposerAgentKey(picked)) setAgent(picked);
      if (typeof typed === "string" && typed.trim()) setPrompt(typed.trim());
      setError(null);
      setOpen(true);
      projectsRef.current = null; // re-read: a project may have been added
      void loadProjects();
    },
    [loadProjects],
  );

  // Event (sidebar pill, Overview button, ⌘K action) + ⌘N / Ctrl+N.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ agent?: unknown; prompt?: unknown }>).detail;
      show(detail?.agent, detail?.prompt);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        show();
      }
    };
    window.addEventListener(OPEN_COMPOSER_EVENT, onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(OPEN_COMPOSER_EVENT, onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, [show]);

  const preferredProject = session?.projectId ?? null;

  async function addFiles(list: File[]) {
    setError(null);
    const all = await loadProjects();
    const project = pickTaskProject(all, preferredProject);
    if (!project) {
      setError("Add a project before attaching files. Tasks run inside a project.");
      return;
    }
    let count = files.length;
    for (const file of list) {
      const why = attachmentError(file, count);
      if (why) {
        setError(why);
        break;
      }
      count += 1;
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setFiles((prev) => [...prev, { id: localId, name: file.name, size: formatBytes(file.size), uploading: true }]);
      void (async () => {
        try {
          const form = new FormData();
          form.append("file", file);
          const res = await fetch(`/api/projects/${project.id}/files`, { method: "POST", body: form });
          const data = (await res.json().catch(() => ({}))) as { file?: { id: string }; error?: string };
          if (!res.ok || !data.file) throw new Error(data.error ?? `Couldn't upload ${file.name}.`);
          setFiles((prev) => prev.map((f) => (f.id === localId ? { ...f, uploading: false, attachmentId: data.file!.id } : f)));
        } catch (e) {
          setFiles((prev) => prev.filter((f) => f.id !== localId));
          setError(e instanceof Error ? e.message : `Couldn't upload ${file.name}.`);
        }
      })();
    }
  }

  async function send() {
    const draft = { agent, prompt, tools };
    const why = taskPromptError(draft);
    if (why) {
      setError(why);
      return;
    }
    if (files.some((f) => f.uploading)) {
      setError("Wait for the files to finish uploading.");
      return;
    }
    setSending(true);
    const all = await loadProjects();
    const project = pickTaskProject(all, preferredProject);
    setSending(false);
    if (!project) {
      setError("Add a project first. Tasks run inside a project.");
      return;
    }
    queueTask({
      projectId: project.id,
      content: composeTaskMessage(draft),
      attachmentIds: files.map((f) => f.attachmentId).filter((x): x is string => !!x),
    });
    setTab("ai");
    setOpen(false);
    setPrompt("");
    setFiles([]);
    setTools([]);
    setAgent("lead");
    setError(null);
    router.push(`/dashboard/assistant?project=${encodeURIComponent(project.id)}`);
  }

  const noProject = projects !== null && projects.length === 0;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-ink/30" />
        <Dialog.Popup
          aria-describedby={undefined}
          className="fixed top-[12%] left-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 outline-none"
        >
          <Dialog.Title className="sr-only">New task</Dialog.Title>
          <TaskComposer
            className="shadow-overlay"
            agents={AGENTS}
            agent={agent}
            onAgentChange={(k) => {
              if (isComposerAgentKey(k)) setAgent(k);
            }}
            hint="Usually takes 3–5 min"
            prompt={prompt}
            onPromptChange={(v) => {
              setPrompt(v);
              if (error) setError(null);
            }}
            helper={noProject ? "Tasks run inside a project. Add one under SEO projects first." : undefined}
            error={error}
            files={files}
            onAddFiles={(list) => void addFiles(list)}
            onRemoveFile={(id) => setFiles((prev) => prev.filter((f) => f.id !== id))}
            tools={COMPOSER_TOOLS.map((t) => ({ key: t.key, label: t.label, pressed: tools.includes(t.key) }))}
            onToggleTool={(k) =>
              setTools((prev) => (prev.includes(k as ComposerToolKey) ? prev.filter((x) => x !== k) : [...prev, k as ComposerToolKey]))
            }
            onSend={() => void send()}
            sending={sending}
            autoFocus
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
