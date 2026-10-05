// Marketr — Phase 9 M3: command-bar sidekick (⌘K).
//
// Hand-rolled cmdk-STYLE palette (no cmdk dependency). 0ms open/close — no
// animations, instant mount/unmount. Full keyboard contract:
// ⌘K/Ctrl+K toggles · type immediately · ↑/↓ wrap · Enter runs · Esc closes ·
// Backspace (empty query) pops nested pages · focus returns on close.
//
// Phase 4d (kit: docs/design/kit/command-and-inputs.png): search row with an
// esc keycap; Agents (the lead first, then its sub-agents, each with its
// one-line state and status shape + label on the right); Actions with
// keycaps (New task ⌘N, Schedule a run ⌘J, Open approvals G I, missions ⌥M,
// playbooks ⌥P); Tools with their real connection state (Connected /
// Reconnect); then Go (every nav destination), Records and Ask (free-form
// question to the orchestrator, answered inline with citations). Active row
// solid black; footer ↑↓ Move · ↵ Open · esc Clear and the result count.
// Every invocation is audited via POST /api/command/audit → logCommand()
// (audit.ts): templated actions log {templateId, promptHash}; free-form asks
// log the FULL prompt.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type SVGProps } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  Box,
  Briefcase,
  CalendarDays,
  CheckCircle2,
  Clock,
  Command,
  File as FileIcon,
  Folder,
  FileText,
  FolderKanban,
  Globe,
  Database,
  Inbox,
  Loader2,
  Mail,
  Package,
  PenLine,
  Plug,
  Plus,
  ReceiptText,
  Rocket,
  Scale,
  Search,
  Sparkles,
  Target,
  Users,
  type LucideIcon,
} from "lucide-react";
import { RECORD_KIND_LABELS } from "@/lib/search/kinds";
import { cn } from "@/lib/utils";
import FeedbackButtons from "@/components/agents/FeedbackButtons";
import { navCommands } from "@/lib/nav/config";
import { AgentAvatar, KeyCap, KeyCaps } from "@/components/aos/AgentAvatar";
import { StatusShape } from "@/components/aos/StatusShape";
import { toolIcon } from "@/components/aos/ToolChip";
import { useNeedsYouCount } from "@/components/approvals/NeedsYouBadge";
import { STATUS_META } from "@/lib/aos/status";
import { visibleBranches } from "@/lib/aos/agents";
import { isComposerAgentKey } from "@/lib/aos/composer";
import { openNewTask } from "./NewTaskDialog";
import {
  agentCommandItems,
  AsyncBudgetExceeded,
  buildAskAuditPayload,
  buildDoAuditPayload,
  buildGoAuditPayload,
  buildTemplateAuditPayload,
  capIdleSection,
  groupBySection,
  hotkeyParts,
  isTypingTarget,
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
  SEQUENCE_WINDOW_MS,
  shouldPopOnBackspace,
  shouldSearchRecords,
  toolCommandItems,
  type AuditPayload,
  type ConnectorSummary,
  type PaletteTree,
  type RecordResult,
  type CommandItem,
  type FrecencyMap,
} from "./lib";

// Budgets from docs/specs/SPEC-PHASE9.md §P9B / research: LLM suggestions hidden if late.
const SUGGESTION_BUDGET_MS = 800;
// Rows shown per section before the user types (everything is searchable).
const GO_IDLE_LIMIT = 6;
const AGENTS_IDLE_LIMIT = 5;
const TOOLS_IDLE_LIMIT = 4;
const ACTIONS_IDLE_LIMIT = 3;
/** "Schedule a run" (⌘J) opens the schedule wizard on the workspace's project. */
const SCHEDULE_HREF = "/dashboard/schedules/new";
const APPROVALS_HREF = "/dashboard/approvals";

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
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;
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
  { id: "do:missions", section: "actions", title: "Start a mission", subtitle: "From a Growth Mission template", keywords: "mission goal launch template growth", hotkey: "⌥M", action: "missions-page", icon: Rocket },
  { id: "do:playbooks", section: "actions", title: "Run a playbook step", subtitle: "Agent playbooks", keywords: "playbook run step procedure", hotkey: "⌥P", action: "playbooks-page", icon: BookOpen },
];

