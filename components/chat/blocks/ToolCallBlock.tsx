"use client";

// ShapesOS — Phase 22 (chat): one tool call in the transcript, Claude Code
// style: a `radius-md` block with the tool name in JetBrains Mono, the state
// (an agent state: running circle, needs-you triangle, done quarter-disc,
// failed square — never decoration), the streamed arguments (collapsible
// JSON) and the result drawn by a typed renderer (records table, file card,
// image, diff, plan, text with "Show more" and an inline "Load more" that
// reads the rest from the saved transcript).

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ExternalLink, FileText, Image as ImageIcon, PanelRight } from "lucide-react";
import { StatusShape } from "@/components/aos/StatusShape";
import { AgentAvatar } from "@/components/aos/AgentAvatar";
import { aosButton } from "@/components/aos/button";
import { agentDisplayName, isAgentKey } from "@/lib/agents/grants";
import type { AosStatus } from "@/lib/aos/status";
import type { ChatBlock } from "@/lib/chat/blocks";
import { sanitizePaneHref } from "@/lib/desktop/split";
import { cn } from "@/lib/utils";
import { useI18n } from "@/components/i18n/I18nProvider";
import { CodeBlock } from "../Markdown";

type ToolBlock = Extract<ChatBlock, { kind: "tool" }>;

export interface ToolBlockHandlers {
  /** Open a /dashboard record or file in the panel's window (sanitised there). */
  onOpenHref?: (href: string, title?: string) => void;
  /** Open a produced file / image / document in the Artifacts panel. */
  onOpenArtifact?: (ref: { fileId?: string | null; url?: string | null; name: string; kind: "file" | "image" }) => void;
  /** The rest of a capped result (GET …/results/[handle]?offset=). */
  loadMore?: (handle: string, offset: number) => Promise<{ text: string; next: number | null }>;
}

const TEXT_PREVIEW = 1_200;

export function toolStatusView(status: ToolBlock["status"]): { aos: AosStatus | null; key: "running" | "done" | "pending" | "denied" | "error" | "cancelled" | "skipped" } {
  switch (status) {
    case "running":
      return { aos: "running", key: "running" };
    case "executed":
      return { aos: "done", key: "done" };
    case "pending_confirmation":
      return { aos: "needs", key: "pending" };
    case "error":
      return { aos: "failed", key: "error" };
    case "denied":
      return { aos: "failed", key: "denied" };
    case "skipped_role":
      return { aos: "failed", key: "skipped" };
    case "cancelled":
    default:
      return { aos: null, key: "cancelled" };
  }
}

/** "connector__dataforseo__keyword_ideas" → "dataforseo.keyword_ideas"; "get_keywords" stays. */
export function toolDisplayName(tool: string): string {
  return tool.replace(/^connector__/, "").replace(/__/g, ".");
}

