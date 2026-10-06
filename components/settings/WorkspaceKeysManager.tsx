// ShapesOS — Phase 15.1: the workspace's own keys (Settings → Providers).
// Client component over /api/settings/keys: add / test / remove the
// workspace's model keys (Anthropic, OpenAI — "Your key — no AI credits
// used"), its own sidecar instances (required on hosted) and its Smartlead /
// Instantly accounts. Secrets are write-only: the API never returns them, so
// a saved key shows as "Saved" with who and when, never a value.
// Agentic OS: tokens only, Lucide icons, pills for pressables, black primary
// action, neutral chips (configuration is not an agent state).

"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, KeyRound, Loader2, Plug, ShieldCheck, Trash2 } from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";
import { Notice, btnCls, dangerBtnCls, inputCls, labelCls, primaryBtnCls, type NoticeState } from "./ui";

interface FieldView {
  name: string;
  label: string;
  secret: boolean;
  type: "url" | "text";
  required: boolean;
  placeholder?: string;
  value: string | null;
}

interface CredentialView {
  id: string;
  kind: "model" | "sidecar" | "outreach";
  label: string;
  help: string;
  connected: boolean;
  connectedAt: string | null;
  connectedBy: string | null;
  fields: FieldView[];
}

interface Payload {
  credentials: CredentialView[];
  deployment: "hosted" | "self_hosted";
}

const SECTION: Record<CredentialView["kind"], { title: string; body: (hosted: boolean) => string }> = {
  model: {
    title: "Your model keys",
    body: () =>
      "Bring your own Anthropic or OpenAI key and every model call on it uses no AI credits, on the same plan. Zero-retention and blocked-model rules still apply.",
  },
  sidecar: {
    title: "Your own tool instances",
    body: (hosted) =>
      hosted
        ? "A shared instance isn't safe between workspaces, so on hosted ShapesOS these tools work only with your own instance."
        : "Self-hosted: the host's instance is used unless you connect your own here.",
  },
  outreach: {
    title: "Your sending accounts",
    body: () => "Cold email goes out from your own Smartlead or Instantly account and domains.",
  },
};

function Chip({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-semibold shadow-control ${
        on ? "text-ink" : "text-muted"
      }`}
    >
      {on ? <Check size={12} aria-hidden="true" /> : null}
      {label}
    </span>
  );
}

function CredentialCard({ cred, onChanged }: { cred: CredentialView; onChanged: (p: Payload | null) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(cred.fields.map((f) => [f.name, f.secret ? "" : (f.value ?? "")])),
  );
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [editing, setEditing] = useState(!cred.connected);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy("save");
    setNotice(null);
    try {
      const r = await fetch("/api/settings/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cred.id, values }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not save.");
      setNotice({ kind: "ok", message: cred.kind === "model" ? `${cred.label} key checked and saved.` : `${cred.label} saved.` });
      setValues((v) => Object.fromEntries(Object.entries(v).map(([k, val]) => [k, cred.fields.find((f) => f.name === k)?.secret ? "" : val])));
      setEditing(false);
      onChanged({ credentials: j.credentials, deployment: "self_hosted" });
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "Could not save." });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    setNotice(null);
    try {
      const r = await fetch("/api/settings/keys/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cred.id }),
      });
      const j = await r.json();
      setNotice({ kind: j.ok ? "ok" : "error", message: j.message ?? j.error ?? "Test failed." });
    } catch {
      setNotice({ kind: "error", message: "Test failed." });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!(await confirmAction(`Remove this workspace's ${cred.label} settings?`))) return;
    setBusy("remove");
    setNotice(null);
    try {
      const r = await fetch(`/api/settings/keys?id=${encodeURIComponent(cred.id)}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not remove.");
      setNotice({ kind: "info", message: `${cred.label} removed.` });
      setEditing(true);
      onChanged({ credentials: j.credentials, deployment: "self_hosted" });
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "Could not remove." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-paper p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {cred.kind === "model" ? <KeyRound size={16} className="text-subtle" aria-hidden="true" /> : <Plug size={16} className="text-subtle" aria-hidden="true" />}
          <span className="text-[0.8125rem] font-semibold text-ink">{cred.label}</span>
        </div>
        <Chip
          on={cred.connected}
          label={cred.connected ? (cred.kind === "model" ? "Your key — no AI credits used" : "Your own") : "Not connected"}
        />
      </div>
      <p className="text-[0.75rem] text-muted">{cred.help}</p>
      {cred.connected && !editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[0.75rem] text-muted">
            Saved {cred.connectedAt ? new Date(cred.connectedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : ""}
            {cred.fields.filter((f) => !f.secret && f.value).map((f) => (
              <span key={f.name} className="ml-2 font-mono text-[0.6875rem] text-ink">
                {f.value}
              </span>
            ))}
          </span>
          <span className="flex-1" />
          <button type="button" onClick={test} disabled={busy !== null} className={btnCls}>
            {busy === "test" ? <Loader2 size={14} className="aos-spin" /> : <ShieldCheck size={14} />}
            Test
          </button>
          <button type="button" onClick={() => setEditing(true)} disabled={busy !== null} className={btnCls}>
            Replace
          </button>
          <button type="button" onClick={remove} disabled={busy !== null} className={`${dangerBtnCls} gap-1.5`}>
            {busy === "remove" ? <Loader2 size={14} className="aos-spin" /> : <Trash2 size={14} />}
            Remove
          </button>
        </div>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-2">
          <div className="grid gap-2 md:grid-cols-2">
            {cred.fields.map((f) => (
              <label key={f.name} className="flex flex-col gap-1">
                <span className={labelCls}>
                  {f.label}
                  {f.required ? "" : " (optional)"}
                </span>
                <input
                  type={f.secret ? "password" : f.type === "url" ? "url" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  required={f.required}
                  placeholder={f.secret && cred.connected ? "Saved — type to replace" : f.placeholder}
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                  className={`${inputCls} ${f.secret || f.type === "url" ? "font-mono" : ""}`}
                />
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy !== null} className={primaryBtnCls}>
              {busy === "save" ? <Loader2 size={14} className="aos-spin" /> : null}
              {cred.kind === "model" ? "Check and save" : "Save"}
            </button>
            {cred.connected ? (
              <button type="button" onClick={() => setEditing(false)} className={btnCls}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      )}
      <Notice notice={notice} />
    </div>
  );
}

export default function WorkspaceKeysManager({ kinds }: { kinds: Array<CredentialView["kind"]> }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/settings/keys");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not load keys.");
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load keys.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <Notice notice={{ kind: "error", message: error }} />;
  if (!data) {
    return (
      <div className="flex items-center gap-2 text-[0.8125rem] text-muted">
        <Loader2 size={16} className="aos-spin" />
        Loading keys…
      </div>
    );
  }
  const hosted = data.deployment === "hosted";
  return (
    <div className="flex flex-col gap-6">
      {kinds.map((kind) => {
        const creds = data.credentials.filter((c) => c.kind === kind);
        if (creds.length === 0) return null;
        return (
          <section key={kind} className="flex flex-col gap-3" aria-labelledby={`keys-${kind}`}>
            <div>
              <h3 id={`keys-${kind}`} className="text-[0.8125rem] font-semibold text-ink">
                {SECTION[kind].title}
              </h3>
              <p className="text-[0.75rem] text-muted">{SECTION[kind].body(hosted)}</p>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {creds.map((c) => (
                <CredentialCard
                  key={`${c.id}:${c.connected}:${c.connectedAt ?? ""}`}
                  cred={c}
                  onChanged={(p) => (p ? setData({ credentials: p.credentials, deployment: data.deployment }) : load())}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
