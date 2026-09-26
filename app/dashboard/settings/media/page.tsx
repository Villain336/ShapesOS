// Marketr — Settings → Media (Phase 5 SAFETY configuration surface).
// Admin+ only (server-gated). Roles, two-person threshold, OTP mode,
// virtual-card provider mode, kill-rule defaults.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import { mediaRoleForWorkspaceRole, DEFAULT_TWO_PERSON_THRESHOLD_CENTS, EXECUTION_WINDOW_HOURS, twoPersonThresholdCents, executionWindowHours } from "@/lib/media/safety";

export const dynamic = "force-dynamic";

export default async function MediaSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");
  const mediaRole = mediaRoleForWorkspaceRole(membership.role);

  const cardMode = process.env.MEDIA_CARD_MODE === "live" ? "live" : "test";

  const rows: Array<[string, string]> = [
    ["Your media role", `${mediaRole} (workspace ${membership.role})`],
    ["Two-person threshold", `$${(twoPersonThresholdCents() / 100).toFixed(0)} — second approver required at/above (default $${(DEFAULT_TWO_PERSON_THRESHOLD_CENTS / 100).toFixed(0)}; override MEDIA_TWO_PERSON_THRESHOLD_CENTS)`],
    ["Approval execution window", `${executionWindowHours()}h (default ${EXECUTION_WINDOW_HOURS}h; override MEDIA_EXECUTION_WINDOW_HOURS) — expired approvals re-enter the queue, never execute`],
    ["High-value approvals", "OTP confirmation required at/above the two-person threshold → HMAC-signed approval receipt"],
    ["Backup approvers", "Workspace owners/admins (excluding the creator) — no approval dead-ends"],
    ["Virtual-card provider mode", `${cardMode} — fake default; Brex/Ramp adapters are test-mode-first. Live requires explicit keys AND a human-approved per-buy approval`],
    ["Autopilot purchasing", "STRUCTURALLY DISABLED — the executor requires a human-approved approval; no rung, flag, or exception reaches autopilot"],
    ["Zero custody", "Marketr never holds/fronts/co-mingles client money — pools are accounting objects only; spend flows from the client's own accounts/cards"],
    ["The €7,937/day class", "Killed three ways: hard caps at ≥2 independent layers (software encumbrance + virtual-card limit + platform spending limits), budget increases always need fresh approval, sweeper spend-anomaly rule fires before noon-budget-exhaustion becomes a four-day fire"],
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Media safety</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          {workspace.name} — trust ladder, approval rules, virtual cards, and kill switches for
          supervised-always media buying.
        </p>
      </div>
      <SettingsNav />
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
        <table className="w-full text-left text-sm">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} className="border-b border-zinc-100 last:border-0">
                <th className="w-56 px-4 py-3 align-top font-medium text-zinc-700">{k}</th>
                <td className="px-4 py-3 text-zinc-600">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rounded-xl border border-zinc-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-zinc-900">Role separation</h2>
        <ul className="mt-2 space-y-1 text-sm text-zinc-600">
          <li>· <span className="font-medium">owner</span> (workspace owner/admin) — propose, approve, emergency stop</li>
          <li>· <span className="font-medium">media_buyer</span> (workspace editor) — propose only; can never approve (enforced in the service layer)</li>
          <li>· <span className="font-medium">viewer</span> — read-only</li>
        </ul>
      </div>
    </div>
  );
}
