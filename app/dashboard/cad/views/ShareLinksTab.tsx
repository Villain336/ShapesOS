"use client";

// Marketr — CAD + Hardware slice 1: tokenized collaborator share links.
// Expiring, revocable, fail-closed. Link creation is consequential: the UI
// puts an explicit confirmation step in front of it (what the link exposes,
// who can open it, when it expires). The token is shown ONCE — the list
// endpoint never returns tokens.

import { useState } from "react";
import { Loader2, Plus, Copy, Check, Ban, Trash2, ExternalLink } from "lucide-react";

interface Version {
  id: string;
  versionNumber: number;
  fileName: string;
}

interface ShareLink {
  id: string;
  label: string | null;
  pinnedVersionId: string | null;
  expiresAt: string;
  revoked: boolean;
  revokedAt: string | null;
  createdAt: string;
}

interface CreatedLink {
  id: string;
  label: string | null;
  expiresAt: string;
}

export function ShareLinksTab({
  modelId,
  modelName,
  versions,
  links,
  onChanged,
}: {
  modelId: string;
  modelName: string;
  versions: Version[];
  links: ShareLink[];
  onChanged: () => void;
}) {
  const [showForm, setShowForm] = useState(false);

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          onClick={() => setShowForm((s) => !s)}
          className="flex h-10 items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-paper"
        >
          <Plus className="h-4 w-4" aria-hidden />
          New share link
        </button>
      </div>
      {showForm && (
        <div className="mb-4">
          <ShareLinkForm
            modelId={modelId}
            modelName={modelName}
            versions={versions}
            onDone={() => {
              setShowForm(false);
              onChanged();
            }}
          />
        </div>
      )}
      {links.length === 0 ? (
        <p className="rounded-lg border border-line bg-canvas p-4 text-sm text-muted">
          No share links yet. Links are tokenized, expire automatically, and can
          be revoked at any time — revoked or expired links stop working
          immediately.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-canvas text-left text-xs font-semibold text-muted">
                <th className="px-3 py-2.5">Label</th>
                <th className="px-3 py-2.5">Pinned to</th>
                <th className="px-3 py-2.5">Expires</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {links.map((l) => {
                const expired = new Date(l.expiresAt).getTime() <= Date.now();
                const pinned = versions.find((v) => v.id === l.pinnedVersionId);
                return (
                  <tr key={l.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2.5 font-medium text-ink">{l.label ?? "Untitled link"}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-muted">
                      {pinned ? `v${pinned.versionNumber}` : "Current version"}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted">
                      {new Date(l.expiresAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="rounded-full bg-canvas px-2.5 py-1 text-xs font-semibold text-muted">
                        {l.revoked ? "Revoked" : expired ? "Expired" : "Active"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex justify-end gap-1">
                        {!l.revoked && !expired && (
                          <RevokeButton linkId={l.id} onDone={onChanged} />
                        )}
                        <DeleteButton linkId={l.id} onDone={onChanged} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RevokeButton({ linkId, onDone }: { linkId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        title="Revoke link"
        aria-label="Revoke link"
        className="flex h-8 w-8 items-center justify-center rounded-full text-ink hover:bg-hover"
      >
        <Ban className="h-4 w-4" aria-hidden />
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await fetch(`/api/cad/share-links/${linkId}`, { method: "POST" });
          setBusy(false);
          onDone();
        }}
        className="flex h-8 items-center rounded-full bg-paper px-3 text-xs font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)]"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : "Revoke now"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="flex h-8 items-center rounded-full px-2 text-xs text-muted hover:text-ink"
      >
        Keep
      </button>
    </span>
  );
}

function DeleteButton({ linkId, onDone }: { linkId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch(`/api/cad/share-links/${linkId}`, { method: "DELETE" });
        setBusy(false);
        onDone();
      }}
      title="Delete link"
      aria-label="Delete link"
      className="flex h-8 w-8 items-center justify-center rounded-full text-ink hover:bg-hover"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
    </button>
  );
}

function ShareLinkForm({
  modelId,
  modelName,
  versions,
  onDone,
}: {
  modelId: string;
  modelName: string;
  versions: Version[];
  onDone: () => void;
}) {
  const [label, setLabel] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("14");
  const [pinnedVersionId, setPinnedVersionId] = useState("");
  const [step, setStep] = useState<"fill" | "confirm" | "created">("fill");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ link: CreatedLink; token: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const days = parseInt(expiresInDays, 10);
  const pinned = versions.find((v) => v.id === pinnedVersionId) ?? null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/cad/share-links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          modelId,
          label: label.trim() || null,
          expiresInDays: Number.isInteger(days) && days > 0 ? days : 14,
          pinnedVersionId: pinnedVersionId || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Could not create the link.");
      setCreated({ link: body.link, token: body.token, url: body.url });
      setStep("created");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the link.");
    } finally {
      setBusy(false);
    }
  };

  if (step === "created" && created) {
    return (
      <div className="rounded-lg border border-line bg-paper p-4" role="dialog" aria-label="Share link created">
        <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
          <Check className="h-4 w-4" aria-hidden />
          Link created — copy it now
        </h3>
        <p className="mb-3 text-sm text-muted">
          The token is shown once and never again. Anyone with this URL can view
          the model until the link expires or is revoked.
        </p>
        <div className="mb-3 flex items-center gap-2 rounded-md border border-control bg-canvas p-2">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink">
            {typeof window !== "undefined" ? window.location.origin : ""}{created.url}
          </code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(
                `${window.location.origin}${created.url}`,
              );
              setCopied(true);
            }}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-ink px-3 text-xs font-semibold text-paper"
          >
            {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <button
          type="button"
          onClick={onDone}
          className="flex h-10 items-center rounded-full bg-ink px-5 text-sm font-semibold text-paper"
        >
          Done
        </button>
      </div>
    );
  }

  if (step === "confirm") {
    return (
      <div className="rounded-lg border border-line bg-paper p-4" role="dialog" aria-label="Confirm share link">
        <h3 className="mb-2 text-sm font-semibold text-ink">Confirm share link</h3>
        <dl className="mb-4 space-y-1.5 text-sm">
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-muted">Model</dt>
            <dd className="text-ink">{modelName}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-muted">Exposes</dt>
            <dd className="text-ink">
              {pinned ? `Version v${pinned.versionNumber} (${pinned.fileName})` : "The model's current version at access time"}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-muted">Who can open</dt>
            <dd className="text-ink">Anyone with the URL — no sign-in</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-muted">Expires</dt>
            <dd className="text-ink">
              In {Number.isInteger(days) && days > 0 ? days : 14} days
            </dd>
          </div>
        </dl>
        <p className="mb-4 text-sm text-muted">
          You can revoke this link at any time — revoked links stop working
          immediately.
        </p>
        {error && <p className="mb-2 text-sm text-failed-text">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setStep("fill")}
            className="flex h-10 items-center rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-[inset_0_0_0_1.5px_var(--aos-ink)]"
          >
            Back
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="flex h-10 items-center gap-2 rounded-full bg-ink px-5 text-sm font-semibold text-paper disabled:bg-disabled disabled:text-disabled-fg"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Create link
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line bg-paper p-4">
      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="cad-link-label">
            Label
          </label>
          <input
            id="cad-link-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Review with machine shop"
            className="h-10 w-full rounded-md border border-control bg-paper px-3 text-sm text-ink"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="cad-link-expiry">
            Expires in (days)
          </label>
          <input
            id="cad-link-expiry"
            type="number"
            min={1}
            max={730}
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
            className="h-10 w-full rounded-md border border-control bg-paper px-3 text-sm text-ink"
          />
        </div>
      </div>
      <div className="mb-3">
        <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="cad-link-pin">
          Pin to a version <span className="font-normal text-muted">(empty = current version at access time)</span>
        </label>
        <select
          id="cad-link-pin"
          value={pinnedVersionId}
          onChange={(e) => setPinnedVersionId(e.target.value)}
          className="h-10 w-full rounded-md border border-control bg-paper px-3 text-sm text-ink"
        >
          <option value="">Current version</option>
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              v{v.versionNumber} — {v.fileName}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="mb-2 text-sm text-failed-text">{error}</p>}
      <button
        type="button"
        onClick={() => setStep("confirm")}
        className="flex h-10 items-center gap-1.5 rounded-full bg-ink px-5 text-sm font-semibold text-paper"
      >
        <ExternalLink className="h-4 w-4" aria-hidden />
        Review link
      </button>
    </div>
  );
}
