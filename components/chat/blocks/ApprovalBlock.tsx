"use client";

// ShapesOS — Phase 22 (chat): inline approvals, in place of "type yes".
//
// The held calls of one turn render as ONE block in the kit's approval
// language (yellow "Needs your approval" header with the needs-you triangle,
// the agent's name; per item: the tool in mono, its arguments, the tier,
// Deny (white, red ring) / Edit (quiet) / Always allow (Tier 0–2 only) /
// Approve (green, check)). Approving posts to
// POST /api/chat/threads/[id]/decisions (ChatContext.decide) and the turn
// continues in the same stream, so the result appears under the call above.
//
// Tier 3 (money, irreversible) and destructive calls need a click here: a
// typed or spoken "yes" is refused by the server (owner rule, 2026-10-05) and
// the block says so. Keyboard y / n / e targets the first pending item (the
// composer forwards them when it is empty).

import { useId, useState } from "react";
import { Check, Lock } from "lucide-react";
import { StatusShape } from "@/components/aos/StatusShape";
import { aosButton } from "@/components/aos/button";
import { agentDisplayName, isAgentKey } from "@/lib/agents/grants";
import { actionLabel } from "@/lib/automation/actions";
import type { ApprovalItem, ChatBlock } from "@/lib/chat/blocks";
import { cn } from "@/lib/utils";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toolDisplayName } from "./ToolCallBlock";

type ApprovalBlockModel = Extract<ChatBlock, { kind: "approval" }>;

export type DecisionKind = "approve" | "deny";

export interface ChatDecisionInput {
  /** The proposal's tool_use id (toolCallId when the server sent none). */
  toolUseId: string | null;
  toolCallId: string;
  tool: string;
  decision: DecisionKind;
  /** Edited arguments (Edit → Save and approve). */
  args?: Record<string, unknown>;
  /** Save a per-agent "do this without asking" rule as well (Tier 0–2 only). */
  alwaysAllow?: boolean;
}

export interface ApprovalHandlers {
  decide: (decisions: ChatDecisionInput[]) => Promise<string | null>;
  canEdit: boolean;
}

function argRows(args: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(args).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
}

