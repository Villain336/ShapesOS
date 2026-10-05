// Marketr — Phase 14 slice 7: "Open in Sheets" button (client).
//
// Drops any dense table's data into a host-owned Univer sheet and navigates
// to the Office surface with the new doc open. Used by the analytics home,
// the social content calendar, and lead/prospect tables.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileSpreadsheet, Loader2 } from "lucide-react";
import { buildSheetSnapshot } from "@/lib/univer/snapshots";

export interface OpenInSheetsButtonProps {
  /** Sheet title, e.g. "Analytics — last 30 days". */
  title: string;
  headers: string[];
  rows: (string | number | null)[][];
  /** Provenance, e.g. "analytics:overview", "social:calendar". */
  sourceRef?: string;
  sheetName?: string;
  label?: string;
  className?: string;
}

export function OpenInSheetsButton({
  title,
  headers,
  rows,
  sourceRef,
  sheetName,
  label = "Open as sheet",
  className,
}: OpenInSheetsButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    try {
      const snapshot = buildSheetSnapshot({ title, headers, rows, sheetName });
      const res = await fetch("/api/office/docs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "sheet",
          title,
          snapshot,
          ...(sourceRef ? { sourceRef } : {}),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { doc?: { id?: string } };
      const id = data.doc?.id;
      router.push(id ? `/dashboard/office?open=${encodeURIComponent(id)}` : "/dashboard/office");
    } catch (e) {
      console.error("[office] open-as-sheet failed", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      className={
        className ??
        "inline-flex h-control-sm items-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-4 text-[13px] font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:cursor-not-allowed disabled:opacity-40"
      }
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
      {busy ? "Creating sheet…" : label}
    </button>
  );
}