/** Kit Actions: New task ⌘N, Schedule a run ⌘J, Open approvals G I. */
function actionItems(needsYou: number): UICommand[] {
  return [
    { id: "action:new-task", section: "actions", title: "New task", subtitle: "Hand a goal to the lead agent", keywords: "task goal agent strategist composer hand off", hotkey: "⌘N", action: "new-task", agentKey: "lead", icon: Plus },
    { id: "action:schedule", section: "actions", title: "Schedule a run", subtitle: "Repeat daily or weekly", keywords: "schedule cron recurring automation run", hotkey: "⌘J", action: "go", href: SCHEDULE_HREF, icon: Clock },
    {
      id: "action:approvals",
      section: "actions",
      title: "Open approvals",
      subtitle: needsYou > 0 ? `${needsYou} ${needsYou === 1 ? "approval" : "approvals"} waiting` : "Nothing waiting on you",
      keywords: "inbox approvals needs you review approve",
      hotkey: "G I",
      action: "go",
      href: APPROVALS_HREF,
      icon: Inbox,
    },
    ...DO_ITEMS,
  ];
}

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

/** Lucide icon for a connector row: by its key first, then its name (kit tool icons). */
function connectorIcon(key: string, name: string): UICommand["icon"] {
  const k = key.toLowerCase();
  if (/mail|resend/.test(k)) return Mail;
  if (/calendar/.test(k)) return CalendarDays;
  if (/drive|notion|wordpress|webflow|files?/.test(k)) return Folder;
  if (/search|analytics|ga4|ads|seo|dataforseo/.test(k)) return Globe;
  return toolIcon(name);
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

  // Global shortcuts: ⌘K / Ctrl+K toggles; ⌘J / Ctrl+J schedules a run; G
  // then I opens approvals (only outside text fields); ⌘N belongs to the
  // New task composer (NewTaskDialog), so the palette just gets out of its way.
  const seqRef = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && !e.shiftKey && !e.altKey && key === "k") {
        e.preventDefault();
        toggle();
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && key === "n") {
        if (openRef.current) close();
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && key === "j") {
        e.preventDefault();
        if (openRef.current) close();
        void postAudit(buildGoAuditPayload(SCHEDULE_HREF));
        router.push(SCHEDULE_HREF);
        return;
      }
      if (mod || e.altKey || openRef.current || isTypingTarget(e.target as HTMLElement | null)) {
        seqRef.current = null;
        return;
      }
      const now = Date.now();
      const prev = seqRef.current;
      if (key === "i" && prev?.key === "g" && now - prev.at <= SEQUENCE_WINDOW_MS) {
        e.preventDefault();
        seqRef.current = null;
        void postAudit(buildGoAuditPayload(APPROVALS_HREF));
        router.push(APPROVALS_HREF);
        return;
      }
      seqRef.current = key === "g" ? { key, at: now } : null;
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
  }, [toggle, close, router]);

  // ---- agents + tools (Phase 4d) -------------------------------------------
  // Read on every open: the lead → sub-agent tree (same feed as the sidebar's
  // Running now) and the workspace's connector connections (viewer+). Both
  // are best effort; the sections fall back to their idle rows.
  const [tree, setTree] = useState<PaletteTree | null>(null);
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null>(null);
  const { actionable: needsYou } = useNeedsYouCount();
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/agents/activity", { cache: "no-store", signal: ctrl.signal });
        if (!res.ok) return;
        const body = (await res.json()) as { tree?: PaletteTree | null };
        setTree(body.tree ? { lead: body.tree.lead, branches: body.tree.branches } : null);
      } catch {
        // keep the last good tree
      }
    })();
    void (async () => {
      try {
        const res = await fetch(`/api/connectors?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store", signal: ctrl.signal });
        if (!res.ok) return;
        const body = (await res.json()) as { connectors?: ConnectorSummary[] };
        setConnectors(body.connectors ?? []);
      } catch {
        // keep the last good list
      }
    })();
    return () => ctrl.abort();
  }, [open, workspaceId]);

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
    const now = Date.now();
    if (page.name === "root") {
      // Agents, Actions and Tools keep their own order (the lead first, kit
      // action order) and only filter when typing; Go is frecency-ordered.
      const fixed = (list: UICommand[], section: "agents" | "tools", limit: number) =>
        capIdleSection(rankCommands(list, q, {}, now), q, section, limit);
      // Idle: the lead plus the branches that matter most (finished ones make
      // way first, lib/aos visibleBranches); typing searches every agent.
      const shownTree = tree && !q ? { lead: tree.lead, branches: visibleBranches(tree.branches, AGENTS_IDLE_LIMIT - 1).shown } : tree;
      const agents = fixed(
        agentCommandItems(shownTree).map((i) => ({ ...i, icon: Users })),
        "agents",
        AGENTS_IDLE_LIMIT,
      );
      // Idle Actions are the kit's three; missions/playbooks show when typing (and keep ⌥M / ⌥P).
      const actions = capIdleSection(rankCommands(actionItems(needsYou), q, {}, now), q, "actions", ACTIONS_IDLE_LIMIT);
      const tools = connectors
        ? fixed(
            toolCommandItems(connectors).map((i) => ({ ...i, icon: i.id === "tool:connect" ? Plug : connectorIcon(i.id.slice("tool:".length), i.title) })),
            "tools",
            TOOLS_IDLE_LIMIT,
          )
        : [];
      const go = capIdleSection(rankCommands(GO_ITEMS, q, frec, now), q, "go", GO_IDLE_LIMIT);
      let ranked: UICommand[] = [...agents, ...actions, ...tools, ...go];
      // Records only for the query they were fetched for (no stale flashes).
      if (q && records.query === q && records.items.length > 0) {
        ranked = mergeBySection(ranked, records.items);
      }
      if (q) {
        ranked.push(
          {
            id: `ask:${q}`,
            section: "ask",
            title: `Ask: “${q}”`,
            subtitle: "Ask the Strategist, answered with citations",
            keywords: "ask question ai strategist",
            action: "ask",
            icon: Sparkles,
          },
          {
            id: `task:${q}`,
            section: "ask",
            title: `New task: “${q}”`,
            subtitle: "Hand it to the Strategist",
            keywords: "task hand off",
            action: "new-task",
            agentKey: "lead",
            goal: q,
            icon: Plus,
          },
        );
      }
      return ranked;
    }
    let base: UICommand[];
    if (page.name === "missions") {
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
    return rankCommands(base, q, frec, now);
  }, [page, query, frec, records, tree, connectors, needsYou]);

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
        case "new-task": {
          bumpFrecency(item.id.startsWith("task:") ? "task" : item.id);
          void postAudit(buildDoAuditPayload("New task", item.agentKey && item.agentKey !== "lead" ? `hand to ${item.agentKey}` : undefined));
          close();
          openNewTask(isComposerAgentKey(item.agentKey) ? item.agentKey : "lead", item.goal);
          break;
        }
      }
    },
    [runGo, runTemplate, runPlaybook, runAsk, query, bumpFrecency, close],
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
      // esc clears what you typed first, then closes.
      if (query) {
        setQuery("");
        setActive(0);
        setNotice(null);
      } else {
        close();
      }
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
        className="fixed bottom-4 right-4 z-40 rounded-full bg-ink p-3.5 text-paper shadow-raised aos-press md:hidden"
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
            className="absolute left-1/2 top-[12%] w-[calc(100%-2rem)] max-w-[620px] -translate-x-1/2 overflow-hidden rounded-lg bg-paper shadow-overlay"
            onKeyDown={onPaletteKeyDown}
          >
            {/* Search row (kit): search icon, the field, an esc keycap that closes. */}
            <div className="flex h-14 items-center gap-3 border-b border-line px-4 focus-within:border-focus sm:px-5">
              {isNested && (
                <button
                  type="button"
                  onClick={popPage}
                  aria-label="Back to command bar"
                  className="-ml-1.5 flex size-8 shrink-0 items-center justify-center rounded-full text-ink hover:bg-hover-paper"
                >
                  <ArrowLeft className="size-4" aria-hidden />
                </button>
              )}
              <Search className="size-5 shrink-0 text-ink" aria-hidden />
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
                      : "Search or type a task…"
                }
                role="combobox"
                aria-expanded="true"
                aria-controls="cmdk-listbox"
                aria-activedescendant={activeDescendant}
                aria-label={pageTitle}
                autoComplete="off"
                spellCheck={false}
                data-focus-ring="container"
                className="h-full min-w-0 flex-1 bg-transparent text-lg text-ink outline-none placeholder:text-subtle"
              />
              {isNested && page.name !== "ask" && (
                <span className="shrink-0 text-xs font-semibold text-muted">
                  {page.name === "missions" ? "Missions" : "Playbooks"}
                </span>
              )}
              <button type="button" onClick={close} aria-label="Close command bar" className="shrink-0 rounded-key">
                <KeyCap>esc</KeyCap>
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
                <p className="mt-4 flex items-center gap-1.5 text-xs text-muted">
                  <KeyCap>esc</KeyCap> Close
                  <KeyCap className="ml-2">⌫</KeyCap> Back
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
                  className="max-h-[min(62vh,580px)] overflow-y-auto p-2"
                >
                  {groups.map((group) => (
                    <div key={group.section} role="group" aria-labelledby={`cmdk-h-${group.section}`}>
                      <h3 id={`cmdk-h-${group.section}`} className="px-3 pt-2 pb-1 text-xs font-semibold text-muted">
                        {group.label}
                      </h3>
                      {group.items.map((item) => {
                        const flatIndex = items.indexOf(item);
                        return (
                          <PaletteRow
                            key={item.id}
                            item={item}
                            active={flatIndex === active}
                            onRun={() => runItem(item)}
                            onHover={() => {
                              if (flatIndex !== active) setActive(flatIndex);
                            }}
                          />
                        );
                      })}
                    </div>
                  ))}
                  {items.length === 0 && page.name !== "playbooks" && (
                    <p className="px-3 py-6 text-center text-sm text-subtle">No matching commands.</p>
                  )}
                  {page.name === "root" && records.loading && query.trim().length >= 2 && (
                    <p className="flex items-center gap-1.5 px-3 py-2 text-xs text-subtle" role="status">
                      <Loader2 className="size-3.5 aos-spin" aria-hidden />
                      Searching records…
                    </p>
                  )}
                </div>

                {/* Footer (kit): ↑ ↓ Move · ↵ Open · esc Clear, result count right. */}
                <div className="flex items-center gap-4 border-t border-line px-4 py-3 text-xs text-muted sm:px-5">
                  <span className="flex items-center gap-1.5">
                    <KeyCap>↑</KeyCap>
                    <KeyCap>↓</KeyCap>
                    Move
                  </span>
                  <span className="flex items-center gap-1.5">
                    <KeyCap>↵</KeyCap>
                    Open
                  </span>
                  <span className="flex items-center gap-1.5">
                    <KeyCap>esc</KeyCap>
                    {query ? "Clear" : "Close"}
                  </span>
                  {isNested && (
                    <span className="hidden items-center gap-1.5 sm:flex">
                      <KeyCap>⌫</KeyCap>
                      Back
                    </span>
                  )}
                  <span className="ml-auto tabular-nums">
                    {items.length} {items.length === 1 ? "result" : "results"}
                  </span>
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

// ---------------------------------------------------------------------------
// One palette row (kit): 44px, radius-sm, leading tile, title + inline hint,
// and on the right the agent status (shape + label), the tool connection
// state, or keycaps. The active row is solid black.
// ---------------------------------------------------------------------------

function PaletteRow({
  item,
  active,
  onRun,
  onHover,
}: {
  item: UICommand;
  active: boolean;
  onRun: () => void;
  onHover: () => void;
}) {
  const Icon = item.icon;
  const isAgent = item.section === "agents";
  const keys = hotkeyParts(item.hotkey);
  return (
    <div
      id={`cmdk-option-${item.id}`}
      role="option"
      aria-selected={active}
      onClick={onRun}
      onMouseMove={onHover}
      className={cn(
        "flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-3 py-1.5 text-base",
        active ? "bg-ink text-paper" : "text-ink hover:bg-hover-paper",
      )}
    >
      {isAgent ? (
        <AgentAvatar name={item.title} size="sm" tone={active ? "paper" : "ink"} />
      ) : (
        <span
          aria-hidden
          className={cn("flex size-6 shrink-0 items-center justify-center rounded-key", active ? "bg-night-raised text-paper" : "bg-canvas text-ink")}
        >
          <Icon className="size-3.5" aria-hidden />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold">{item.title}</span>
        {item.subtitle ? (
          <span className={cn("ml-2 text-sm font-normal", active ? "text-night-soft" : "text-muted")}>{item.subtitle}</span>
        ) : null}
      </span>
      {item.status ? (
        <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold", active ? "text-paper" : "text-ink")}>
          <StatusShape status={item.status} size={9} tone={active ? "night" : "paper"} live={false} />
          {STATUS_META[item.status].label}
        </span>
      ) : item.toolState === "connected" ? (
        <span className={cn("shrink-0 text-sm font-semibold", active ? "text-night-soft" : "text-muted")}>Connected</span>
      ) : item.toolState === "reconnect" ? (
        <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold", active ? "text-paper" : "text-failed-text")}>
          <StatusShape status="failed" size={9} tone={active ? "night" : "paper"} />
          Reconnect
        </span>
      ) : keys.length ? (
        <KeyCaps keys={keys} className="hidden sm:inline-flex" />
      ) : null}
    </div>
  );
}
