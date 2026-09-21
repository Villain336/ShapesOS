// Marketr — workspace members manager (milestone 11: RBAC).
// Client component: list members, invite by email, change roles, remove.

"use client";

import { useCallback, useEffect, useState } from "react";

const inputCls =
  "rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none";
const btnCls =
  "rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm font-medium hover:bg-zinc-700 disabled:opacity-50";

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
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("editor");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/workspace/members");
    if (r.ok) {
      const j = await r.json();
      setMembers(j.members ?? []);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function invite() {
    setError(null);
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
      setEmail("");
      await load();
    } finally {
      setBusy(false);
    }
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
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <h2 className="text-sm font-medium">Invite a teammate</h2>
        <p className="mt-1 text-xs text-zinc-500">
          They join on first sign-in — no email is sent. Your role:{" "}
          <span className="font-mono">{myRole}</span>
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
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button onClick={invite} disabled={busy || !email} className={btnCls}>
            {busy ? "Inviting…" : "Invite"}
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/60 text-left text-xs uppercase tracking-widest text-zinc-500">
              <th className="px-4 py-3">Member</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-b border-zinc-800/60 last:border-0">
                <td className="px-4 py-3">
                  <div className="font-medium">{m.name ?? m.email ?? "—"}</div>
                  {m.name && m.email && (
                    <div className="text-xs text-zinc-500">{m.email}</div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <select
                    value={m.role}
                    onChange={(e) => changeRole(m.id, e.target.value)}
                    className={`${inputCls} py-1`}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-3">
                  {m.pending ? (
                    <span className="rounded-full bg-amber-950 px-2 py-0.5 text-xs text-amber-300">
                      pending — joins on first sign-in
                    </span>
                  ) : (
                    <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-xs text-emerald-300">
                      active
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => remove(m.id)}
                    className="rounded-md border border-red-900 bg-red-950 px-2 py-1 text-xs text-red-300 hover:bg-red-900"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {members.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-zinc-500">
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
