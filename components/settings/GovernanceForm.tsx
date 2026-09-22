// Marketr — data governance settings form (milestone 21, part D1).
// Client component: friendly controls over the dataGovernance JSON blob
// (retention days + analytics/sharing flags), saved via PUT workspace settings.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Notice,
  cardCls,
  inputCls,
  labelCls,
  primaryBtnCls,
  type NoticeState,
} from "./ui";

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
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 accent-[#0E7C66]"
      />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-zinc-500">{hint}</span>
      </span>
    </label>
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

  if (!loaded) return <p className="text-sm text-zinc-500">Loading…</p>;

  return (
    <div className="flex flex-col gap-4">
      <Notice notice={notice} />
      <div className={cardCls}>
        <h2 className="font-medium">Data retention & sharing</h2>
        <p className="mt-1 text-sm text-zinc-500">
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
          <button onClick={save} disabled={busy} className={primaryBtnCls}>
            {busy ? "Saving…" : "Save governance settings"}
          </button>
        </div>
      </div>
      <details className={cardCls}>
        <summary className="cursor-pointer text-sm font-medium">
          Stored JSON (read-only preview)
        </summary>
        <pre className="mt-2 overflow-x-auto rounded-md bg-zinc-50 p-3 font-mono text-xs text-zinc-600">
          {JSON.stringify(gov, null, 2)}
        </pre>
      </details>
    </div>
  );
}
