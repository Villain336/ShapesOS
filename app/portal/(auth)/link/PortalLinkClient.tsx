"use client";

// ShapesOS — Phase 10 (portal): redeem an emailed client-portal link through
// POST /api/portal/link, which sets the portal session cookie (scoped to
// /portal and /api/portal — never a workspace session).

import Link from "next/link";
import { useState } from "react";
import { Loader2, LogIn } from "lucide-react";
import { FieldMessage, aosButton } from "@/components/aos";
import { AuthShell } from "@/components/auth/AuthShell";
import { useLinkToken } from "@/components/auth/client";

export default function PortalLinkClient() {
  const token = useLinkToken();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onContinue() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        window.location.href = "/portal";
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(res.status === 429 ? "Too many attempts. Wait a while, then try again." : (data.error ?? "This link has already been used or has expired. Ask for a new one."));
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <h1 className="aos-heading">Open your client portal</h1>
      {token === null ? (
        <>
          <p className="mt-2 text-sm text-muted">This link is missing its code. Open the link from your email again, or ask for a new one.</p>
          <Link href="/portal/login" className={aosButton({ variant: "secondary", className: "mt-6 w-full" })}>
            Ask for a new link
          </Link>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted">Continue to sign in. The link works once.</p>
          <button type="button" onClick={onContinue} disabled={!token || busy || !!error} className={aosButton({ className: "mt-6 w-full" })}>
            {busy ? <Loader2 className="size-4 aos-spin" aria-hidden="true" /> : <LogIn className="size-4" aria-hidden="true" />}
            {busy ? "Signing in" : "Continue"}
          </button>
          {error && (
            <div className="mt-4 flex flex-col gap-3">
              <FieldMessage id="portal-link-error" error={error} />
              <Link href="/portal/login" className={aosButton({ variant: "secondary", className: "w-full" })}>
                Ask for a new link
              </Link>
            </div>
          )}
        </>
      )}
    </AuthShell>
  );
}
