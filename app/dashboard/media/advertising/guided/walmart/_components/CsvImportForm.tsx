// Marketr — Phase 18 slice 4: CSV spend import form.

"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { Upload, Loader2, FileUp } from "lucide-react";
import type { GuidedAccountOption } from "./RegisterCampaignForm";

interface ImportResult {
  ok?: boolean;
  error?: string;
  code?: string;
  batchId?: string;
  upserted?: number;
  skippedNoCampaign?: number;
}

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
      <p className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-[13px] text-stone-500">
        Link an advertiser account above first — imports need an account to attach to.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-[12px] text-stone-600">
          Advertiser account
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="rounded-md border border-stone-300 px-2.5 py-1.5 text-[13px] text-stone-900 focus:border-[var(--brand-600)] focus:outline-none"
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
          className="inline-flex items-center gap-1.5 rounded-md border border-stone-300 px-3 py-1.5 text-[12px] font-medium text-stone-700 hover:bg-stone-50"
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
        className="w-full rounded-md border border-stone-300 px-2.5 py-2 font-mono text-[12px] text-stone-900 focus:border-[var(--brand-600)] focus:outline-none"
      />
      <p className="text-[11px] text-stone-400">
        Columns: campaign_external_id, date (YYYY-MM-DD), spend_cents, impressions, clicks, conversions,
        revenue_cents. Money in cents, no negatives.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !accountId || !csv.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {busy ? "Importing…" : "Import spend"}
        </button>
      </div>
      {result && result.ok && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-800">
          Imported {result.upserted} row{result.upserted === 1 ? "" : "s"} (batch{" "}
          <span className="font-mono text-[11px]">{result.batchId?.slice(0, 8)}…</span>
          {result.skippedNoCampaign ? `, ${result.skippedNoCampaign} skipped — no registered campaign matched` : ""}).
        </p>
      )}
      {result && !result.ok && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {result.error ?? "Import failed"}
          {result.code ? <span className="ml-1 font-mono text-[11px]">({result.code})</span> : null}
        </p>
      )}
    </div>
  );
}
