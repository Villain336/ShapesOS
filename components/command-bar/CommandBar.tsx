// Marketr — Phase 9 M3: command-bar sidekick (⌘K).
//
// Hand-rolled cmdk-STYLE palette (no cmdk dependency). 0ms open/close — no
// animations, instant mount/unmount. Full keyboard contract:
// ⌘K/Ctrl+K toggles · type immediately · ↑/↓ wrap · Enter runs · Esc closes ·
// Backspace (empty query) pops nested pages · focus returns on close.
//
// Sections: Go (jump), Do (missions / playbooks), Ask (free-form question to
// the orchestrator, answered inline with citations). Every invocation is
// audited via POST /api/command/audit → logCommand() (audit.ts): templated
// actions log {templateId, promptHash}; free-form asks log the FULL prompt.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  Box,
  Briefcase,
  CheckCircle2,
  Command,
  CornerDownLeft,
  File as FileIcon,
  FileText,
  FolderKanban,
  Globe,
  Database,
  Loader2,
  Package,
  PenLine,
  ReceiptText,
  Rocket,
  Scale,
  Search,
  Sparkles,
  Target,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { RECORD_KIND_LABELS } from "@/lib/search/kinds";
import { cn } from "@/lib/utils";
import FeedbackButtons from "@/components/agents/FeedbackButtons";
import { navCommands } from "@/lib/nav/config";
import {
  AsyncBudgetExceeded,
  buildAskAuditPayload,
  buildDoAuditPayload,
  buildGoAuditPayload,
  buildTemplateAuditPayload,
  capIdleSection,
  groupBySection,
  loadFrecency,
  MISSION_TEMPLATES,
  mergeBySection,
  OPEN_COMMAND_BAR_EVENT,
  moveSelection,
  rankCommands,
  RECORD_SEARCH_DEBOUNCE_MS,
  recordCommandItems,
  recordUse,
  saveFrecency,
  shouldPopOnBackspace,
  shouldSearchRecords,
  type AuditPayload,
  type RecordResult,
  type CommandItem,
  type FrecencyMap,
} from "./lib";

// Budgets from docs/specs/SPEC-PHASE9.md §P9B / research: LLM suggestions hidden if late.
const SUGGESTION_BUDGET_MS = 800;
// Go rows shown before the user types (all destinations are searchable).
const GO_IDLE_LIMIT = 8;

interface PlaybookSummary {
  id: string;
  name: string;
  status?: string;
}

interface AskCitation {
  title: string;
  url: string;
}

interface UICommand extends CommandItem {
  icon: LucideIcon;
}

type Page =
  | { name: "root" }
  | { name: "missions" }
  | { name: "playbooks"; status: "loading" | "unavailable" | "ready" | "error"; items: PlaybookSummary[] }
  | { name: "ask"; query: string; status: "loading" | "slow" | "done" | "error"; answer?: string; citations?: AskCitation[]; error?: string };

// Go = every nav destination (lib/nav/config.ts), so ⌘K and the sidebar
// can't drift. ⌥1–⌥6 keep their original targets (NAV_HOTKEYS).
const GO_ITEMS: UICommand[] = navCommands();
const GO_BY_HOTKEY = new Map(GO_ITEMS.filter((g) => g.hotkey).map((g) => [g.hotkey!, g]));

// Phase 4a: icons for the Records section (by record kind).
const RECORD_ICONS: Record<string, LucideIcon> = {
  lead: Users,
  invoice: ReceiptText,
  doc: FileText,
  file: FileIcon,
  project: Globe,
  ops_project: FolderKanban,
  mission: Target,
  cad_project: Box,
  envelope: PenLine,
  legal_document: Scale,
  client: Briefcase,
  bom_line: Package,
  dataset: Database,
};

const DO_ITEMS: UICommand[] = [
  { id: "do:missions", section: "do", title: "Start a mission from template…", subtitle: "Growth Missions by business type", keywords: "mission goal launch template growth", hotkey: "⌥M", action: "missions-page", icon: Rocket },
  { id: "do:playbooks", section: "do", title: "Run a playbook step…", subtitle: "Agent playbooks", keywords: "playbook run step procedure", hotkey: "⌥P", action: "playbooks-page", icon: BookOpen },
];