function Item({ item, agent, handlers, busy, onBusy }: { item: ApprovalItem; agent: string; handlers: ApprovalHandlers; busy: DecisionKind | null; onBusy: (b: DecisionKind | null) => void }) {
  const { t } = useI18n();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(item.args, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [always, setAlways] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decided = item.decision !== "pending";
  const send = async (decision: DecisionKind, args?: Record<string, unknown>) => {
    onBusy(decision);
    setError(null);
    const err = await handlers.decide([{ toolUseId: item.toolUseId, toolCallId: item.toolCallId, tool: item.tool, decision, ...(args ? { args } : {}), ...(always && item.autoAction && !item.needsClick ? { alwaysAllow: true } : {}) }]);
    onBusy(null);
    if (err) setError(err);
    else setEditing(false);
  };
  const saveEdit = () => {
    try {
      const parsed = JSON.parse(draft) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object");
      setJsonError(null);
      void send("approve", parsed as Record<string, unknown>);
    } catch {
      setJsonError(t("chat.approval.invalidJson"));
    }
  };
  return (
    <li className="px-5 py-4" data-approval-item={item.toolUseId ?? item.toolCallId}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm text-muted">{t("chat.approval.wants", { agent })}</span>
        <span className="aos-mono text-md font-semibold text-ink">{toolDisplayName(item.tool)}</span>
        {item.tier !== null ? (
          <span className={cn("inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold", item.tier === 3 ? "bg-ink text-paper" : "bg-canvas text-muted")}>{t("chat.approval.tier", { tier: item.tier })}</span>
        ) : null}
        {item.toolKind ? <span className="inline-flex h-6 items-center rounded-full bg-canvas px-2.5 text-xs font-semibold text-muted">{item.toolKind}</span> : null}
      </div>
      {item.summary ? <p className="mt-1 text-sm text-muted">{item.summary}</p> : null}
      {editing ? (
        <div className="mt-3">
          <label htmlFor={`${id}-args`} className="sr-only">
            {t("chat.tool.arguments")}
          </label>
          <textarea
            id={`${id}-args`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(12, Math.max(3, draft.split("\n").length))}
            aria-invalid={jsonError ? true : undefined}
            className={cn("aos-mono block w-full rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-[0.8125rem] leading-6 text-ink focus:border-focus focus:outline-none", jsonError && "border-failed")}
          />
          {jsonError ? (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-failed-text">
              <span className="inline-block size-2 bg-failed" aria-hidden />
              {jsonError}
            </p>
          ) : null}
        </div>
      ) : argRows(item.args).length ? (
        <ul className="mt-3 divide-y divide-line rounded-md shadow-hairline">
          {argRows(item.args).map(([k, v]) => (
            <li key={k} className="flex min-h-9 items-center justify-between gap-3 px-3 py-1.5 text-sm">
              <span className="aos-mono shrink-0 text-muted">{k}</span>
              <span className="min-w-0 truncate text-right text-ink" title={v}>
                {v}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {item.needsClick && !decided ? (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-muted">
          <Lock className="size-3.5 shrink-0" aria-hidden />
          {t("chat.approval.needsClick")}
        </p>
      ) : null}
      {!decided && item.autoAction && !item.needsClick && handlers.canEdit ? (
        <div className="mt-3 flex items-center gap-2.5">
          <input
            id={`${id}-always`}
            type="checkbox"
            checked={always}
            onChange={(e) => setAlways(e.target.checked)}
            className="size-[18px] shrink-0 cursor-pointer appearance-none rounded-key bg-paper shadow-[inset_0_0_0_1.5px_var(--aos-control)] checked:bg-ink checked:shadow-none"
          />
          <label htmlFor={`${id}-always`} className="text-sm text-ink">
            {t("chat.approval.always", { action: actionLabel(item.autoAction).toLowerCase() })}
          </label>
        </div>
      ) : null}
      {error ? <p className="mt-2 text-sm text-failed-text">{t("chat.approval.failed", { error })}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {decided ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink">
            <StatusShape status={item.decision === "denied" ? "failed" : "done"} size={10} />
            {t(item.decision === "denied" ? "chat.approval.denied" : item.decision === "edited" ? "chat.approval.edited" : "chat.approval.approved")}
          </span>
        ) : !handlers.canEdit ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-muted">
            <Lock className="size-3.5" aria-hidden />
            {t("chat.composer.viewer")}
          </span>
        ) : editing ? (
          <>
            <button type="button" onClick={() => setEditing(false)} disabled={!!busy} className={aosButton({ variant: "quiet", size: "sm" })}>
              {t("chat.approval.cancelEdit")}
            </button>
            <button type="button" onClick={saveEdit} disabled={!!busy} className={aosButton({ variant: "approve", size: "sm", className: "ml-auto" })}>
              <Check className="size-4" aria-hidden />
              {busy === "approve" ? t("chat.approval.deciding") : t("chat.approval.saveEdit")}
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => void send("deny")} disabled={!!busy} className={aosButton({ variant: "deny", size: "sm" })} data-decision="deny">
              {busy === "deny" ? t("chat.approval.deciding") : t("chat.approval.deny")}
            </button>
            <button type="button" onClick={() => setEditing(true)} disabled={!!busy} className={aosButton({ variant: "quiet", size: "sm" })} data-decision="edit">
              {t("chat.approval.edit")}
            </button>
            <button type="button" onClick={() => void send("approve")} disabled={!!busy} className={aosButton({ variant: "approve", size: "sm", className: "ml-auto" })} data-decision="approve">
              <Check className="size-4" aria-hidden />
              {busy === "approve" ? t("chat.approval.deciding") : t("chat.approval.approve")}
            </button>
          </>
        )}
      </div>
    </li>
  );
}

export function ApprovalBlock({ block, handlers }: { block: ApprovalBlockModel; handlers: ApprovalHandlers }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<DecisionKind | null>(null);
  const pending = block.items.filter((i) => i.decision === "pending");
  const agentKeys = [...new Set(block.items.map((i) => (i.agentKey && isAgentKey(i.agentKey) ? i.agentKey : "lead")))];
  const agentName = agentKeys.length === 1 ? agentDisplayName(agentKeys[0]!) : agentKeys.map(agentDisplayName).join(", ");
  const approveAll = async () => {
    setBusy("approve");
    await handlers.decide(pending.map((i) => ({ toolUseId: i.toolUseId, toolCallId: i.toolCallId, tool: i.tool, decision: "approve" as const })));
    setBusy(null);
  };
  return (
    <article className="overflow-hidden rounded-lg bg-paper shadow-hairline" aria-label={t("chat.approval.title")} data-approval-block={block.id}>
      <header className="flex h-11 shrink-0 items-center gap-2.5 bg-needs px-4 text-sm font-semibold text-ink">
        <StatusShape status="needs" size={12} tone="inherit" label={t("chat.approval.title")} />
        <span className="flex-1 truncate">{t("chat.approval.title")}</span>
        <span className="max-w-[45%] truncate">{agentName}</span>
      </header>
      <ul className="divide-y divide-line">
        {block.items.map((item) => (
          <Item key={item.toolUseId ?? item.toolCallId} item={item} agent={item.agentKey && isAgentKey(item.agentKey) ? agentDisplayName(item.agentKey) : agentName} handlers={handlers} busy={busy} onBusy={setBusy} />
        ))}
      </ul>
      {pending.length > 1 && handlers.canEdit ? (
        <footer className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <span className="text-xs text-muted">{t("chat.approval.keys")}</span>
          <button type="button" onClick={() => void approveAll()} disabled={!!busy} className={aosButton({ variant: "approve", size: "sm" })}>
            <Check className="size-4" aria-hidden />
            {t("chat.approval.approveAll", { n: pending.length })}
          </button>
        </footer>
      ) : pending.length === 1 && handlers.canEdit ? (
        <footer className="border-t border-line px-5 py-2 text-xs text-muted">{t("chat.approval.keys")}</footer>
      ) : null}
    </article>
  );
}

export default ApprovalBlock;
