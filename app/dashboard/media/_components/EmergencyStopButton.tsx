// Marketr — Media command center: emergency stop (fenced, owner-only).

"use client";

import { useState } from "react";
import { Button } from "@/components/vault/shadcn/button";
import { Input } from "@/components/vault/shadcn/input";
import { Textarea } from "@/components/vault/shadcn/textarea";

export default function EmergencyStopButton({ mediaRole }: { mediaRole: string }) {
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  if (mediaRole !== "owner") return null;

  async function fire() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/media/emergency-stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Emergency stop failed");
      setResult(
        `Stopped: ${data.entitiesPaused} entities paused, ${data.approvalsRevoked.length} approvals revoked, ${data.poolsFrozen.length} pools frozen.`,
      );
      setOpen(false);
    } catch (e) {
      setResult(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <Button variant="destructive" onClick={() => setOpen((v) => !v)}>
        Emergency stop
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 rounded-xl border border-red-200 bg-white p-4 shadow-xl">
          <p className="text-sm font-semibold text-red-900">Emergency stop</p>
          <p className="mt-1 text-xs text-stone-500">
            Pauses every active entity for the client across all platforms, revokes pending
            approvals, freezes all pools, and exports the audit trail. Requires a written reason.
          </p>
          <Input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="Client ID"
            className="mt-3"
          />
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Written reason (min 8 chars)"
            rows={3}
            className="mt-2"
          />
          <Button
            variant="destructive"
            onClick={fire}
            disabled={busy || clientId.trim().length === 0 || reason.trim().length < 8}
            className="mt-3 w-full"
          >
            {busy ? "Stopping…" : "Confirm emergency stop"}
          </Button>
        </div>
      )}
      {result && <p className="mt-2 max-w-xs text-xs text-stone-600">{result}</p>}
    </div>
  );
}
