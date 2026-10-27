"use client";

// ShapesOS — share-link manager for one deliverable (Office doc or report;
// Phase 23). The Studio/CAD rules, reused: tokens are shown ONCE at creation
// and never listed; links are expiring and revocable; creation is
// consequential, so it sits behind an explicit confirmation that says what
// the link exposes, who can open it and when it expires.

import { useCallback, useEffect, useState } from "react";
import { Ban, Check, Copy, ExternalLink, Loader2, Plus } from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";

interface ShareLink {
  id: string;
  label: string | null;
  tokenHint: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  state: "live" | "expired" | "revoked";
  openCount: number;
  lastOpenedAt: string | null;
}

export default function ShareLinksPanel({
  endpoint,
  subjectLabel,
  publicPath,
}: {
  /** Management endpoint, e.g. /api/office/docs/<id>/shares */
  endpoint: string;
  /** "document" | "report" — used in the confirmation copy. */
  subjectLabel: string;
  /** Public path builder for a freshly minted token. */
  publicPath: (token: string) => string;
}) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState("");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(endpoint);
    if (!res.ok) {
      setError("Couldn't load share links");
      return;
    }
    setLinks((await res.json()).shares);
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    if (
      !confirmAction(
        `Anyone with the link can view this ${subjectLabel} — no sign-in. The link expires automatically and can be revoked at any time. Nothing else in the workspace is exposed. Create the link?`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label || undefined, expiresInDays: days }),
      });
      if (!res.ok) {
        setError((await res.json().catch(() => ({})))?.error ?? "Couldn't create the link");
        return;
      }
      const { token } = await res.json();
      setFresh({ url: `${window.location.origin}${publicPath(token)}` });
      setShowForm(false);
      setLabel("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!confirmAction("Revoke this link? It stops working immediately.")) return;
    setBusy(true);
    try {
      await fetch(`${endpoint}/${id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!fresh) return;
    await navigator.clipboard.writeText(fresh.url).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">Share links</h3>
        <button type="button" onClick={() => setShowForm((s) => !s)} className="inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-3 text-sm font-semibold text-white aos-press hover:bg-ink-hover">
          <Plus className="h-3.5 w-3.5" aria-hidden /> New link
        </button>
      </div>

      {fresh && (
        <div className="flex flex-col gap-1.5 rounded-md bg-canvas p-3">
          <p className="text-xs font-semibold text-ink">Link created — copy it now. It won't be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-paper px-2 py-1 text-xs text-ink shadow-hairline">{fresh.url}</code>
            <button type="button" onClick={() => void copy()} className="inline-flex items-center gap-1 rounded-full bg-paper px-2.5 py-1 text-xs font-semibold text-ink shadow-control hover:shadow-outline">
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {showForm && (
        <div className="flex flex-wrap items-end gap-2 rounded-md bg-canvas p-3">
          <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs font-medium text-muted">
            Label (optional)
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. For the client" className="h-control-sm rounded-md bg-paper px-2 text-sm text-ink shadow-hairline" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Expires
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-control-sm rounded-md bg-paper px-2 text-sm text-ink shadow-hairline">
              <option value={1}>in 1 day</option>
              <option value={7}>in 7 days</option>
              <option value={30}>in 30 days</option>
              <option value={90}>in 90 days</option>
            </select>
          </label>
          <button type="button" disabled={busy} onClick={() => void create()} className="inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-3 text-sm font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-50">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />} Create link
          </button>
        </div>
      )}

      {error && <p className="text-xs text-failed-text">{error}</p>}

      {links === null ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : links.length === 0 ? (
        <p className="text-xs text-muted">
          No share links yet. Links are tokenized, expire automatically and can be revoked at any time.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {links.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate text-muted">
                {l.label || `Link …${l.tokenHint}`}
                <span className="ml-2 text-xs text-subtle">
                  {l.state === "live" ? (l.expiresAt ? `expires ${new Date(l.expiresAt).toLocaleDateString()}` : "no expiry") : l.state}
                  {l.openCount > 0 ? ` · opened ${l.openCount}×` : ""}
                </span>
              </span>
              {l.state === "live" && (
                <button type="button" disabled={busy} onClick={() => void revoke(l.id)} className="inline-flex items-center gap-1 rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-ink shadow-control hover:shadow-outline">
                  <Ban className="h-3 w-3" /> Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
