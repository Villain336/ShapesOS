"use client";

// ShapesOS — your account's two-factor authentication and passkeys
// (Phase 4a). Used by Settings → Your security and by /security/setup (the
// page a workspace's "require 2FA" policy redirects to).
//
// Sensitive changes (turn off the app, new recovery codes, remove a passkey)
// need a recent second factor: when the server answers reauth_required the
// panel asks for a code or a passkey, then retries.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Copy, Download, KeyRound, Loader2, Pencil, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import {
  isPasskeyCancel,
  reauthWithPasskey,
  redeemProof,
  registerPasskey,
  usePasskeySupport,
} from "./client";
import {
  btnDelete,
  btnPrimary,
  btnQuiet,
  btnSecondary,
  cardCls,
  chipCls,
  chipMutedCls,
  helpCls,
  inputCls,
  labelCls,
} from "./ui";

interface PasskeyView {
  id: string;
  name: string;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface SecurityView {
  totp: { enabled: boolean; enabledAt: string | null };
  recoveryCodesRemaining: number;
  passkeys: PasskeyView[];
  requiredBy: Array<{ id: string; name: string }>;
  session: { twoFactor: boolean; mfaAt: number | null };
}

interface Enrollment {
  secret: string;
  otpauthUri: string;
  qr: string;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number,
  ) {
    super(message);
  }
}

