// Marketr — Wave 2 ChatGPT Ads slice 3: pause + auto-pause controls (client).

"use client";

import { useState } from "react";
import { Loader2, Pause, ShieldAlert } from "lucide-react";

const btnGhost =
  "flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 hover:bg-stone-50 disabled:opacity-40";

export default function PauseControls({ campaignId }: { campaignId: string }) {
  const [busy, setBusy] = useState<"pause" | "check" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  async function call(path: string, kind: "pause" | "check") {
    setBusy(kind);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/ads/chatgpt/campaigns/${campaignId}/${path}`, { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; error?: string; paused?: boolean; reason?: string | null };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Action failed");
        return;
      }
      if (kind === "pause") {
        setPaused(true);
        setMessage("Campaign paused on StackAdapt. Resume by proposing a new launch.");
      } else {
        setMessage(
          data.paused
            ? `Auto-pause fired: ${data.reason ?? "spend breached the daily cap"}`
            : "Spend check passed — under the cap, no action taken.",
        );
        if (data.paused) setPaused(true);
      }
    } catch {
      setError("Action failed");
    } finally {
      setBusy(null);
    }
  }

  if (paused) {
    return <p className="text-[13px] text-stone-500">Paused. {message}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button type="button" className={btnGhost} disabled={busy !== null} onClick={() => call("pause", "pause")}>
          {busy === "pause" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pause className="h-3.5 w-3.5" />}
          Pause now
        </button>
        <button type="button" className={btnGhost} disabled={busy !== null} onClick={() => call("auto-pause-check", "check")}>
          {busy === "check" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldAlert className="h-3.5 w-3.5" />}
          Run spend check
        </button>
      </div>
      {message && (
        <p className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-[13px] text-stone-600">{message}</p>
      )}
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>
      )}
      <p className="text-[12px] text-stone-500">
        The spend check auto-pauses when today&apos;s spend exceeds the daily cap by more than 10%.
      </p>
    </div>
  );
}
