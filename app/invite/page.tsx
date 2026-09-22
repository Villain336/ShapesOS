// Marketr — invite landing page (day-1 hardening, M5).
// /invite?token=… — the recipient opens the invite link, signs in if needed,
// then accepts the single-use token invite into the workspace.

"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

function InviteBody() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);

  const accept = useCallback(async () => {
    if (!token) {
      setState("error");
      setMessage("This invite link is missing its token.");
      return;
    }
    setState("working");
    try {
      const r = await fetch("/api/workspace/invites/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Day-1: preserve the token through sign-in — send the user to the
        // login page with a safe `next` back to this exact invite URL so the
        // accept is retried automatically after authentication.
        if (r.status === 401 && token) {
          window.location.href = `/login?next=${encodeURIComponent(`/invite?token=${token}`)}`;
          return;
        }
        setState("error");
        setMessage(j.error ?? "Invite could not be accepted.");
        return;
      }
      setState("done");
      setWorkspaceName(j.workspaceName ?? null);
    } catch {
      setState("error");
      setMessage("Network error — please try again.");
    }
  }, [token]);

  useEffect(() => {
    accept();
  }, [accept]);

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
      <h1 className="text-xl font-semibold text-zinc-100">Workspace invite</h1>
      {state === "working" || state === "idle" ? (
        <p className="mt-3 text-sm text-zinc-400">Accepting your invite…</p>
      ) : state === "done" ? (
        <div className="mt-3">
          <p className="text-sm text-emerald-300">
            You&apos;re in{workspaceName ? ` — welcome to ${workspaceName}` : ""}!
          </p>
          <a
            href="/dashboard"
            className="mt-4 inline-block rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-700"
          >
            Go to dashboard
          </a>
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-sm text-red-300">{message}</p>
          <p className="mt-2 text-xs text-zinc-500">
            Invite links are single-use and expire after 7 days. Ask your admin
            for a fresh link.
          </p>
          <a
            href="/login"
            className="mt-4 inline-block rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-700"
          >
            Back to sign-in
          </a>
        </div>
      )}
    </div>
  );
}

export default function InvitePage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-sm text-zinc-400">Loading…</div>}>
      <InviteBody />
    </Suspense>
  );
}
