// ShapesOS — Phase 10 (portal): Settings → Clients → Portal access.
// The portal switch, the CRM records this client may see (companies,
// contacts, leads — invoices, quotes and projects follow the customer lead;
// tickets follow the contact), and their portal sessions with revoke.
// Rules: lib/portal/admin.ts (admin+, audited).

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LogOut, Plus, X } from "lucide-react";
import { SwitchRow } from "@/components/aos";
import { FormError } from "./FormError";
import { btnSmallDanger, btnSmallSecondary, cardCls, inputCls, labelCls } from "./aos";

interface Ref {
  id: string;
  name: string;
  detail: string | null;
}
type Kind = "companies" | "contacts" | "leads";
interface SessionRow {
  id: string;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  active: boolean;
  revokedAt: string | null;
}
interface Data {
  client: { id: string; name: string; loginEmail: string; viewerRole: string; portalEnabled: boolean };
  sections: string[];
  linked: Record<Kind, Ref[]>;
  candidates: Record<Kind, Ref[]>;
  sessions: SessionRow[];
}

const KIND: Record<Kind, { title: string; hint: string; field: "companyIds" | "contactIds" | "leadIds" }> = {
  companies: { title: "Companies", hint: "Every contact at the company counts as linked.", field: "companyIds" },
  contacts: { title: "Contacts", hint: "Tickets on these contacts, and invoices for the lead each was converted from.", field: "contactIds" },
  leads: { title: "Customers (CRM leads)", hint: "Invoices, quotes and projects billed to these customers.", field: "leadIds" },
};
const ROLE_SEES: Record<string, string> = {
  viewer: "Can view: projects, tickets and documents, read-only.",
  editor: "Can edit: also invoices and quotes; can open and reply to tickets and pay invoices.",
  admin: "Full access: everything, including accepting or declining quotes.",
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—");

function LinkPicker({ kind, data, onSave }: { kind: Kind; data: Data; onSave: (kind: Kind, ids: string[]) => Promise<string | null> }) {
  const [pick, setPick] = useState("");
  const [error, setError] = useState<string | null>(null);
  const linked = data.linked[kind];
  const linkedIds = useMemo(() => new Set(linked.map((r) => r.id)), [linked]);
  const options = data.candidates[kind].filter((r) => !linkedIds.has(r.id));
  const save = async (ids: string[]) => {
    setError(await onSave(kind, ids));
    setPick("");
  };
  return (
    <section className={cardCls} aria-labelledby={`link-${kind}`}>
      <h2 id={`link-${kind}`} className="aos-subheading">{KIND[kind].title}</h2>
      <p className="mt-1 text-sm text-muted">{KIND[kind].hint}</p>
      <ul className="mt-3 flex flex-col gap-1.5">
        {linked.length === 0 && <li className="text-sm text-muted">None linked.</li>}
        {linked.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 rounded-sm px-2 py-1.5 hover:bg-hover-paper">
            <span>
              <span className="font-semibold text-ink">{r.name}</span>
              {r.detail && <span className="ml-2 text-sm text-muted">{r.detail}</span>}
            </span>
            <button type="button" className={btnSmallSecondary} onClick={() => save([...linkedIds].filter((x) => x !== r.id))}>
              <X size={14} aria-hidden /> Unlink
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex-1">
          <span className={labelCls}>Link a record</span>
          <select className={`${inputCls} mt-1`} value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Choose…</option>
            {options.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.detail ? ` (${r.detail})` : ""}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={btnSmallSecondary} disabled={!pick} onClick={() => save([...linkedIds, pick])}>
          <Plus size={14} aria-hidden /> Link
        </button>
      </div>
      <FormError message={error} />
    </section>
  );
}

export default function ClientPortalAccess({ clientId }: { clientId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = `/api/workspace/clients/${encodeURIComponent(clientId)}/portal`;

  const load = useCallback(async () => {
    const r = await fetch(url).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) {
      setError(j.error ?? "Couldn't load portal access. Refresh to try again.");
      return;
    }
    setData(j as Data);
  }, [url]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(body: Record<string, unknown>): Promise<string | null> {
    const r = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) return j.error ?? "Couldn't save. Try again.";
    await load();
    return null;
  }

  async function revoke(sessionId?: string) {
    setBusy(true);
    const r = await fetch(`${url}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    }).catch(() => null);
    setBusy(false);
    if (!r?.ok) setError("Couldn't sign the client out. Try again.");
    await load();
  }

  if (!data) return <FormError message={error} />;
  const active = data.sessions.filter((s) => s.active);
  return (
    <div className="flex flex-col gap-5">
      <FormError message={error} />
      <section className={cardCls} aria-labelledby="portal-switch">
        <h2 id="portal-switch" className="aos-subheading">{data.client.name}</h2>
        <p className="mt-1 text-sm text-muted">
          Signs in as <span className="aos-mono">{data.client.loginEmail}</span>. {ROLE_SEES[data.client.viewerRole] ?? ""} Change access on the Clients page.
        </p>
        <SwitchRow
          className="mt-3 rounded-md bg-canvas"
          title="Client portal"
          description="Lets this client sign in with an emailed link."
          checked={data.client.portalEnabled}
          onChange={async (on: boolean) => setError(await patch({ portalEnabled: on }))}
        />
        {!data.client.portalEnabled && (
          <p className="mt-3 text-sm text-muted">The portal is off: sign-in links aren&apos;t sent and any open sessions were ended.</p>
        )}
      </section>

      {(Object.keys(KIND) as Kind[]).map((k) => (
        <LinkPicker key={k} kind={k} data={data} onSave={(kind, ids) => patch({ [KIND[kind].field]: ids })} />
      ))}

      <section className={cardCls} aria-labelledby="portal-sessions">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="portal-sessions" className="aos-subheading">Portal sessions</h2>
          <button type="button" className={btnSmallDanger} disabled={busy || active.length === 0} onClick={() => revoke()}>
            <LogOut size={14} aria-hidden /> Sign out everywhere
          </button>
        </div>
        {data.sessions.length === 0 ? (
          <p className="mt-2 text-sm text-muted">This client hasn&apos;t signed in yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs font-semibold text-muted">
                  <th className="px-2 py-2">Signed in</th>
                  <th className="px-2 py-2">Last seen</th>
                  <th className="px-2 py-2">From</th>
                  <th className="px-2 py-2">State</th>
                  <th className="px-2 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.sessions.map((s) => (
                  <tr key={s.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-2 py-2">{when(s.createdAt)}</td>
                    <td className="px-2 py-2">{when(s.lastSeenAt)}</td>
                    <td className="px-2 py-2">
                      <span className="aos-mono">{s.ip ?? "—"}</span>
                    </td>
                    <td className="px-2 py-2">{s.active ? "Active" : s.revokedAt ? "Signed out" : "Expired"}</td>
                    <td className="px-2 py-2 text-right">
                      {s.active && (
                        <button type="button" className={btnSmallSecondary} disabled={busy} onClick={() => revoke(s.id)}>
                          Sign out
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
