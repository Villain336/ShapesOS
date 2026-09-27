// Marketr — Phase 11 "Canvas": Share modal (Feature 6). Approval workflow +
// public share-link management. Raw tokens are shown ONCE at creation and
// are never stored, logged, or retrievable again.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Check,
  Copy,
  Link2,
  Loader2,
  MonitorPlay,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";

interface ShareInfo {
  id: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  active: boolean;
  // Phase 12 (embeds): rrweb session replay opt-in for this link.
  replayOptIn: boolean;
}

interface Approval {
  status: string;
  note: string | null;
}

const STATUSES = [
  { key: "draft", label: "Draft" },
  { key: "in_review", label: "In review" },
  { key: "approved", label: "Approved" },
  { key: "changes_requested", label: "Changes requested" },
] as const;

export function ShareModal({
  designId,
  open,
  onClose,
}: {
  designId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [approval, setApproval] = useState<Approval | null>(null);
  const [shares, setShares] = useState<ShareInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const [expiryDays, setExpiryDays] = useState("");
  // Phase 12 (embeds): rrweb session replay opt-in for new share links.
  // Off by default; enabling records visitor sessions with masked inputs.
  const [replayOptIn, setReplayOptIn] = useState(false);
  const [newToken, setNewToken] = useState<{ url: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/studio/designs/${designId}`;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, s] = await Promise.all([
        fetch(`${base}/approval`).then((r) => {
          if (!r.ok) throw new Error(`approval: HTTP ${r.status}`);
          return r.json() as Promise<Approval>;
        }),
        fetch(`${base}/shares`).then((r) => {
          if (!r.ok) throw new Error(`shares: HTTP ${r.status}`);
          return r.json() as Promise<{ shares: ShareInfo[] }>;
        }),
      ]);
      setApproval(a);
      setNote(a.note ?? "");
      setShares(s.shares);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load sharing state.");
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    if (open) {
      setNewToken(null);
      setCopied(false);
      void refresh();
    }
  }, [open, refresh]);

  if (!open) return null;

  const setStatus = async (status: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${base}/approval`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status,
          note: status === "changes_requested" ? note : undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Approval;
      setApproval(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update approval.");
    } finally {
      setSaving(false);
    }
  };

  const createShare = async () => {
    setSaving(true);
    setError(null);
    try {
      const body: { expiresInDays?: number; replayOptIn?: boolean } = {};
      const days = parseInt(expiryDays, 10);
      if (Number.isFinite(days) && days > 0) body.expiresInDays = Math.min(365, days);
      if (replayOptIn) body.replayOptIn = true;
      const res = await fetch(`${base}/shares`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        share: ShareInfo;
        token: string;
        url: string;
      };
      setNewToken({ url: data.url, token: data.token });
      setShares((prev) => [{ ...data.share, active: true }, ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create share link.");
    } finally {
      setSaving(false);
    }
  };

  const revokeShare = async (shareId: string) => {
    try {
      const res = await fetch(`${base}/shares/${shareId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setShares((prev) =>
        prev.map((s) => (s.id === shareId ? { ...s, active: false } : s)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke link.");
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — the token text stays visible for manual copy.
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4">
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-stone-200 bg-white shadow-2xl">
        <div className="flex items-center gap-2 border-b border-stone-100 px-5 py-4">
          <ShieldCheck className="h-4 w-4 text-violet-600" />
          <h2 className="text-[15px] font-semibold text-stone-900">Share & approval</h2>
          <button
            onClick={onClose}
            className="ml-auto rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-6 px-5 py-4">
          {error && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              {error}
            </p>
          )}
          {loading ? (
            <p className="flex items-center gap-2 text-[13px] text-stone-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
          ) : (
            <>
              <section>
                <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-stone-400">
                  Approval status
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {STATUSES.map((s) => (
                    <button
                      key={s.key}
                      disabled={saving}
                      onClick={() => void setStatus(s.key)}
                      className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${
                        approval?.status === s.key
                          ? "bg-violet-600 text-white"
                          : "border border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                {approval?.status === "changes_requested" && (
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    onBlur={() => void setStatus("changes_requested")}
                    rows={3}
                    placeholder="What needs to change?"
                    className="mt-2 w-full rounded-md border border-stone-200 px-2.5 py-1.5 text-[13px] focus:border-violet-400 focus:outline-none"
                  />
                )}
              </section>

              <section>
                <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-stone-400">
                  Public share links
                </h3>
                {newToken && (
                  <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3">
                    <p className="mb-1.5 text-[12px] font-semibold text-amber-900">
                      Copy this link now — the token is shown once and never again.
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1.5 font-mono text-[12px] text-stone-800">
                        {newToken.url}
                      </code>
                      <button
                        onClick={() => void copy(newToken.url)}
                        className="flex shrink-0 items-center gap-1 rounded-md bg-violet-600 px-2.5 py-1.5 text-[12px] font-semibold text-white hover:bg-violet-700"
                      >
                        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                  </div>
                )}
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <input
                    value={expiryDays}
                    onChange={(e) => setExpiryDays(e.target.value.replace(/\D/g, ""))}
                    placeholder="Expires in days (optional)"
                    inputMode="numeric"
                    className="w-48 rounded-md border border-stone-200 px-2.5 py-1.5 text-[13px] focus:border-violet-400 focus:outline-none"
                  />
                  <label
                    className="flex cursor-pointer items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 hover:bg-stone-50"
                    title="Record visitor sessions (rrweb). Inputs are masked; recordings are workspace-visible only."
                  >
                    <input
                      type="checkbox"
                      checked={replayOptIn}
                      onChange={(e) => setReplayOptIn(e.target.checked)}
                      className="h-3.5 w-3.5 accent-violet-600"
                    />
                    Session replay
                  </label>
                  <button
                    onClick={() => void createShare()}
                    disabled={saving}
                    className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                  >
                    <Plus className="h-4 w-4" /> New link
                  </button>
                </div>
                {shares.length === 0 ? (
                  <p className="text-[13px] text-stone-500">
                    No share links yet. Links open a read-only preview for anyone with the URL.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {shares.map((s) => (
                      <li
                        key={s.id}
                        className="flex items-center gap-2 rounded-md border border-stone-200 px-3 py-2"
                      >
                        <Link2
                          className={`h-4 w-4 shrink-0 ${s.active ? "text-violet-600" : "text-stone-300"}`}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-[12px] font-medium text-stone-700">
                            Created {new Date(s.createdAt).toLocaleDateString()}
                            {s.expiresAt &&
                              ` · expires ${new Date(s.expiresAt).toLocaleDateString()}`}
                          </p>
                          <p
                            className={`text-[11px] ${s.active ? "text-emerald-600" : "text-stone-400"}`}
                          >
                            {s.active ? "Active" : "Revoked"}
                            {s.replayOptIn && s.active && (
                              <Link
                                href={`/dashboard/studio/designs/${encodeURIComponent(designId)}/replay/${encodeURIComponent(s.id)}`}
                                className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 hover:bg-violet-200"
                                title="Watch session recordings for this link"
                              >
                                <MonitorPlay className="h-3 w-3" /> replay · watch
                              </Link>
                            )}
                            {s.replayOptIn && !s.active && (
                              <span className="ml-1.5 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">
                                replay on
                              </span>
                            )}
                          </p>
                        </div>
                        {s.active && (
                          <button
                            onClick={() => void revokeShare(s.id)}
                            className="flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium text-red-600 hover:bg-red-50"
                            title="Revoke this link"
                          >
                            <Trash2 className="h-3.5 w-3.5" /> Revoke
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-[11px] leading-snug text-stone-400">
                  Public previews show the design, approval status, and comments only — never
                  workspace details. Revoked, expired, and unknown links all return the same
                  404.
                </p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
