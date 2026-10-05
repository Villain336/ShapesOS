"use client";

// ShapesOS — workspace security controls (Phase 4a): the "require two-factor
// authentication" policy and SCIM provisioning tokens. Owners change them;
// admins see the policy read-only. The server enforces both rules.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Copy, Loader2, Plus, Users } from "lucide-react";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import { UpgradeNotice } from "@/components/billing/UpgradeNotice";
import { btnDelete, btnPrimary, btnSecondary, cardCls, chipCls, chipMutedCls, helpCls, inputCls, labelCls } from "./ui";

interface Policy {
  requireTwoFactor: boolean;
  canEdit: boolean;
  members: { total: number; withoutTwoFactor: number };
}

interface ScimToken {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never";

function Switch({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors disabled:opacity-40 ${checked ? "bg-ink" : "bg-disabled-fg"}`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-[3px] h-5 w-5 rounded-full bg-paper transition-all ${checked ? "left-[21px]" : "left-[3px]"}`}
      />
    </button>
  );
}

function TwoFactorPolicy() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      api<Policy>("/api/settings/security/policy").then(setPolicy, (e: unknown) =>
        toastError(e instanceof Error ? e.message : "Couldn't load the security policy."),
      ),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function change(next: boolean) {
    if (!policy) return;
    if (next) {
      const ok = await confirmAction({
        title: "Require two-factor authentication?",
        description:
          policy.members.withoutTwoFactor > 0
            ? `${policy.members.withoutTwoFactor} of ${policy.members.total} members haven't set it up yet. They'll be asked to before they can use this workspace.`
            : "Every member will need an authenticator app or a passkey to use this workspace.",
        confirmLabel: "Require it",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api("/api/settings/security/policy", { method: "PUT", body: { requireTwoFactor: next } });
      toast(next ? "Two-factor authentication required" : "Requirement turned off");
      await load();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Couldn't change the policy.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={cardCls} aria-labelledby="policy-heading">
      <div className="flex items-center justify-between gap-3">
        <h2 id="policy-heading" className="aos-subheading">
          Require two-factor authentication
        </h2>
        {policy && (
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-ink">{policy.requireTwoFactor ? "Required" : "Optional"}</span>
            <Switch
              checked={policy.requireTwoFactor}
              disabled={!policy.canEdit || busy}
              onChange={change}
              label="Require two-factor authentication"
            />
          </div>
        )}
      </div>
      <p className={`${helpCls} mt-1`}>
        When on, members must sign in with an authenticator app or a passkey before they can use this workspace. Members
        without one are taken to set it up.
      </p>
      {policy && (
        <p className={`${helpCls} mt-3 flex items-center gap-2`}>
          <Users className="size-4" aria-hidden="true" />
          {policy.members.total - policy.members.withoutTwoFactor} of {policy.members.total} members have two-factor set up.
          {!policy.canEdit && " Only owners can change this."}
        </p>
      )}
    </section>
  );
}

function ScimTokens() {
  const [tokens, setTokens] = useState<ScimToken[] | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; raw: string } | null>(null);
  // Phase 15.3 (pricing): SCIM is a plan feature; the server refuses new
  // tokens without it, so the form is replaced by the upgrade notice.
  const [upgradeMessage, setUpgradeMessage] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api<{ tokens: ScimToken[]; endpoint: string; entitled?: boolean; upgradeMessage?: string | null }>(
        "/api/settings/security/scim-tokens",
      ).then(
        (data) => {
          setTokens(data.tokens);
          setEndpoint(data.endpoint);
          setUpgradeMessage(data.entitled === false ? (data.upgradeMessage ?? "SCIM provisioning isn't included in your plan.") : null);
        },
        (e: unknown) => toastError(e instanceof Error ? e.message : "Couldn't load SCIM tokens."),
      ),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ token: ScimToken; raw: string }>("/api/settings/security/scim-tokens", {
        method: "POST",
        body: { name: name.trim() },
      });
      setCreated({ name: res.token.name, raw: res.raw });
      setName("");
      await load();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Couldn't create the token.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(t: ScimToken) {
    const ok = await confirmAction({
      title: `Revoke "${t.name}"?`,
      description: "Your identity provider stops syncing users and groups with this token right away.",
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/api/settings/security/scim-tokens/${encodeURIComponent(t.id)}`, { method: "DELETE" });
      toast("Token revoked");
      await load();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Couldn't revoke the token.");
    }
  }

  const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => toast(`${what} copied`));

  return (
    <section className={cardCls} aria-labelledby="scim-heading">
      <div className="flex items-center justify-between gap-2">
        <h2 id="scim-heading" className="aos-subheading">
          SCIM provisioning
        </h2>
        <span className={tokens?.some((t) => !t.revokedAt) ? chipCls : chipMutedCls}>
          {tokens?.some((t) => !t.revokedAt) ? "Connected" : "Not connected"}
        </span>
      </div>
      <p className={`${helpCls} mt-1`}>
        Let your identity provider (Okta, Microsoft Entra ID, OneLogin…) add, update and remove members. Turning a user off
        there removes their access here at once. Groups named after a role (for example &ldquo;ShapesOS Admins&rdquo;,
        &ldquo;Editors&rdquo;, &ldquo;Viewers&rdquo;) set that role. Owners are never changed through SCIM.
      </p>
      {endpoint && (
        <div className="mt-3">
          <p className={labelCls}>SCIM base URL</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-canvas px-3 py-2 font-mono text-sm text-ink">{endpoint}</code>
            <button type="button" className={btnSecondary} onClick={() => copy(endpoint, "URL")}>
              <Copy className="size-4" aria-hidden="true" />
              Copy
            </button>
          </div>
        </div>
      )}

      {created && (
        <div className="mt-4 rounded-md bg-canvas p-4">
          <p className="text-sm font-semibold text-ink">Copy the token for &ldquo;{created.name}&rdquo; now</p>
          <p className={`${helpCls} mt-1`}>Paste it into your identity provider as the bearer token. It won&apos;t be shown again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md bg-paper px-3 py-2 font-mono text-sm text-ink shadow-hairline">
              {created.raw}
            </code>
            <button type="button" className={btnSecondary} onClick={() => copy(created.raw, "Token")}>
              <Copy className="size-4" aria-hidden="true" />
              Copy
            </button>
          </div>
          <button type="button" className={`${btnPrimary} mt-3`} onClick={() => setCreated(null)}>
            Done
          </button>
        </div>
      )}

      {tokens && tokens.length > 0 && (
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="text-xs text-muted">
              <th className="py-2 pr-3 font-semibold">Name</th>
              <th className="py-2 pr-3 font-semibold">Token</th>
              <th className="py-2 pr-3 font-semibold">Last used</th>
              <th className="py-2 text-right font-semibold">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} className="border-t border-line">
                <td className="py-2 pr-3 font-semibold text-ink">{t.name}</td>
                <td className="py-2 pr-3 font-mono text-xs text-muted">{t.tokenPrefix}</td>
                <td className="py-2 pr-3 text-muted">{t.revokedAt ? `revoked ${fmt(t.revokedAt)}` : fmt(t.lastUsedAt)}</td>
                <td className="py-2 text-right">
                  {!t.revokedAt && (
                    <button type="button" className={btnDelete} onClick={() => revoke(t)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {upgradeMessage ? (
        <div className="mt-4">
          <UpgradeNotice message={upgradeMessage} />
        </div>
      ) : (
      <form onSubmit={create} className="mt-4 flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor="scim-name" className={labelCls}>
            New token name
          </label>
          <input
            id="scim-name"
            maxLength={80}
            placeholder="e.g. Okta"
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button type="submit" className={btnPrimary} disabled={busy || !name.trim()}>
          {busy ? <Loader2 className="size-4 aos-spin" aria-hidden="true" /> : <Plus className="size-4" aria-hidden="true" />}
          {busy ? "Creating" : "Create token"}
        </button>
      </form>
      )}
    </section>
  );
}

export function WorkspaceSecurityControls({ isOwner }: { isOwner: boolean }) {
  return (
    <>
      <TwoFactorPolicy />
      {isOwner && <ScimTokens />}
    </>
  );
}