function templateItems(): UICommand[] {
  return MISSION_TEMPLATES.map((t) => ({
    id: `template:${t.id}`,
    section: "do" as const,
    title: t.label,
    subtitle: `${t.businessType} · starts a mission`,
    keywords: `${t.businessType} mission ${t.goal}`,
    action: "template" as const,
    templateId: t.id,
    goal: t.goal,
    icon: Rocket,
  }));
}

async function postAudit(payload: AuditPayload): Promise<void> {
  try {
    await fetch("/api/command/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Audit is best-effort from the client; the route itself is append-only.
  }
}

export function CommandBar({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<Page>({ name: "root" });
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [frec, setFrec] = useState<FrecencyMap>({});
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // Phase 4a: workspace records matching the query (server search, debounced).
  const [records, setRecords] = useState<{ query: string; items: UICommand[]; loading: boolean }>({
    query: "",
    items: [],
    loading: false,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const lastFocusedRef = useRef<Element | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const isNested = page.name !== "root";

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
    setNotice(null);
    setPage({ name: "root" });
    setAnnouncement("");
    // Focus returns to the previously focused element (keyboard contract).
    const el = lastFocusedRef.current;
    if (el instanceof HTMLElement) el.focus();
  }, []);

  const toggle = useCallback(() => {
    if (openRef.current) {
      close();
      return;
    }
    lastFocusedRef.current = document.activeElement;
    setFrec(loadFrecency(window.localStorage));
    setPage({ name: "root" });
    setQuery("");
    setActive(0);
    setNotice(null);
    setOpen(true);
    setAnnouncement("Command bar opened.");
    // Focus the input on the next frame — 0ms open, no animation.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [close]);

  // Global ⌘K / Ctrl+K toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
      }
    };
    // The sidebar's search button opens the palette (never toggles it shut).
    const onOpen = () => {
      if (!openRef.current) toggle();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_COMMAND_BAR_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_COMMAND_BAR_EVENT, onOpen);
    };
  }, [toggle]);

  const bumpFrecency = useCallback((id: string) => {
    const now = Date.now();
    setFrec((prev) => {
      const next = recordUse(prev, id, now);
      saveFrecency(window.localStorage, next);
      return next;
    });
  }, []);

  // ---- records (Phase 4a) -------------------------------------------------

  useEffect(() => {
    const q = query.trim();
    if (!open || !shouldSearchRecords(q, page.name === "root")) {
      setRecords((r) => (r.items.length || r.loading ? { query: "", items: [], loading: false } : r));
      return;
    }
    const ctrl = new AbortController();
    setRecords((r) => ({ ...r, loading: true }));
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search/records?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { results?: RecordResult[] };
        const items = recordCommandItems(data.results ?? [], RECORD_KIND_LABELS).map((item) => ({
          ...item,
          icon: RECORD_ICONS[item.id.split(":")[1] ?? ""] ?? Search,
        }));
        setRecords({ query: q, items, loading: false });
      } catch {
        if (!ctrl.signal.aborted) setRecords({ query: q, items: [], loading: false });
      }
    }, RECORD_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [open, query, page.name]);

  // ---- items ------------------------------------------------------------

  const items: UICommand[] = useMemo(() => {
    const q = query.trim();
    let base: UICommand[];
    if (page.name === "root") {
      base = [...GO_ITEMS, ...DO_ITEMS];
    } else if (page.name === "missions") {
      base = templateItems();
    } else if (page.name === "playbooks") {
      base =
        page.status === "ready"
          ? page.items.map((p) => ({
              id: `playbook:${p.id}`,
              section: "do" as const,
              title: p.name,
              subtitle: p.status ? `Status: ${p.status}` : "Run this playbook step",
              keywords: "playbook run step",
              action: "playbook-run" as const,
              playbookId: p.id,
              icon: BookOpen,
            }))
          : [];
    } else {
      base = []; // ask result page shows the answer panel, not a list
    }
    // With no query the Go section shows the most-used destinations only;
    // typing searches all of them.
    let ranked = capIdleSection(rankCommands(base, q, frec, Date.now()), q, "go", GO_IDLE_LIMIT);
    // Records only for the query they were fetched for (no stale flashes).
    if (page.name === "root" && q && records.query === q && records.items.length > 0) {
      ranked = mergeBySection(ranked, records.items);
    }
    if (page.name === "root" && q) {
      ranked.push({
        id: `ask:${q}`,
        section: "ask",
        title: `Ask: “${q}”`,
        subtitle: "Ask the Chief Strategy Agent",
        keywords: "ask question ai strategist",
        action: "ask",
        icon: Sparkles,
      });
    }
    return ranked;
  }, [page, query, frec, records]);

  const groups = useMemo(() => groupBySection(items), [items]);

  // Keep the active index in range and announce result counts.
  useEffect(() => {
    setActive((a) => (a >= items.length ? 0 : a));
  }, [items.length]);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      setAnnouncement(
        page.name === "ask"
          ? "Answer from the strategist."
          : `${items.length} result${items.length === 1 ? "" : "s"}.`,
      );
    }, 150);
    return () => clearTimeout(t);
  }, [open, items.length, page.name, query]);

  // ---- actions ----------------------------------------------------------

  const runGo = useCallback(
    (item: UICommand) => {
      if (!item.href) return;
      bumpFrecency(item.id);
      void postAudit(buildGoAuditPayload(item.href));
      close();
      router.push(item.href);
    },
    [bumpFrecency, close, router],
  );

  const runTemplate = useCallback(
    async (item: UICommand) => {
      if (!item.templateId || !item.goal) return;
      bumpFrecency(item.id);
      setNotice(null);
      let summary: string | undefined;
      try {
        const res = await fetch("/api/missions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ templateId: item.templateId, goal: item.goal, name: item.title }),
        });
        if (res.status === 404) {
          summary = "Missions are not yet available (Phase 9 M4).";
          setNotice({ kind: "error", text: summary });
        } else if (!res.ok) {
          summary = `Could not start the mission (HTTP ${res.status}).`;
          setNotice({ kind: "error", text: summary });
        } else {
          const data = (await res.json().catch(() => ({}))) as { mission?: { name?: string } };
          summary = data?.mission?.name ? `Mission started: ${data.mission.name}.` : "Mission started.";
          setNotice({ kind: "ok", text: summary });
        }
      } catch {
        summary = "Could not reach the server.";
        setNotice({ kind: "error", text: summary });
      }
      // Audit: templated action → { templateId, promptHash } (never full prompt).
      void postAudit(buildTemplateAuditPayload(item.templateId, item.goal, summary));
    },
    [bumpFrecency],
  );

  const runPlaybook = useCallback(
    async (item: UICommand) => {
      if (!item.playbookId) return;
      bumpFrecency(item.id);
      setNotice(null);
      let summary: string | undefined;
      try {
        const res = await fetch(`/api/playbooks/${encodeURIComponent(item.playbookId)}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: { goal: query.trim() || "Run from command bar" } }),
        });
        if (res.status === 404) {
          summary = "Playbooks are not yet available (Phase 9 M5).";
          setNotice({ kind: "error", text: summary });
        } else if (!res.ok) {
          summary = `Playbook step failed (HTTP ${res.status}).`;
          setNotice({ kind: "error", text: summary });
        } else {
          summary = `Playbook step ran: ${item.title}.`;
          setNotice({ kind: "ok", text: summary });
        }
      } catch {
        summary = "Could not reach the server.";
        setNotice({ kind: "error", text: summary });
      }
      void postAudit(buildDoAuditPayload("Run playbook step", `${item.playbookId} — ${summary}`));
    },
    [bumpFrecency, query],
  );

  const runAsk = useCallback(
    async (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      bumpFrecency("ask");
      setPage({ name: "ask", query: trimmed, status: "loading" });
      setQuery("");
      setActive(0);
      let slowTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const askPromise = (async () => {
          const res = await fetch("/api/orchestrator/ask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: trimmed }),
          });
          if (res.status === 404) {
            throw new Error("The orchestrator is not yet available (Phase 9 M2).");
          }
          if (!res.ok) throw new Error(`The strategist returned HTTP ${res.status}.`);
          const data = (await res.json()) as { answer?: unknown; citations?: unknown };
          const answerText = typeof data?.answer === "string" ? data.answer : "";
          if (!answerText) {
            throw new Error("The strategist returned an empty answer.");
          }
          const citations = Array.isArray(data.citations)
            ? (data.citations as AskCitation[])
            : [];
          return { answer: answerText, citations };
        })();
        // Budget: the inline answer is hidden if it arrives later than ~800ms
        // — the panel flips to an explicit "still thinking" state instead.
        slowTimer = setTimeout(() => {
          setPage((p) => (p.name === "ask" && p.status === "loading" ? { ...p, status: "slow" } : p));
        }, SUGGESTION_BUDGET_MS);
        const data = await askPromise;
        const summary = data.answer.slice(0, 200);
        setPage({
          name: "ask",
          query: trimmed,
          status: "done",
          answer: data.answer,
          citations: Array.isArray(data.citations) ? data.citations : [],
        });
        // Audit: free-form ask → FULL prompt is the source of truth.
        void postAudit(buildAskAuditPayload(trimmed, summary));
      } catch (err) {
        const message =
          err instanceof AsyncBudgetExceeded
            ? "The strategist took too long to answer."
            : err instanceof Error
              ? err.message
              : "The strategist could not answer.";
        setPage({ name: "ask", query: trimmed, status: "error", error: message });
        void postAudit(buildAskAuditPayload(trimmed, `error: ${message}`));
      } finally {
        if (slowTimer) clearTimeout(slowTimer);
      }
    },
    [bumpFrecency],
  );

  const runItem = useCallback(
    (item: UICommand) => {
      switch (item.action) {
        case "go":
          runGo(item);
          break;
        case "missions-page":
          setPage({ name: "missions" });
          setQuery("");
          setActive(0);
          setNotice(null);
          setAnnouncement("Mission templates.");
          break;
        case "playbooks-page":
          setPage({ name: "playbooks", status: "loading", items: [] });
          setQuery("");
          setActive(0);
          setNotice(null);
          setAnnouncement("Loading playbooks.");
          break;
        case "template":
          void runTemplate(item);
          break;
        case "playbook-run":
          void runPlaybook(item);
          break;
        case "ask":
          void runAsk(query);
          break;
      }
    },
    [runGo, runTemplate, runPlaybook, runAsk, query],
  );

  // Load playbooks defensively when the playbooks page opens (M5 implements).
  useEffect(() => {
    if (!open || page.name !== "playbooks" || page.status !== "loading") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/playbooks");
        if (cancelled) return;
        if (res.status === 404) {
          setPage({ name: "playbooks", status: "unavailable", items: [] });
          setAnnouncement("Playbooks are not yet available.");
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { playbooks?: PlaybookSummary[] };
        if (cancelled) return;
        setPage({ name: "playbooks", status: "ready", items: data.playbooks ?? [] });
        setAnnouncement(`${data.playbooks?.length ?? 0} playbooks.`);
      } catch {
        if (!cancelled) {
          setPage({ name: "playbooks", status: "error", items: [] });
          setAnnouncement("Could not load playbooks.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, page]);

  const popPage = useCallback(() => {
    setPage({ name: "root" });
    setQuery("");
    setActive(0);
    setNotice(null);
    setAnnouncement("Back to command bar.");
    inputRef.current?.focus();
  }, []);

  // ---- palette key handling ---------------------------------------------

  const onPaletteKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => moveSelection(a, 1, items.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => moveSelection(a, -1, items.length));
    } else if (e.key === "Enter") {
      const item = items[active];
      if (item) {
        e.preventDefault();
        runItem(item);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Backspace" && shouldPopOnBackspace(query, isNested)) {
      e.preventDefault();
      popPage();
    } else if (e.altKey && e.key.toLowerCase() === "m") {
      e.preventDefault();
      runItem(DO_ITEMS[0]);
    } else if (e.altKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      runItem(DO_ITEMS[1]);
    } else if (e.altKey && /^[1-9]$/.test(e.key) && GO_BY_HOTKEY.has(`⌥${e.key}`)) {
      e.preventDefault();
      runGo(GO_BY_HOTKEY.get(`⌥${e.key}`)!);
    }
  };

  // ---- render -----------------------------------------------------------

  const activeItem = page.name === "ask" ? undefined : items[active];
  const activeDescendant = activeItem ? `cmdk-option-${activeItem.id}` : undefined;
  const pageTitle =
    page.name === "missions"
      ? "Start a mission"
      : page.name === "playbooks"
        ? "Run a playbook step"
        : page.name === "ask"
          ? "Ask the strategist"
          : "Command bar";

  return (
    <>
      {/* Mobile trigger — no keyboard shortcut exists on phones, so a visible
          trigger is mandatory (research §2). Desktop users get ⌘K. */}
      <button
        type="button"
        onClick={toggle}
        aria-label="Open command bar"
        title="Command bar (Ctrl/⌘K)"
        className="fixed bottom-4 right-4 z-40 rounded-full bg-ink p-3.5 text-white shadow-lg aos-press md:hidden"
      >
        <Command className="h-5 w-5" aria-hidden />
      </button>

      {open && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={pageTitle}>
          <div
            className="absolute inset-0 bg-ink/30"
            onClick={close}
            aria-hidden="true"
          />
          <div
            className="absolute left-1/2 top-[12%] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-paper shadow-overlay"
            onKeyDown={onPaletteKeyDown}
          >
            {/* Input row */}
            <div className="flex items-center gap-2 border-b border-line px-3 focus-within:border-focus">
              {isNested && (
                <button
                  type="button"
                  onClick={popPage}
                  aria-label="Back to command bar"
                  className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden />
                </button>
              )}
              <Search className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                  setNotice(null);
                }}
                placeholder={
                  page.name === "missions"
                    ? "Filter mission templates…"
                    : page.name === "playbooks"
                      ? "Filter playbooks…"
                      : "Type a command, or ask a question…"
                }
                role="combobox"
                aria-expanded="true"
                aria-controls="cmdk-listbox"
                aria-activedescendant={activeDescendant}
                aria-label={pageTitle}
                autoComplete="off"
                spellCheck={false}
                data-focus-ring="container"
                className="h-12 w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-subtle"
              />
              {isNested && page.name !== "ask" && (
                <span className="shrink-0 text-xs font-semibold text-muted">
                  {page.name === "missions" ? "Missions" : "Playbooks"}
                </span>
              )}
              <button
                type="button"
                onClick={close}
                aria-label="Close command bar"
                className="shrink-0 rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            {/* Ask result panel */}
            {page.name === "ask" ? (
              <div className="max-h-[50vh] overflow-y-auto p-4">
                <p className="text-[13px] font-medium text-muted">“{page.query}”</p>
                {(page.status === "loading" || page.status === "slow") && (
                  <div className="mt-3 flex items-center gap-2 text-[13px] text-muted">
                    <Loader2 className="h-4 w-4 aos-spin text-muted" aria-hidden />
                    {page.status === "slow" ? "Still thinking — the strategist is taking a while…" : "Asking the strategist…"}
                  </div>
                )}
                {page.status === "error" && (
                  <div role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-failed bg-failed-tint p-3 text-[13px] text-failed-text">
                    <span className="mt-1 size-2.5 shrink-0 rounded-[2px] bg-failed" aria-hidden />
                    <span>{page.error}</span>
                  </div>
                )}
                {page.status === "done" && (
                  <div className="mt-3">
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{page.answer}</p>
                    {/* Phase 13B: explicit feedback affordance on the strategist answer */}
                    <div className="mt-2 flex justify-end">
                      <FeedbackButtons agentId="business-strategist" workspaceId={workspaceId} />
                    </div>
                    {page.citations && page.citations.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {page.citations.map((c, i) => (
                          <a
                            key={`${c.url}-${i}`}
                            href={c.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex max-w-full items-center gap-1 rounded-full border-line bg-paper px-2.5 py-1 text-[12px] font-medium text-muted hover:text-ink"
                          >
                            <span className="truncate">{c.title || c.url}</span>
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <p className="mt-4 text-[12px] text-subtle">
                  <kbd className="rounded border border-line bg-canvas px-1 font-sans text-muted">Esc</kbd> to close ·
                  <kbd className="ml-1 rounded border border-line bg-canvas px-1 font-sans text-muted">⌫</kbd> to go back
                </p>
              </div>
            ) : (
              <>
                {/* Notice line (Do-action results / defensive unavailability) */}
                {notice && (
                  <div
                    className="flex items-start gap-2 border-b border-line bg-canvas px-3 py-2 text-sm text-muted"
                    role="status"
                  >
                    {notice.kind === "ok" ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
                    ) : (
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
                    )}
                    <span>{notice.text}</span>
                  </div>
                )}

                {/* Playbooks page states */}
                {page.name === "playbooks" && page.status !== "ready" && (
                  <div className="px-3 py-6 text-center text-[13px] text-muted">
                    {page.status === "loading" && (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 aos-spin text-muted" aria-hidden />
                        Loading playbooks…
                      </span>
                    )}
                    {page.status === "unavailable" && "Playbooks are not yet available (Phase 9 M5)."}
                    {page.status === "error" && "Could not load playbooks. Try again later."}
                  </div>
                )}

                {/* Result list */}
                <div
                  id="cmdk-listbox"
                  role="listbox"
                  aria-label="Command results"
                  className="max-h-[50vh] overflow-y-auto py-1.5"
                >
                  {groups.map((group) => (
                    <div key={group.section} role="group" aria-labelledby={`cmdk-h-${group.section}`}>
                      <h3
                        id={`cmdk-h-${group.section}`}
                        className="px-3 pb-1 pt-2 text-xs font-semibold text-muted"
                      >
                        {group.label}
                      </h3>
                      {group.items.map((item) => {
                        const flatIndex = items.indexOf(item);
                        const isActive = flatIndex === active;
                        const Icon = item.icon;
                        return (
                          <div
                            key={item.id}
                            id={`cmdk-option-${item.id}`}
                            role="option"
                            aria-selected={isActive}
                            onClick={() => runItem(item)}
                            onMouseMove={() => {
                              if (!isActive) setActive(flatIndex);
                            }}
                            className={cn(
                              "mx-1.5 flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px]",
                              isActive ? "bg-ink text-white" : "text-ink hover:bg-hover-paper",
                            )}
                          >
                            <Icon
                              className={cn("h-4 w-4 shrink-0", isActive ? "text-white" : "text-muted")}
                              aria-hidden
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">{item.title}</span>
                              {item.subtitle && (
                                <span className={cn("block truncate text-[12px]", isActive ? "text-white/70" : "text-subtle")}>
                                  {item.subtitle}
                                </span>
                              )}
                            </span>
                            {item.hotkey && (
                              <kbd
                                className={cn(
                                  "shrink-0 rounded border px-1.5 py-0.5 font-sans text-[11px]",
                                  isActive ? "border-white/20 bg-white/10 text-white" : "border-line bg-canvas text-muted",
                                )}
                              >
                                {item.hotkey}
                              </kbd>
                            )}
                            {isActive && (
                              <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-white/60" aria-hidden />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {items.length === 0 && page.name !== "playbooks" && (
                    <p className="px-3 py-6 text-center text-[13px] text-subtle">No matching commands.</p>
                  )}
                  {page.name === "root" && records.loading && query.trim().length >= 2 && (
                    <p className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-subtle" role="status">
                      <Loader2 className="h-3.5 w-3.5 aos-spin" aria-hidden />
                      Searching records…
                    </p>
                  )}
                  {page.name === "root" && !query.trim() && (
                    <div className="mt-1 border-t border-line px-3 py-2">
                      <p className="flex items-center gap-1.5 text-[12px] text-subtle">
                        <Sparkles className="h-3.5 w-3.5" aria-hidden />
                        Tip: type a question to ask the Chief Strategy Agent — answers come with citations.
                      </p>
                    </div>
                  )}
                </div>

                {/* Footer hints */}
                <div className="flex items-center gap-3 border-t border-line px-3 py-2 text-[12px] text-subtle">
                  <span className="flex items-center gap-1">
                    <kbd className="rounded border border-line bg-canvas px-1 font-sans text-muted">↑↓</kbd> navigate
                  </span>
                  <span className="flex items-center gap-1">
                    <kbd className="rounded border border-line bg-canvas px-1 font-sans text-muted">↵</kbd> run
                  </span>
                  <span className="flex items-center gap-1">
                    <kbd className="rounded border border-line bg-canvas px-1 font-sans text-muted">esc</kbd> close
                  </span>
                  {isNested && (
                    <span className="flex items-center gap-1">
                      <kbd className="rounded border border-line bg-canvas px-1 font-sans text-muted">⌫</kbd> back
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Screen-reader announcements (open, result counts, page changes). */}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </>
  );
}
