// Marketr — Approval actions: submit / approve (OTP for high-value) / execute / revoke.
// The executor re-verifies everything at checkout; HALT keeps status "approved".

"use client";

import { useState } from "react";
import { Button } from "@/components/vault/shadcn/button";
import { Input } from "@/components/vault/shadcn/input";

export default function ApprovalActions({
  approvalId,
  status,
  mediaRole,
}: {
  approvalId: string;
  status: string;
  mediaRole: string;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [otp, setOtp] = useState<string | null>(null);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState("");
  const [showOtp, setShowOtp] = useState(false);
  const [revokeReason, setRevokeReason] = useState("");
  const [showRevoke, setShowRevoke] = useState(false);

  async function call(path: string, method: string, body?: unknown) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `${method} failed`);
      window.location.reload();
      return data;
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function mintOtp() {
    const data = await call(`/api/media/approvals/${approvalId}/otp`, "POST", {});
    if (data) {
      setChallengeId(data.challengeId);
      setOtp(data.code ?? null);
      setShowOtp(true);
    }
  }

  async function approve() {
    await call(`/api/media/approvals/${approvalId}/approve`, "POST", {
      method: otp ? "otp" : "sso",
      ...(otp ? { otpChallengeId: challengeId, otpCode } : {}),
    });
  }

  const canAct = mediaRole === "owner";

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        {status === "draft" && (
          <Button onClick={() => call(`/api/media/approvals/${approvalId}/submit`, "POST", {})} disabled={busy}>
            Submit for approval
          </Button>
        )}
        {status === "pending" && canAct && (
          <>
            <Button variant="outline" onClick={mintOtp} disabled={busy}>
              Mint OTP
            </Button>
            <Button onClick={approve} disabled={busy || (showOtp && otpCode.trim().length === 0)}>
              Approve{showOtp ? " with OTP" : ""}
            </Button>
            <Button variant="destructive" onClick={() => setShowRevoke((v) => !v)} disabled={busy}>
              Revoke
            </Button>
          </>
        )}
        {status === "approved" && canAct && (
          <Button onClick={() => call(`/api/media/buys/${approvalId}/execute`, "POST", {})} disabled={busy}>
            Run pre-flight + execute
          </Button>
        )}
      </div>

      {showOtp && otp && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <p className="font-semibold">Test-mode OTP: <span className="font-mono text-base">{otp}</span></p>
          <Input
            value={otpCode}
            onChange={(e) => setOtpCode(e.target.value)}
            placeholder="Enter OTP code"
            className="mt-2"
          />
          <p className="mt-1">Production delivers the code out-of-band (authenticator/SMS).</p>
        </div>
      )}

      {showRevoke && (
        <div className="flex gap-2">
          <Input
            value={revokeReason}
            onChange={(e) => setRevokeReason(e.target.value)}
            placeholder="Revocation reason"
          />
          <Button
            variant="destructive"
            onClick={() => revokeReason.trim() && call(`/api/media/approvals/${approvalId}/revoke`, "POST", { reason: revokeReason })}
            disabled={busy || !revokeReason.trim()}
          >
            Confirm revoke
          </Button>
        </div>
      )}

      {status === "pending" && !canAct && (
        <p className="text-xs text-stone-500">Buyers propose — an owner must approve.</p>
      )}
      {msg && <p className="max-w-xs text-right text-xs text-red-700">{msg}</p>}
    </div>
  );
}
