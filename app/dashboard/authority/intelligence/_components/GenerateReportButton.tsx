// Marketr — I1 "Generate report" action (client).
// POST /api/authority/intelligence/reports → navigates to the new report.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileSearch, Loader2 } from "lucide-react";
import { Button } from "@/components/vault/shadcn/button";

export function GenerateReportButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/authority/intelligence/reports", { method: "POST" });
      const data = (await res.json()) as {
        error?: string;
        report?: { id: string };
        opportunityCount?: number;
        initiativeCount?: number;
        completeness?: Record<string, string>;
      };
      if (!res.ok) throw new Error(data.error ?? "Report generation failed");
      if (!data.report?.id) throw new Error("No report id returned");
      router.push(`/dashboard/authority/intelligence?id=${data.report.id}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button type="button" onClick={generate} disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : <FileSearch />}
        {busy ? "Compiling twelve audits…" : "Generate report"}
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
