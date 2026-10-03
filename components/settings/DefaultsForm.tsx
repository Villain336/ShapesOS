// Marketr — workspace defaults form (milestone 21, part D1).
// Client component: defaultModel, defaultApprovalMode, agentAllowList,
// saved via PUT workspace settings. Projects inherit these unless overridden.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Check } from "lucide-react";

// AOS atoms (local — components/settings/ui.tsx is owned by another slice).
const cardCls = "rounded-xl border border-line bg-paper p-5";
const labelCls = "mb-1 block text-xs font-medium text-muted";
const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";

type NoticeKind = "ok" | "error" | "info";
interface NoticeState {
  kind: NoticeKind;
  message: string;
}

function Notice({ notice }: { notice: NoticeState | null }) {
  if (!notice) return null;
  if (notice.kind === "error") {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text"
      >
        <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
        <span>{notice.message}</span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-line bg-paper px-3 py-2 text-sm text-muted">
      <Check size={14} className="mt-0.5 shrink-0 text-ink" aria-hidden="true" />
      <span>{notice.message}</span>
    </div>
  );
}

const APPROVAL_MODES = ["supervised", "scheduled", "manual"] as const;

export default function DefaultsForm({ workspaceId }: { workspaceId: string }) {
  const [model, setModel] = useState("");
  const [approvalMode, setApprovalMode] = useState<(typeof APPROVAL_MODES)[number]>("supervised");
  const [allowList, setAllowList] = useState("");
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;

  const load = useCallback(async () => {
    const r = await fetch(`/api/settings/workspace?${q}`);
    if (r.ok) {
      const j = await r.json();
      const s = j.settings ?? {};
      setModel(s.defaultModel ?? "");
      if (APPROVAL_MODES.includes(s.defaultApprovalMode)) {
        setApprovalMode(s.defaultApprovalMode);
      }
      const list = Array.isArray(s.agentAllowList) ? s.agentAllowList : [];
      setAllowList(list.join(", "));
    }
    setLoaded(true);
  }, [q]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      const agentAllowList = allowList
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const r = await fetch("/api/settings/workspace", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          defaultModel: model.trim() || null,
          defaultApprovalMode: approvalMode,
          agentAllowList,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice({
          kind: "error",
          message: typeof j.error === "string" ? j.error : "Save failed.",
        });
        return;
      }
      const s = j.settings ?? {};
      setModel(s.defaultModel ?? "");
      if (APPROVAL_MODES.includes(s.defaultApprovalMode)) {
        setApprovalMode(s.defaultApprovalMode);
      }
      const list = Array.isArray(s.agentAllowList) ? s.agentAllowList : [];
      setAllowList(list.join(", "));
      setNotice({ kind: "ok", message: "Workspace defaults saved." });
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="flex flex-col gap-4">
      <Notice notice={notice} />
      <div className={cardCls}>
        <h2 className="font-medium text-ink">Workspace defaults</h2>
        <p className="mt-1 text-sm text-muted">
          Inherited by every project. A project can override any of these in its
          own settings without affecting the rest of the workspace.
        </p>
        <div className="mt-4 flex max-w-xl flex-col gap-3">
          <label className={labelCls}>
            Default model
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. gpt-4o-mini"
              className={`${inputCls} mt-1 w-full font-mono text-xs`}
            />
          </label>
          <label className={labelCls}>
            Default approval mode
            <select
              value={approvalMode}
              onChange={(e) =>
                setApprovalMode(e.target.value as (typeof APPROVAL_MODES)[number])
              }
              className={`${inputCls} mt-1 w-full`}
            >
              {APPROVAL_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-subtle">
              supervised: agent proposes, human approves · scheduled: runs on a
              schedule · manual: nothing runs without explicit approval.
            </span>
          </label>
          <label className={labelCls}>
            Agent tool allow-list (comma-separated namespaces)
            <input
              type="text"
              value={allowList}
              onChange={(e) => setAllowList(e.target.value)}
              placeholder="seo, content, connectors"
              className={`${inputCls} mt-1 w-full font-mono text-xs`}
            />
            <span className="mt-1 block text-xs text-subtle">
              Which tool namespaces the ShapesOS agent may use. Leave empty to
              allow all.
            </span>
          </label>
        </div>
        <div className="mt-4">
          <button onClick={save} disabled={busy} className={btnPrimary}>
            {busy ? "Saving…" : "Save defaults"}
          </button>
        </div>
      </div>
    </div>
  );
}
