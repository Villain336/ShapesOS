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
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState("");
  const [showOtp, setShowOtp] = useState(false);
  const [revokeReason, setRevokeReason] = useState("");
  const [showRevoke, setShowRevoke] = useState(false);

  async function call(path: string, method: string, body?: unknown, reload = true) {
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
      if (reload) window.location.reload();
      return data;
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function mintOtp() {
    // The code is emailed to you (dev servers without SMTP print it to the
    // server console); it is never returned by the API.
    const data = await call(`/api/media/approvals/${approvalId}/otp`, "POST", {}, false);
    if (data) {
      setChallengeId(data.challengeId);
      setOtpCode("");
      setShowOtp(true);
    }
  }

  async function approve() {
    await call(`/api/media/approvals/${approvalId}/approve`, "POST", {
      method: challengeId ? "otp" : "sso",
      ...(challengeId ? { otpChallengeId: challengeId, otpCode } : {}),
    });
  }

  const canAct = mediaRole === "owner";

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        {status === "draft" && (
          <Button className="bg-ink text-white aos-press" onClick={() => call(`/api/media/approvals/${approvalId}/submit`, "POST", {})} disabled={busy}>
            Submit for approval
          </Button>
        )}
        {status === "pending" && canAct && (
          <>
            <Button variant="outline" className="rounded-full border border-line bg-paper text-ink shadow-outline hover:bg-hover-paper" onClick={mintOtp} disabled={busy}>
              Email me a code
            </Button>
            <Button className="bg-done text-white aos-press" onClick={approve} disabled={busy || (showOtp && otpCode.trim().length === 0)}>
              Approve{showOtp ? " with code" : ""}
            </Button>
            <Button variant="destructive" onClick={() => setShowRevoke((v) => !v)} disabled={busy}>
              Revoke
            </Button>
          </>
        )}
        {status === "approved" && canAct && (
          <Button className="bg-running text-white aos-press" onClick={() => call(`/api/media/buys/${approvalId}/execute`, "POST", {})} disabled={busy}>
            Run pre-flight + execute
          </Button>
        )}
      </div>

      {showOtp && (
        <div className="rounded-lg border border-line bg-paper p-3 text-xs text-ink shadow-hairline">
          <p className="font-semibold">We emailed you a 6-digit approval code.</p>
          <Input
            value={otpCode}
            onChange={(e) => setOtpCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="Enter the code"
            className="mt-2 rounded-md border border-line bg-paper px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-focus focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus:outline-none"
          />
          <p className="mt-1 text-muted">It works once, for this buy and for you, and expires in 10 minutes.</p>
        </div>
      )}

      {showRevoke && (
        <div className="flex gap-2">
          <Input
            value={revokeReason}
            onChange={(e) => setRevokeReason(e.target.value)}
            placeholder="Revocation reason"
            className="rounded-md border border-line bg-paper px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-focus focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus:outline-none"
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
        <p className="text-xs text-muted">Buyers propose — an owner must approve.</p>
      )}
      {msg && <p className="max-w-xs text-right text-xs text-failed-text">{msg}</p>}
    </div>
  );
}