function pretty(args: Record<string, unknown> | null, raw: string): string {
  if (args) {
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      /* fall through */
    }
  }
  return raw;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function RecordsTable({ payload, handlers }: { payload: Record<string, unknown>; handlers: ToolBlockHandlers }) {
  const { t } = useI18n();
  const rows = (Array.isArray(payload.rows) ? payload.rows : []).filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  const columns = (Array.isArray(payload.columns) ? payload.columns.filter((c): c is string => typeof c === "string") : Object.keys(rows[0] ?? {})).filter((c) => c !== "href").slice(0, 8);
  const total = typeof payload.total === "number" ? payload.total : rows.length;
  const [limit, setLimit] = useState(10);
  if (rows.length === 0) return <p className="px-3 py-2 text-sm text-muted">{t("chat.tool.noRows")}</p>;
  const shown = rows.slice(0, limit);
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs text-muted">
              {columns.map((c) => (
                <th key={c} className="px-3 py-1.5 font-medium whitespace-nowrap">
                  {c.replace(/_/g, " ")}
                </th>
              ))}
              <th className="px-3 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => {
              const href = typeof r.href === "string" ? sanitizePaneHref(r.href) : null;
              return (
                <tr key={i} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  {columns.map((c) => (
                    <td key={c} className={cn("max-w-[22rem] truncate px-3 py-1.5 align-top text-ink", typeof r[c] === "number" && "tabular-nums")} title={cell(r[c])}>
                      {cell(r[c])}
                    </td>
                  ))}
                  <td className="px-2 py-1 text-right whitespace-nowrap">
                    {href && handlers.onOpenHref ? (
                      <button type="button" onClick={() => handlers.onOpenHref?.(href, cell(r.title ?? r.name ?? r[columns[0]!]))} className={aosButton({ variant: "quiet", size: "xs" })} aria-label={t("chat.tool.openInPanel")}>
                        <PanelRight className="size-3.5" aria-hidden />
                        {t("chat.tool.open")}
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs text-muted">
        <span>{t("chat.tool.ofTotal", { shown: shown.length, total })}</span>
        {shown.length < rows.length ? (
          <button type="button" onClick={() => setLimit((l) => l + 25)} className="font-semibold text-ink underline-offset-4 hover:underline">
            {t("chat.tool.showMore")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function FileCard({ payload, kind, handlers }: { payload: Record<string, unknown>; kind: "file" | "image"; handlers: ToolBlockHandlers }) {
  const { t } = useI18n();
  const url = typeof payload.url === "string" ? payload.url : null;
  const name = typeof payload.name === "string" ? payload.name : "file";
  const path = typeof payload.path === "string" ? payload.path : "";
  const fileId = typeof payload.fileId === "string" ? payload.fileId : null;
  const Icon = kind === "image" ? ImageIcon : FileText;
  return (
    <div className="px-3 py-2">
      {kind === "image" && url ? (
        // eslint-disable-next-line @next/next/no-img-element -- a workspace file served by this app
        <img src={url} alt={name} className="mb-2 max-h-80 w-auto rounded-md bg-canvas" />
      ) : null}
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-ink text-paper">
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-md font-semibold text-ink">{name}</span>
          {path ? <span className="aos-mono block truncate text-xs text-muted">{path}</span> : null}
        </span>
        {handlers.onOpenArtifact ? (
          <button type="button" onClick={() => handlers.onOpenArtifact?.({ fileId, url, name, kind })} className={aosButton({ variant: "secondary", size: "xs" })}>
            <PanelRight className="size-3.5" aria-hidden />
            {t("chat.tool.openInPanel")}
          </button>
        ) : null}
        {url ? (
          <Link href={url} target="_blank" rel="noopener noreferrer" className={aosButton({ variant: "quiet", size: "xs" })} aria-label={`${t("chat.tool.open")} ${name}`}>
            <ExternalLink className="size-3.5" aria-hidden />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function PlanTable({ payload }: { payload: Record<string, unknown> }) {
  const { t } = useI18n();
  const tasks = (Array.isArray(payload.tasks) ? payload.tasks : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  return (
    <div className="px-3 py-2">
      {typeof payload.goal === "string" && payload.goal ? <p className="mb-2 text-md font-semibold text-ink">{payload.goal}</p> : null}
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs text-muted">
            <th className="px-2 py-1.5 font-medium">{t("chat.plan.agent")}</th>
            <th className="px-2 py-1.5 font-medium">{t("chat.plan.brief")}</th>
            <th className="px-2 py-1.5 font-medium">{t("chat.plan.deliverable")}</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task, i) => {
            const agent = typeof task.agent === "string" && isAgentKey(task.agent) ? agentDisplayName(task.agent) : cell(task.agent);
            return (
              <tr key={i} className="border-b border-line align-top last:border-0">
                <td className="px-2 py-1.5 whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
                    <AgentAvatar name={agent || "?"} size="sm" />
                    {agent}
                    <span className="aos-mono font-normal text-subtle">{cell(task.id)}</span>
                  </span>
                </td>
                <td className="px-2 py-1.5 text-ink">{cell(task.brief)}</td>
                <td className="px-2 py-1.5 text-muted">{cell(task.deliverable)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {typeof payload.mergeInstructions === "string" && payload.mergeInstructions ? (
        <p className="mt-2 text-sm text-muted">
          <span className="font-semibold text-ink">{t("chat.plan.merge")}:</span> {payload.mergeInstructions}
        </p>
      ) : null}
    </div>
  );
}

function TextResult({ text, truncated, handle, handlers }: { text: string; truncated: boolean; handle: string | null; handlers: ToolBlockHandlers }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [extra, setExtra] = useState("");
  const [next, setNext] = useState<number | null>(truncated ? text.length : null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const full = text + extra;
  const long = full.length > TEXT_PREVIEW;
  const shown = open || !long ? full : full.slice(0, TEXT_PREVIEW);
  return (
    <div className="px-3 py-2">
      <pre className="aos-mono max-h-[32rem] overflow-auto text-[0.8125rem] leading-6 whitespace-pre-wrap break-words text-ink">{shown}{!open && long ? "…" : ""}</pre>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
        {long ? (
          <button type="button" onClick={() => setOpen((o) => !o)} className="font-semibold text-ink underline-offset-4 hover:underline">
            {open ? t("chat.tool.showLess") : t("chat.tool.showMore")}
          </button>
        ) : null}
        {next !== null && handle && handlers.loadMore ? (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setFailed(false);
              try {
                const r = await handlers.loadMore!(handle, next);
                setExtra((e) => e + r.text);
                setNext(r.next);
                setOpen(true);
              } catch {
                setFailed(true);
              } finally {
                setBusy(false);
              }
            }}
            className="font-semibold text-ink underline-offset-4 hover:underline disabled:text-disabled-fg"
          >
            {t("chat.tool.loadMore")}
          </button>
        ) : null}
        {failed ? <span className="text-failed-text">{t("chat.tool.loadFailed")}</span> : null}
      </div>
    </div>
  );
}

function ResultView({ block, handlers }: { block: ToolBlock; handlers: ToolBlockHandlers }) {
  const { t } = useI18n();
  const payload = block.payload && typeof block.payload === "object" && !Array.isArray(block.payload) ? (block.payload as Record<string, unknown>) : null;
  if (block.status !== "executed") {
    return block.resultText ? <p className={cn("px-3 py-2 text-sm", block.status === "pending_confirmation" ? "text-muted" : "text-failed-text")}>{block.resultText}</p> : null;
  }
  switch (block.ui) {
    case "records":
      return payload ? <RecordsTable payload={payload} handlers={handlers} /> : null;
    case "file":
    case "image":
      return payload ? <FileCard payload={payload} kind={block.ui} handlers={handlers} /> : null;
    case "diff":
      return <CodeBlock code={typeof payload?.diff === "string" ? payload.diff : block.resultText ?? ""} lang="diff" className="m-2" />;
    case "plan":
      return payload ? <PlanTable payload={payload} /> : null;
    case "chart":
    case "text":
    default: {
      const text = typeof payload?.text === "string" && payload.text ? payload.text : "";
      if (!text) return block.resultText ? <p className="px-3 py-2 text-sm text-ink">{block.resultText}</p> : <p className="px-3 py-2 text-sm text-muted">{t("chat.tool.noResult")}</p>;
      const more = payload?.more && typeof payload.more === "object" ? (payload.more as { handle?: unknown }) : null;
      return <TextResult text={text} truncated={payload?.truncated === true} handle={typeof more?.handle === "string" ? more.handle : block.toolUseId} handlers={handlers} />;
    }
  }
}

export function ToolCallBlock({ block, handlers = {}, defaultOpen }: { block: ToolBlock; handlers?: ToolBlockHandlers; defaultOpen?: boolean }) {
  const { t } = useI18n();
  const view = toolStatusView(block.status);
  const [open, setOpen] = useState(defaultOpen ?? (block.status === "running" || block.status === "pending_confirmation"));
  const [argsOpen, setArgsOpen] = useState(false);
  // A call that just finished opens its result once (then the person decides).
  useEffect(() => {
    if (block.status === "executed" && block.ui && block.ui !== "text") setOpen(true);
  }, [block.status, block.ui]);
  const agent = block.agentKey && isAgentKey(block.agentKey) ? agentDisplayName(block.agentKey) : null;
  const argsText = useMemo(() => pretty(block.args, block.argsText), [block.args, block.argsText]);
  const hasArgs = argsText.trim() && argsText.trim() !== "{}";
  const summaryLine = block.status === "executed" && block.resultText ? block.resultText : null;
  return (
    <section className="overflow-hidden rounded-md bg-paper shadow-hairline" aria-label={`${toolDisplayName(block.tool)}: ${t(`chat.tool.${view.key}`)}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-10 w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-hover-paper"
      >
        {view.aos ? (
          <StatusShape status={view.aos} size={10} live={view.aos === "running"} />
        ) : (
          <span className="inline-block size-2.5 rounded-full bg-line-strong" aria-hidden />
        )}
        <span className="aos-mono min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-ink">{toolDisplayName(block.tool)}</span>
        {agent && block.agentKey !== "lead" ? (
          <span className="hidden items-center gap-1 text-xs text-muted sm:inline-flex">
            <AgentAvatar name={agent} size="sm" />
            {agent}
          </span>
        ) : null}
        <span className={cn("shrink-0 text-xs font-semibold", view.aos === "failed" ? "text-failed-text" : view.aos === "needs" ? "text-ink" : "text-muted")}>
          {t(`chat.tool.${view.key}`)}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted transition-transform duration-150", open && "rotate-180")} aria-hidden />
      </button>
      {!open && summaryLine ? <p className="truncate border-t border-line px-3 py-1.5 text-xs text-muted">{summaryLine}</p> : null}
      {open ? (
        <div className="border-t border-line">
          {hasArgs ? (
            <div className="border-b border-line">
              <button type="button" onClick={() => setArgsOpen((o) => !o)} aria-expanded={argsOpen} className="flex h-8 w-full items-center gap-2 px-3 text-xs text-muted hover:bg-hover-paper">
                <ChevronDown className={cn("size-3.5 transition-transform duration-150", argsOpen && "rotate-180")} aria-hidden />
                {t("chat.tool.arguments")}
                {!argsOpen ? <span className="aos-mono min-w-0 flex-1 truncate text-subtle">{argsText.replace(/\s+/g, " ").slice(0, 120)}</span> : null}
              </button>
              {argsOpen ? <pre className="aos-mono max-h-64 overflow-auto px-3 pb-2 text-[0.8125rem] leading-6 whitespace-pre-wrap break-words text-ink">{argsText}</pre> : null}
            </div>
          ) : null}
          {block.status === "running" ? (
            <p className="flex items-center gap-2 px-3 py-2 text-sm text-muted">
              <StatusShape status="running" size={9} live />
              {t("chat.tool.running")}
            </p>
          ) : (
            <ResultView block={block} handlers={handlers} />
          )}
          {block.autoApproved ? <p className="border-t border-line px-3 py-1.5 text-xs text-muted">{t("chat.tool.autoApproved", { reason: block.autoApproved })}</p> : null}
          {block.confirmed ? <p className="border-t border-line px-3 py-1.5 text-xs text-muted">{t("chat.tool.confirmed")}</p> : null}
          {block.cached ? <p className="border-t border-line px-3 py-1.5 text-xs text-muted">{t("chat.tool.cached")}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

export default ToolCallBlock;
