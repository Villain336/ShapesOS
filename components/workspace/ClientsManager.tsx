// ShapesOS — Settings → Clients (Phase 3, workstream I).
// Agency client records over the existing Client model: who each client is,
// the email they sign in with to see their reports, their access, and the
// report cadence. Admins add, edit and delete (typed-name confirmation —
// deleting a client deletes its reports). Rules: lib/workspace/clients.ts.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { FormError } from "./FormError";
import { btnPrimary, btnQuiet, btnSmallDanger, btnSmallSecondary, cardCls, inputCls, labelCls } from "./aos";

interface ClientRow {
  id: string;
  name: string;
  loginEmail: string;
  viewerRole: "viewer" | "editor" | "admin";
  reportSchedule: string | null;
  reports: number;
  brandKits: number;
  pipelines: number;
}

const ROLE_LABEL: Record<ClientRow["viewerRole"], string> = { viewer: "Can view", editor: "Can edit", admin: "Full access" };
const SCHEDULE_LABEL = (s: string | null) => (s === "weekly" ? "Weekly" : s === "monthly" ? "Monthly" : "None");

interface Draft {
  name: string;
  loginEmail: string;
  viewerRole: ClientRow["viewerRole"];
  reportSchedule: string;
}
const EMPTY: Draft = { name: "", loginEmail: "", viewerRole: "viewer", reportSchedule: "" };

function ClientForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  submitLabel: string;
  onSubmit: (d: Draft) => Promise<string | null>;
  onCancel?: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idp = initial.name ? `edit-${initial.loginEmail}` : "new";
  return (
    <form
      className="grid gap-3 md:grid-cols-[2fr_2fr_1fr_1fr_auto] md:items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const err = await onSubmit(d);
        setBusy(false);
        if (err) setError(err);
        else if (!onCancel) setD(EMPTY);
      }}
    >
      <div>
        <label htmlFor={`${idp}-name`} className={labelCls}>Client name</label>
        <input id={`${idp}-name`} className={`${inputCls} mt-1`} value={d.name} maxLength={120} placeholder="Bob's Bikes" onChange={(e) => setD({ ...d, name: e.target.value })} />
      </div>
      <div>
        <label htmlFor={`${idp}-email`} className={labelCls}>Sign-in email</label>
        <input id={`${idp}-email`} type="email" className={`${inputCls} mt-1`} value={d.loginEmail} placeholder="owner@bobsbikes.com" onChange={(e) => setD({ ...d, loginEmail: e.target.value })} />
      </div>
      <div>
        <label htmlFor={`${idp}-role`} className={labelCls}>Access</label>
        <select id={`${idp}-role`} className={`${inputCls} mt-1`} value={d.viewerRole} onChange={(e) => setD({ ...d, viewerRole: e.target.value as Draft["viewerRole"] })}>
          <option value="viewer">Can view</option>
          <option value="editor">Can edit</option>
          <option value="admin">Full access</option>
        </select>
      </div>
      <div>
        <label htmlFor={`${idp}-schedule`} className={labelCls}>Reports</label>
        <select id={`${idp}-schedule`} className={`${inputCls} mt-1`} value={d.reportSchedule} onChange={(e) => setD({ ...d, reportSchedule: e.target.value })}>
          <option value="">None</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
      </div>
      <div className="flex gap-2">
        <button type="submit" className={btnPrimary} disabled={busy || !d.name.trim() || !d.loginEmail.trim()}>
          {onCancel ? null : <Plus size={16} aria-hidden />}
          {busy ? (onCancel ? "Saving" : "Adding") : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className={btnQuiet} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {error && (
        <div className="md:col-span-5">
          <FormError message={error} />
        </div>
      )}
    </form>
  );
}

