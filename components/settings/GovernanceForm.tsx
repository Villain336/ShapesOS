// Marketr — data governance settings form (milestone 21, part D1).
// Client component: friendly controls over the dataGovernance JSON blob
// (retention days + analytics/sharing flags), saved via PUT workspace settings.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Check } from "lucide-react";

// AOS atoms (local — components/settings/ui.tsx is owned by another slice).
const cardCls = "rounded-xl border border-line bg-paper p-5";
const labelCls = "mb-1 block text-xs font-medium text-muted";
const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-40";

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

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors ${
        checked ? "bg-ink" : "bg-disabled-fg"
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-[3px] h-5 w-5 rounded-full bg-white shadow transition-all ${
          checked ? "left-[21px]" : "left-[3px]"
        }`}
      />
    </button>
  );
}

interface Governance {
  retentionDays: number;
  analyticsEnabled: boolean;
  shareWithVendors: boolean;
  deleteOnRequest: boolean;
}

const DEFAULTS: Governance = {
  retentionDays: 365,
  analyticsEnabled: false,
  shareWithVendors: false,
  deleteOnRequest: true,
};

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-line bg-paper px-3 py-3">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

export default function GovernanceForm({ workspaceId }: { workspaceId: string }) {
  const [gov, setGov] = useState<Governance>(DEFAULTS);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;

  const load = useCallback(async () => {
    const r = await fetch(`/api/settings/workspace?${q}`);
    if (r.ok) {
      const j = await r.json();
      const g = (j.settings?.dataGovernance ?? {}) as Partial<Governance>;
      setGov({ ...DEFAULTS, ...g });
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
      const r = await fetch("/api/settings/workspace", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, dataGovernance: gov }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice({
          kind: "error",
          message: typeof j.error === "string" ? j.error : "Save failed.",
        });
        return;
      }
      const g = (j.settings?.dataGovernance ?? {}) as Partial<Governance>;
      setGov({ ...DEFAULTS, ...g });
      setNotice({ kind: "ok", message: "Governance settings saved." });
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="flex flex-col gap-4">
      <Notice notice={notice} />
      <div className={cardCls}>
        <h2 className="font-medium text-ink">Data retention & sharing</h2>
        <p className="mt-1 text-sm text-muted">
          These workspace defaults are inherited by every project and stored as
          structured JSON.
        </p>
        <div className="mt-4 max-w-sm">
          <label className={labelCls}>
            Data retention (days)
            <input
              type="number"
              min={1}
              value={gov.retentionDays}
              onChange={(e) =>
                setGov({ ...gov, retentionDays: Math.max(1, Number(e.target.value) || 1) })
              }
              className={`${inputCls} mt-1 w-full`}
            />
          </label>
        </div>
        <div className="mt-4 flex max-w-xl flex-col gap-2">
          <Toggle
            checked={gov.analyticsEnabled}
            onChange={(v) => setGov({ ...gov, analyticsEnabled: v })}
            label="Usage analytics"
            hint="Allow aggregated, anonymized usage analytics for this workspace."
          />
          <Toggle
            checked={gov.shareWithVendors}
            onChange={(v) => setGov({ ...gov, shareWithVendors: v })}
            label="Vendor sharing"
            hint="Allow sharing workspace data with connected third-party vendors."
          />
          <Toggle
            checked={gov.deleteOnRequest}
            onChange={(v) => setGov({ ...gov, deleteOnRequest: v })}
            label="Delete on request"
            hint="Honor member data-deletion requests automatically where possible."
          />
        </div>
        <div className="mt-4">
          <button onClick={save} disabled={busy} className={btnPrimary}>
            {busy ? "Saving…" : "Save governance settings"}
          </button>
        </div>
      </div>
      <details className={cardCls}>
        <summary className="cursor-pointer text-sm font-medium text-ink">
          Stored JSON (read-only preview)
        </summary>
        <pre className="mt-2 overflow-x-auto rounded-md bg-canvas p-3 font-mono text-xs text-muted">
          {JSON.stringify(gov, null, 2)}
        </pre>
      </details>
    </div>
  );
}
