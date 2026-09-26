// Marketr — permission grants manager (milestone 21, part D1).
// Grants the skills.install / connectors.connect permissions to a member
// or a whole role. Owner/admin hold all permissions by default.

"use client";

import { useCallback, useEffect, useState } from "react";
import { UserPlus, Users } from "lucide-react";
import {
  Notice,
  cardCls,
  dangerBtnCls,
  inputCls,
  labelCls,
  primaryBtnVioletCls,
  type NoticeState,
} from "./ui";

interface Grant {
  id: string;
  userId: string | null;
  role: string | null;
  permission: string;
  grantedBy: string | null;
  createdAt: string;
}

export interface MemberOption {
  id: string;
  userId: string | null;
  email: string | null;
  name: string | null;
  role: string;
}

const PERMISSIONS = [
  {
    key: "skills.install",
    label: "Install skills",
    hint: "Install, re-pin, and delete workspace skills.",
  },
  {
    key: "connectors.connect",
    label: "Connect data sources",
    hint: "Run OAuth/API-key flows and disconnect connectors.",
  },
] as const;

const ROLES = ["owner", "admin", "editor", "viewer"] as const;

export default function PermissionGrantsManager({
  workspaceId,
  members,
}: {
  workspaceId: string;
  members: MemberOption[];
}) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"member" | "role">("member");
  const [permission, setPermission] = useState<string>(PERMISSIONS[0].key);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("editor");

  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;

  const load = useCallback(async () => {
    const r = await fetch(`/api/members/grants?${q}`);
    if (r.ok) {
      const j = await r.json();
      setGrants(j.grants ?? []);
    }
  }, [q]);

  useEffect(() => {
    load();
  }, [load]);

  const grantableMembers = members.filter((m) => m.userId);

  function memberLabel(m: MemberOption): string {
    const who = m.name ?? m.email ?? "member";
    return m.email && m.name ? `${m.name} (${m.email})` : who;
  }

  async function grant() {
    if (mode === "member" && !userId) {
      setNotice({ kind: "error", message: "Choose a member to grant to." });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const body: Record<string, string> = { workspaceId, permission };
      if (mode === "member") body.userId = userId;
      else body.role = role;
      const r = await fetch("/api/members/grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice({
          kind: "error",
          message:
            typeof j.error === "string" ? j.error : "Grant failed.",
        });
        return;
      }
      setNotice({ kind: "ok", message: "Permission granted." });
      setUserId("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function removeGrant(id: string) {
    if (!confirm("Remove this permission grant?")) return;
    setNotice(null);
    try {
      const r = await fetch(`/api/members/grants/${encodeURIComponent(id)}?${q}`, {
        method: "DELETE",
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice({
          kind: "error",
          message: typeof j.error === "string" ? j.error : "Remove failed.",
        });
        return;
      }
      setNotice({ kind: "ok", message: "Grant removed." });
      await load();
    } catch {
      setNotice({ kind: "error", message: "Remove failed." });
    }
  }

  function grantTarget(g: Grant): string {
    if (g.userId) {
      const m = members.find((x) => x.userId === g.userId);
      return m ? memberLabel(m) : g.userId;
    }
    return `role: ${g.role ?? "—"}`;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className={cardCls}>
        <h2 className="font-medium">Permission grants</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Owners and admins hold every permission by default. Grant
          fine-grained permissions below to individual members or whole roles.
        </p>

        <div className="mb-4 mt-3 flex gap-1 border-b border-stone-200">
          {(
            [
              { id: "member", label: "Grant to a member", icon: UserPlus },
              { id: "role", label: "Grant to a role", icon: Users },
            ] as const
          ).map((m) => {
            const Icon = m.icon;
            return (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition ${
                  mode === m.id
                    ? "border-violet-600 text-violet-700"
                    : "border-transparent text-stone-500 hover:text-stone-800"
                }`}
              >
                <Icon size={15} />
                {m.label}
              </button>
            );
          })}
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-3">
          <label className={labelCls}>
            Permission
            <select
              value={permission}
              onChange={(e) => setPermission(e.target.value)}
              className={`${inputCls} mt-1 w-full`}
            >
              {PERMISSIONS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {mode === "member" ? (
            <label className={labelCls}>
              Member
              <select
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                className={`${inputCls} mt-1 w-full`}
              >
                <option value="">Choose a member…</option>
                {grantableMembers.map((m) => (
                  <option key={m.userId!} value={m.userId!}>
                    {memberLabel(m)} · {m.role}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className={labelCls}>
              Role
              <select
                value={role}
                onChange={(e) =>
                  setRole(e.target.value as (typeof ROLES)[number])
                }
                className={`${inputCls} mt-1 w-full`}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex items-end">
            <button
              onClick={grant}
              disabled={busy || (mode === "member" && !userId)}
              className={primaryBtnVioletCls}
            >
              {busy ? "Granting…" : "Grant"}
            </button>
          </div>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          {PERMISSIONS.find((p) => p.key === permission)?.hint}
          {mode === "member" &&
            " Only members who have already joined (not pending invites) can hold individual grants."}
        </p>
      </div>

      <Notice notice={notice} />

      <div className="overflow-hidden rounded-xl border border-zinc-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-white/60 text-left text-xs uppercase tracking-widest text-zinc-500">
              <th className="px-4 py-3">Permission</th>
              <th className="px-4 py-3">Granted to</th>
              <th className="px-4 py-3">Granted</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={g.id} className="border-b border-zinc-200/60 last:border-0">
                <td className="px-4 py-3 font-mono text-xs">{g.permission}</td>
                <td className="px-4 py-3">{grantTarget(g)}</td>
                <td className="px-4 py-3 text-xs text-zinc-500">
                  {new Date(g.createdAt).toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => removeGrant(g.id)} className={dangerBtnCls}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {grants.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-zinc-500">
                  No grants yet — owners and admins hold all permissions by default.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
