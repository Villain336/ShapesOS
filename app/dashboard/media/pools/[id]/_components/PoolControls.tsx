// Marketr — Pool controls: freeze + attach virtual card (owner-only).

"use client";

import { useState } from "react";
import { Button } from "@/components/vault/shadcn/button";
import { Input } from "@/components/vault/shadcn/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/vault/shadcn/select";

export default function PoolControls({
  poolId,
  status,
  mediaRole,
  hasCard,
}: {
  poolId: string;
  status: string;
  mediaRole: string;
  hasCard: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showCard, setShowCard] = useState(false);
  const [provider, setProvider] = useState("fake");
  const [accountRef, setAccountRef] = useState("");

  if (mediaRole !== "owner") return null;

  async function call(path: string, body?: unknown) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      window.location.reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        {status === "active" && (
          <Button
            variant="outline"
            onClick={() => call(`/api/media/pools/${poolId}/freeze`, { reason: "manual freeze from pool page" })}
            disabled={busy}
          >
            Freeze pool
          </Button>
        )}
        {!hasCard && (
          <Button onClick={() => setShowCard((v) => !v)} disabled={busy}>
            Attach virtual card
          </Button>
        )}
      </div>
      {showCard && (
        <div className="w-72 rounded-xl border border-stone-200 bg-white p-3 shadow-lg">
          <p className="text-xs font-semibold text-stone-900">Client&apos;s virtual card</p>
          <p className="mt-0.5 text-[11px] text-stone-500">
            Issued on the client&apos;s own account — never the agency&apos;s. Limit = pool cap.
          </p>
          <Select value={provider} onValueChange={(v) => setProvider(v ?? "fake")}>
            <SelectTrigger className="mt-2 w-full">
              <SelectValue placeholder="Provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fake">Fake (test default)</SelectItem>
              <SelectItem value="brex">Brex (test mode)</SelectItem>
              <SelectItem value="ramp">Ramp (test mode)</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={accountRef}
            onChange={(e) => setAccountRef(e.target.value)}
            placeholder="Client's Brex/Ramp account ref"
            className="mt-2"
          />
          <Button
            onClick={() => accountRef.trim() && call(`/api/media/pools/${poolId}/virtual-card`, { provider, providerAccountRef: accountRef })}
            disabled={busy || !accountRef.trim()}
            className="mt-2 w-full"
          >
            Issue card
          </Button>
        </div>
      )}
      {msg && <p className="max-w-xs text-right text-xs text-red-700">{msg}</p>}
    </div>
  );
}