async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok) throw new ApiError(data.error ?? "Request failed", data.code ?? null, res.status);
  return data;
}

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "never";

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join("\n");
  return (
    <div className="mt-4 rounded-md bg-canvas p-4">
      <p className="text-sm font-semibold text-ink">Save your recovery codes</p>
      <p className={`${helpCls} mt-1`}>
        Each code works once if you lose your phone. They won&apos;t be shown again.
      </p>
      <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm text-ink">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className={btnSecondary}
          onClick={() => navigator.clipboard.writeText(text).then(() => toast("Codes copied"))}
        >
          <Copy className="size-4" aria-hidden="true" />
          Copy
        </button>
        <button
          type="button"
          className={btnSecondary}
          onClick={() => {
            const url = URL.createObjectURL(new Blob([`ShapesOS recovery codes\n\n${text}\n`], { type: "text/plain" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = "shapesos-recovery-codes.txt";
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download className="size-4" aria-hidden="true" />
          Download
        </button>
        <button type="button" className={btnPrimary} onClick={onDone}>
          I saved them
        </button>
      </div>
    </div>
  );
}

/** Inline "confirm it's you" step for sensitive changes. */
function Reauth({
  hasTotp,
  hasPasskey,
  onVerified,
  onCancel,
}: {
  hasTotp: boolean;
  hasPasskey: boolean;
  onVerified: (code: string | null) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canPasskey = usePasskeySupport();
  async function viaPasskey() {
    setBusy(true);
    setError(null);
    try {
      const res = await reauthWithPasskey();
      if (res.ok) onVerified(null);
      else setError("That passkey didn't work. Try again.");
    } catch (err) {
      if (!isPasskeyCancel(err)) setError("Your passkey couldn't be checked. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-4 rounded-md bg-canvas p-4">
      <p className="text-sm font-semibold text-ink">Confirm it&apos;s you</p>
      {hasTotp && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (code.trim()) onVerified(code.trim());
          }}
        >
          <div className="min-w-0 flex-1">
            <label htmlFor="reauth-code" className={labelCls}>
              Authenticator or recovery code
            </label>
            <input
              id="reauth-code"
              autoFocus
              autoComplete="one-time-code"
              className={`${inputCls} font-mono`}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <button type="submit" className={btnPrimary} disabled={!code.trim() || busy}>
            Confirm
          </button>
        </form>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {hasPasskey && canPasskey && (
          <button type="button" className={btnSecondary} onClick={viaPasskey} disabled={busy}>
            {busy ? <Loader2 className="size-4 aos-spin" aria-hidden="true" /> : <KeyRound className="size-4" aria-hidden="true" />}
            Use a passkey
          </button>
        )}
        <button type="button" className={btnQuiet} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-failed-text">{error}</p>}
    </div>
  );
}

export function AccountSecurityPanel({ onSecured }: { onSecured?: () => void }) {
  const [view, setView] = useState<SecurityView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [newPasskeyName, setNewPasskeyName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  // A sensitive action waiting on re-auth: re-run with the code (or null after a passkey check).
  const [pendingAction, setPendingAction] = useState<((code: string | null) => Promise<void>) | null>(null);
  const canPasskey = usePasskeySupport();

  const load = useCallback(
    () =>
      api<SecurityView>("/api/account/security").then(
        (v) => {
          setView(v);
          setLoadError(null);
        },
        (e: unknown) => setLoadError(e instanceof Error ? e.message : "Couldn't load your security settings."),
      ),
    [],
  );
  const refresh = load;

  useEffect(() => {
    void load();
  }, [load]);

  /** Run a sensitive action; on reauth_required, ask and retry. */
  async function sensitive(run: (code: string | null) => Promise<void>) {
    try {
      await run(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === "reauth_required") {
        setPendingAction(() => run);
        return;
      }
      toastError(e instanceof Error ? e.message : "That didn't work.");
    }
  }

  async function startEnrollment() {
    setBusy("enroll");
    try {
      setEnrollment(await api<Enrollment>("/api/account/security/totp", { method: "POST", body: {} }));
      setCode("");
      setCodeError(null);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Couldn't start setup.");
    } finally {
      setBusy(null);
    }
  }

  async function confirmEnrollment(e: FormEvent) {
    e.preventDefault();
    setBusy("confirm");
    setCodeError(null);
    try {
      const res = await api<{ recoveryCodes: string[]; proof: string }>("/api/account/security/totp", {
        method: "PUT",
        body: { code: code.trim() },
      });
      // Upgrade this session to "second factor passed" right away.
      await redeemProof(res.proof);
      setEnrollment(null);
      setCodes(res.recoveryCodes);
      toast("Authenticator app turned on");
      await refresh();
    } catch (err) {
      setCodeError(err instanceof Error ? err.message : "That code didn't match.");
    } finally {
      setBusy(null);
    }
  }

  async function disableTotp() {
    const ok = await confirmAction({
      title: "Turn off the authenticator app?",
      description: "Your recovery codes stop working too. Sign-in will no longer ask for a code from this app.",
      confirmLabel: "Turn off",
      destructive: true,
    });
    if (!ok) return;
    await sensitive(async (c) => {
      await api("/api/account/security/totp", { method: "DELETE", body: c ? { code: c } : {} });
      toast("Authenticator app turned off");
      await refresh();
    });
  }

  async function newRecoveryCodes() {
    const ok = await confirmAction({
      title: "Make new recovery codes?",
      description: "Your current codes stop working.",
      confirmLabel: "Make new codes",
    });
    if (!ok) return;
    await sensitive(async (c) => {
      const res = await api<{ recoveryCodes: string[] }>("/api/account/security/recovery-codes", {
        method: "POST",
        body: c ? { code: c } : {},
      });
      setCodes(res.recoveryCodes);
      await refresh();
    });
  }

  async function addPasskey(e: FormEvent) {
    e.preventDefault();
    const name = newPasskeyName.trim() || "Passkey";
    setBusy("passkey");
    try {
      await registerPasskey(name);
      setNewPasskeyName("");
      toast("Passkey added");
      await refresh();
    } catch (err) {
      if (!isPasskeyCancel(err)) toastError(err instanceof Error ? err.message : "Couldn't add the passkey.");
    } finally {
      setBusy(null);
    }
  }

  async function saveRename(e: FormEvent) {
    e.preventDefault();
    if (!renaming) return;
    try {
      await api(`/api/account/security/passkeys/${encodeURIComponent(renaming.id)}`, {
        method: "PATCH",
        body: { name: renaming.name },
      });
      setRenaming(null);
      toast("Passkey renamed");
      await refresh();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Couldn't rename the passkey.");
    }
  }

  async function removePasskey(p: PasskeyView) {
    const ok = await confirmAction({
      title: `Remove "${p.name}"?`,
      description: "You won't be able to sign in with this passkey any more.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    await sensitive(async (c) => {
      await api(`/api/account/security/passkeys/${encodeURIComponent(p.id)}`, {
        method: "DELETE",
        body: c ? { code: c } : {},
      });
      toast("Passkey removed");
      await refresh();
    });
  }

  if (loadError) return <p className="text-sm text-failed-text">{loadError}</p>;
  if (!view) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Loader2 className="size-4 aos-spin" aria-hidden="true" />
        Loading
      </p>
    );
  }

  const secured = view.totp.enabled || view.passkeys.length > 0;

  return (
    <div className="flex flex-col gap-4">
      {view.requiredBy.length > 0 && (
        <div className="rounded-md bg-canvas p-4 text-sm text-ink">
          {view.requiredBy.map((w) => w.name).join(", ")} {view.requiredBy.length === 1 ? "requires" : "require"} two-factor
          authentication.
          {!view.session.twoFactor && " Set up an authenticator app or a passkey to keep working there."}
        </div>
      )}

      {pendingAction && (
        <Reauth
          hasTotp={view.totp.enabled}
          hasPasskey={view.passkeys.length > 0}
          onCancel={() => setPendingAction(null)}
          onVerified={async (c) => {
            const run = pendingAction;
            setPendingAction(null);
            try {
              // A passkey check refreshed the session; a code rides along.
              await run(c);
            } catch (e) {
              if (e instanceof ApiError && e.code === "reauth_required") setPendingAction(() => run);
              toastError(e instanceof Error ? e.message : "That didn't work.");
            }
          }}
        />
      )}

      <section className={cardCls} aria-labelledby="totp-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="totp-heading" className="aos-subheading flex items-center gap-2">
            <Smartphone size={18} aria-hidden="true" />
            Authenticator app
          </h2>
          <span className={view.totp.enabled ? chipCls : chipMutedCls}>{view.totp.enabled ? "On" : "Off"}</span>
        </div>
        <p className={`${helpCls} mt-1`}>
          After your password or SSO, sign-in asks for a 6-digit code from an app like 1Password, Google Authenticator or
          Authy.
        </p>

        {view.totp.enabled ? (
          <>
            <p className={`${helpCls} mt-3`}>
              On since {fmt(view.totp.enabledAt)}. {view.recoveryCodesRemaining} of 10 recovery codes left.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className={btnSecondary} onClick={newRecoveryCodes}>
                Make new recovery codes
              </button>
              <button type="button" className={btnDelete} onClick={disableTotp}>
                Turn off
              </button>
            </div>
          </>
        ) : enrollment ? (
          <div className="mt-4 grid gap-4 md:grid-cols-[auto,1fr]">
            {/* eslint-disable-next-line @next/next/no-img-element -- data: URL QR code */}
            <img src={enrollment.qr} alt="QR code to scan with your authenticator app" className="size-44 rounded-md bg-paper shadow-hairline" />
            <form onSubmit={confirmEnrollment} className="flex min-w-0 flex-col gap-3">
              <div>
                <p className={labelCls}>Can&apos;t scan? Enter this key</p>
                <code className="block break-all rounded-md bg-canvas px-3 py-2 font-mono text-sm text-ink">{enrollment.secret}</code>
              </div>
              <div>
                <label htmlFor="totp-code" className={labelCls}>
                  Code from the app
                </label>
                <input
                  id="totp-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  aria-invalid={codeError !== null}
                  aria-describedby={codeError ? "totp-error" : undefined}
                  className={`${inputCls} font-mono ${codeError ? "border-failed" : ""}`}
                />
                {codeError && (
                  <p id="totp-error" role="alert" className="mt-1 flex items-center gap-2 text-sm text-failed-text">
                    <span aria-hidden="true" className="inline-block size-2 shrink-0 bg-failed" />
                    {codeError}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="submit" className={btnPrimary} disabled={busy === "confirm" || code.trim().length < 6}>
                  {busy === "confirm" ? <Loader2 className="size-4 aos-spin" aria-hidden="true" /> : null}
                  {busy === "confirm" ? "Turning on" : "Turn on"}
                </button>
                <button type="button" className={btnQuiet} onClick={() => setEnrollment(null)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        ) : (
          <div className="mt-4">
            <button type="button" className={btnPrimary} onClick={startEnrollment} disabled={busy === "enroll"}>
              {busy === "enroll" ? <Loader2 className="size-4 aos-spin" aria-hidden="true" /> : null}
              {busy === "enroll" ? "Starting" : "Set up authenticator app"}
            </button>
          </div>
        )}

        {codes && (
          <RecoveryCodes
            codes={codes}
            onDone={() => {
              setCodes(null);
              onSecured?.();
            }}
          />
        )}
      </section>

      <section className={cardCls} aria-labelledby="passkeys-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="passkeys-heading" className="aos-subheading flex items-center gap-2">
            <KeyRound size={18} aria-hidden="true" />
            Passkeys
          </h2>
          <span className={view.passkeys.length ? chipCls : chipMutedCls}>
            {view.passkeys.length} {view.passkeys.length === 1 ? "passkey" : "passkeys"}
          </span>
        </div>
        <p className={`${helpCls} mt-1`}>
          Sign in with your fingerprint, face or device PIN instead of a password and code. A passkey also counts as your
          second factor.
        </p>

        {view.passkeys.length > 0 && (
          <table className="mt-4 w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-muted">
                <th className="py-2 pr-3 font-semibold">Name</th>
                <th className="py-2 pr-3 font-semibold">Added</th>
                <th className="py-2 pr-3 font-semibold">Last used</th>
                <th className="py-2 text-right font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {view.passkeys.map((p) => (
                <tr key={p.id} className="border-t border-line">
                  <td className="py-2 pr-3 text-ink">
                    {renaming?.id === p.id ? (
                      <form onSubmit={saveRename} className="flex items-center gap-2">
                        <input
                          aria-label="Passkey name"
                          autoFocus
                          maxLength={60}
                          className={`${inputCls} h-control-sm`}
                          value={renaming.name}
                          onChange={(e) => setRenaming({ id: p.id, name: e.target.value })}
                        />
                        <button type="submit" className={btnPrimary} disabled={!renaming.name.trim()}>
                          Save
                        </button>
                        <button type="button" className={btnQuiet} onClick={() => setRenaming(null)}>
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <span className="font-semibold">{p.name}</span>
                    )}
                    {p.backedUp && renaming?.id !== p.id && <span className="ml-2 text-xs text-muted">synced</span>}
                  </td>
                  <td className="py-2 pr-3 text-muted">{fmt(p.createdAt)}</td>
                  <td className="py-2 pr-3 text-muted">{fmt(p.lastUsedAt)}</td>
                  <td className="py-2 text-right">
                    <div className="inline-flex gap-1">
                      <button
                        type="button"
                        className={btnQuiet}
                        aria-label={`Rename ${p.name}`}
                        onClick={() => setRenaming({ id: p.id, name: p.name })}
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </button>
                      <button type="button" className={btnQuiet} aria-label={`Remove ${p.name}`} onClick={() => removePasskey(p)}>
                        <Trash2 className="size-4 text-failed-text" aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {canPasskey ? (
          <form onSubmit={addPasskey} className="mt-4 flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor="passkey-name" className={labelCls}>
                Name
              </label>
              <input
                id="passkey-name"
                maxLength={60}
                placeholder="e.g. Work laptop"
                className={inputCls}
                value={newPasskeyName}
                onChange={(e) => setNewPasskeyName(e.target.value)}
              />
            </div>
            <button type="submit" className={btnPrimary} disabled={busy === "passkey"}>
              {busy === "passkey" ? <Loader2 className="size-4 aos-spin" aria-hidden="true" /> : null}
              {busy === "passkey" ? "Waiting for your device" : "Add a passkey"}
            </button>
          </form>
        ) : (
          <p className={`${helpCls} mt-4`}>This browser doesn&apos;t support passkeys.</p>
        )}
      </section>

      {secured && onSecured && view.session.twoFactor && (
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-ink" aria-hidden="true" />
          <span className="text-sm text-ink">Two-factor authentication is on for this session.</span>
          <button type="button" className={`${btnPrimary} ml-auto`} onClick={onSecured}>
            Continue
          </button>
        </div>
      )}
    </div>
  );
}
