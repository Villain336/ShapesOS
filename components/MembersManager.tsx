// Marketr — workspace members manager (milestone 11: RBAC).
// Client component: list members, invite by email, change roles, remove.

"use client";

import { useCallback, useEffect, useState } from "react";

// AOS atoms (local — components/settings/ui.tsx is owned by another slice).
const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const btnDeny =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint disabled:opacity-40";
const chipCls =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted shadow-control";

interface Member {
  id: string;
  email: string | null;
  name: string | null;
  role: "owner" | "admin" | "editor" | "viewer";
  pending: boolean;
  createdAt: string;
}

const ROLES = ["owner", "admin", "editor", "viewer"] as const;

export default function MembersManager({ myRole }: { myRole: string }) {
  // Mirrors the server rule (lib/authz.ts memberChangeError): nobody grants
  // above their own role, and only owners touch owner rows.
  const myIndex = ROLES.indexOf(myRole as (typeof ROLES)[number]);
  const grantable = ROLES.filter((_, i) => myIndex >= 0 && i >= myIndex);
  const isOwner = myRole === "owner";
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("editor");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  // Phase 3: invites are emailed when the deployment has mail set up.
  const [inviteEmail, setInviteEmail] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ emailed: boolean; to: string; note?: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [resent, setResent] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/workspace/members");
    if (r.ok) {
      const j = await r.json();
      setMembers(j.members ?? []);
      setInviteEmail(j.inviteEmail === true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function invite() {
    setError(null);
    setInviteUrl(null);
    setInviteResult(null);
    setBusy(true);
    try {
      const r = await fetch("/api/workspace/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error ?? "Invite failed.");
        return;
      }
      if (j.inviteUrl) setInviteUrl(j.inviteUrl);
      setInviteResult({ emailed: j.emailed === true, to: email, note: j.emailNote });
      setEmail("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function copyInviteLink(id: string) {
    setError(null);
    try {
      const r = await fetch(`/api/workspace/members/${id}/invite-link`, {
        method: "POST",
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.inviteUrl) {
        setError(j.error ?? "Could not generate invite link.");
        return;
      }
      await navigator.clipboard.writeText(
        new URL(j.inviteUrl, window.location.origin).toString(),
      );
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Could not copy invite link.");
    }
  }

  async function emailInviteAgain(id: string) {
    setError(null);
    const r = await fetch(`/api/workspace/members/${id}/invite-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: true }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(j.error ?? "Could not send the invite.");
      return;
    }
    if (!j.emailed) {
      setError(j.emailNote ?? "The invite email didn't go out. Copy the invite link instead.");
      return;
    }
    setResent(id);
    setTimeout(() => setResent(null), 2000);
  }

  async function changeRole(id: string, newRole: string) {
    setError(null);
    const r = await fetch(`/api/workspace/members/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) setError(j.error ?? "Role change failed.");
    await load();
  }

  async function remove(id: string) {
    if (!confirm("Remove this member from the workspace?")) return;
    setError(null);
    const r = await fetch(`/api/workspace/members/${id}`, { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) setError(j.error ?? "Remove failed.");
    await load();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-line bg-paper p-5">
        <h2 className="text-sm font-medium text-ink">Invite a teammate</h2>
        <p className="mt-1 text-xs text-muted">
          {inviteEmail
            ? "We email them a single-use invite link (valid 7 days). You can also copy the link and send it yourself."
            : "They join through a single-use invite link (valid 7 days). Email isn't set up on this deployment, so share the link with them directly."}{" "}
          Your role: <span className="font-mono">{myRole}</span>
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            type="email"
            required
            placeholder="teammate@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={`${inputCls} min-w-64 flex-1`}
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}
            className={inputCls}
          >
            {grantable.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button onClick={invite} disabled={busy || !email} className={btnPrimary}>
            {busy ? "Inviting…" : "Invite"}
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-2 flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">
            <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
        {inviteUrl && (
          <div className="mt-3 rounded-md border border-line bg-canvas p-3">
            <p className="text-xs text-muted">
              {inviteResult?.emailed
                ? `Invite emailed to ${inviteResult.to}. The same single-use link, if you'd rather send it yourself:`
                : `${inviteResult?.note ? `${inviteResult.note} ` : ""}Invite created — share this single-use link with them:`}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-paper px-2 py-1 font-mono text-xs text-muted">
                {typeof window !== "undefined"
                  ? new URL(inviteUrl, window.location.origin).toString()
                  : inviteUrl}
              </code>
              <button
                onClick={() =>
                  navigator.clipboard.writeText(
                    new URL(inviteUrl, window.location.origin).toString(),
                  )
                }
                className={btnGhost}
              >
                Copy
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-paper">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-4 py-3">Member</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                <td className="px-4 py-3">
                  <div className="font-medium text-ink">{m.name ?? m.email ?? "—"}</div>
                  {m.name && m.email && (
                    <div className="text-xs text-muted">{m.email}</div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <select
                    value={m.role}
                    onChange={(e) => changeRole(m.id, e.target.value)}
                    disabled={m.role === "owner" && !isOwner}
                    className={`${inputCls} py-1`}
                  >
                    {ROLES.filter((r) => r === m.role || grantable.includes(r)).map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-3">
                  {m.pending ? (
                    <span className={chipCls}>
                      {inviteEmail ? "pending invite" : "pending — needs invite link"}
                    </span>
                  ) : (
                    <span className={chipCls}>active</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    {m.pending && inviteEmail && m.email && (
                      <button
                        onClick={() => emailInviteAgain(m.id)}
                        className="rounded-full px-3 py-1 text-xs font-semibold text-ink shadow-control hover:bg-hover-paper"
                      >
                        {resent === m.id ? "Sent" : "Email invite again"}
                      </button>
                    )}
                    {m.pending && (
                      <button
                        onClick={() => copyInviteLink(m.id)}
                        title="Makes a fresh link. Earlier links, including an emailed one, stop working."
                        className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-hover-paper"
                      >
                        {copied === m.id ? "Copied!" : "Copy invite link"}
                      </button>
                    )}
                    <button
                      onClick={() => remove(m.id)}
                      className="rounded-md px-2 py-1 text-xs text-failed-text shadow-[inset_0_0_0_1px_var(--aos-failed)] hover:bg-failed-tint"
                    >
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {members.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-muted">
                  No members yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