export default function ClientsManager() {
  const [clients, setClients] = useState<ClientRow[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetch("/api/workspace/clients")
        .then(async (r) => ({ ok: r.ok, j: await r.json().catch(() => ({})) }))
        .then(({ ok, j }) => {
          if (!ok) {
            setLoadError(j.error ?? "Couldn't load clients. Refresh to try again.");
            return;
          }
          setClients(j.clients ?? []);
          setCanEdit(j.canEdit === true);
        })
        .catch(() => setLoadError("Couldn't load clients. Refresh to try again.")),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  async function save(url: string, method: string, d: Draft): Promise<string | null> {
    const r = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...d, reportSchedule: d.reportSchedule || null }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return j.error ?? "Couldn't save the client. Try again.";
    setEditing(null);
    await load();
    return null;
  }

  async function remove(c: ClientRow) {
    setDeleteError(null);
    const r = await fetch(`/api/workspace/clients/${c.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmName: confirm }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setDeleteError(j.error ?? "Couldn't delete the client. Try again.");
      return;
    }
    setDeleting(null);
    setConfirm("");
    await load();
  }

  return (
    <div className="flex flex-col gap-5">
      {canEdit && (
        <section className={cardCls} aria-labelledby="client-add">
          <h2 id="client-add" className="aos-subheading">Add a client</h2>
          <p className="mt-1 text-sm text-muted">
            Clients sign in with their email to see the reports you send them. Give each one a{" "}
            <Link href="/dashboard/settings/brand-kits" className="underline underline-offset-2 hover:text-ink">brand kit</Link>{" "}
            so reports carry their look.
          </p>
          <div className="mt-3">
            <ClientForm initial={EMPTY} submitLabel="Add client" onSubmit={(d) => save("/api/workspace/clients", "POST", d)} />
          </div>
        </section>
      )}

      <FormError message={loadError} />

      <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
        <table className="w-full text-md">
          <thead>
            <tr className="border-b border-line text-left text-xs font-semibold text-muted">
              <th className="px-4 py-2.5">Client</th>
              <th className="px-4 py-2.5">Access</th>
              <th className="px-4 py-2.5">Reports</th>
              <th className="px-4 py-2.5">Linked</th>
              {canEdit && <th className="px-4 py-2.5 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {clients === null && !loadError && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted">Loading clients</td>
              </tr>
            )}
            {clients?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted">
                  {canEdit ? "No clients yet. Add the first one above." : "No clients yet."}
                </td>
              </tr>
            )}
            {clients?.map((c) =>
              editing === c.id ? (
                <tr key={c.id} className="border-b border-line last:border-0">
                  <td colSpan={5} className="px-4 py-3">
                    <ClientForm
                      initial={{ name: c.name, loginEmail: c.loginEmail, viewerRole: c.viewerRole, reportSchedule: c.reportSchedule ?? "" }}
                      submitLabel="Save client"
                      onSubmit={(d) => save(`/api/workspace/clients/${c.id}`, "PATCH", d)}
                      onCancel={() => setEditing(null)}
                    />
                  </td>
                </tr>
              ) : (
                <tr key={c.id} className="border-b border-line align-top last:border-0 hover:bg-hover-paper">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-ink">{c.name}</div>
                    <div className="text-sm text-muted">{c.loginEmail}</div>
                    {deleting === c.id && (
                      <form
                        className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void remove(c);
                        }}
                      >
                        <div className="flex-1">
                          <label htmlFor={`del-${c.id}`} className="block text-sm text-muted">
                            Deletes {c.name} and its {c.reports} report{c.reports === 1 ? "" : "s"}. Brand kits and pipelines stay, unlinked. Type{" "}
                            <span className="aos-mono text-ink">{c.name}</span> to confirm.
                          </label>
                          <input
                            id={`del-${c.id}`}
                            className={`${inputCls} mt-1`}
                            value={confirm}
                            autoComplete="off"
                            onChange={(e) => setConfirm(e.target.value)}
                          />
                          <FormError message={deleteError} />
                        </div>
                        <div className="flex gap-2 sm:mt-6">
                          <button type="submit" className={btnSmallDanger} disabled={confirm.trim() !== c.name}>
                            <Trash2 size={14} aria-hidden />
                            Delete client
                          </button>
                          <button
                            type="button"
                            className={btnSmallSecondary}
                            onClick={() => {
                              setDeleting(null);
                              setConfirm("");
                              setDeleteError(null);
                            }}
                          >
                            <X size={14} aria-hidden />
                            Keep
                          </button>
                        </div>
                      </form>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex h-badge items-center rounded-full bg-paper px-2.5 text-sm font-semibold text-ink shadow-control">
                      {ROLE_LABEL[c.viewerRole]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-ink">
                    {SCHEDULE_LABEL(c.reportSchedule)}
                    <div className="text-sm text-muted">{c.reports} sent</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted">
                    {c.brandKits} brand kit{c.brandKits === 1 ? "" : "s"}
                    <br />
                    {c.pipelines} pipeline{c.pipelines === 1 ? "" : "s"}
                  </td>
                  {canEdit && (
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button type="button" className={btnSmallSecondary} onClick={() => setEditing(c.id)}>
                          <Pencil size={14} aria-hidden />
                          Edit
                        </button>
                        <button
                          type="button"
                          className={btnSmallDanger}
                          onClick={() => {
                            setDeleting(c.id);
                            setConfirm("");
                            setDeleteError(null);
                          }}
                        >
                          <Trash2 size={14} aria-hidden />
                          Delete
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
