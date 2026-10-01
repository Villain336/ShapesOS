// Marketr — Phase 18 slice 4: CSV spend import form.

"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { CircleCheck, Upload, Loader2, FileUp } from "lucide-react";
import type { GuidedAccountOption } from "./RegisterCampaignForm";

interface ImportResult {
  ok?: boolean;
  error?: string;
  code?: string;
  batchId?: string;
  upserted?: number;
  skippedNoCampaign?: number;
}

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimarySm =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnSecondarySm =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper";

export default function CsvImportForm({
  accounts,
  template,
}: {
  accounts: GuidedAccountOption[];
  template: string;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [csv, setCsv] = useState(template);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ""));
    reader.readAsText(f);
  }

  async function submit() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/ads/guided/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, csv }),
      });
      const data = (await res.json()) as ImportResult;
      setResult(data);
    } catch {
      setResult({ error: "Could not import the CSV" });
    } finally {
      setBusy(false);
    }
  }

  if (accounts.length === 0) {
    return (
      <p className="rounded-lg bg-paper px-3 py-2 text-sm text-muted shadow-hairline">
        Link an advertiser account above first — imports need an account to attach to.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-paper px-3 py-3 shadow-hairline">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs font-semibold text-muted">
          Advertiser account
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className={inputCls}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name ?? a.externalAccountId} ({a.externalAccountId})
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className={btnSecondarySm}
        >
          <FileUp className="h-3.5 w-3.5" />
          Upload CSV
        </button>
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
      </div>
      <textarea
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        rows={6}
        spellCheck={false}
        className="w-full rounded-md border-[1.5px] border-control bg-paper px-3 py-2 font-mono text-xs text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none"
      />
      <p className="text-xs text-subtle">
        Columns: campaign_external_id, date (YYYY-MM-DD), spend_cents, impressions, clicks, conversions,
        revenue_cents. Money in cents, no negatives.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !accountId || !csv.trim()}
          className={btnPrimarySm}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {busy ? "Importing…" : "Import spend"}
        </button>
      </div>
      {result && result.ok && (
        <p className="flex items-start gap-2 rounded-lg bg-paper px-3 py-2 text-sm text-ink shadow-hairline">
          <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Imported {result.upserted} row{result.upserted === 1 ? "" : "s"} (batch{" "}
            <span className="font-mono text-2xs">{result.batchId?.slice(0, 8)}…</span>
            {result.skippedNoCampaign ? `, ${result.skippedNoCampaign} skipped — no registered campaign matched` : ""}).
          </span>
        </p>
      )}
      {result && !result.ok && (
        <p className="rounded-lg border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">
          {result.error ?? "Import failed"}
          {result.code ? <span className="ml-1 font-mono text-2xs">({result.code})</span> : null}
        </p>
      )}
    </div>
  );
}
