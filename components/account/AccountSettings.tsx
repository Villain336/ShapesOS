// ShapesOS — Settings → Your account (Phase 4a, GDPR).
// Download your data (streamed JSON from /api/account/export) and delete
// your account: the email typed back, then the shared confirm dialog, then
// DELETE /api/account and sign-out. The page passes the server's plan
// (which workspaces go, which you leave, what blocks it); the API
// re-checks every rule.

"use client";

import { useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { Download, Trash2 } from "lucide-react";
import { FormError } from "@/components/workspace/FormError";
import { btnDanger, btnSecondary, cardCls, helperCls, inputCls, labelCls } from "@/components/workspace/aos";
import { confirmAction } from "@/lib/ui/feedback";

export interface AccountSettingsProps {
  account: { id: string; email: string | null; name: string | null };
  confirmText: string;
  deleteWorkspaces: { id: string; name: string }[];
  leaveWorkspaces: { id: string; name: string }[];
  blockedMessage: string | null;
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export default function AccountSettings(props: AccountSettingsProps) {
  const { account, confirmText } = props;
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = typed.trim().length > 0 && typed.trim().toLowerCase() === confirmText.toLowerCase();

  async function remove(e: React.FormEvent) {
    e.preventDefault();
    if (!matches || props.blockedMessage) return;
    const ok = await confirmAction({
      title: "Delete your account?",
      description:
        "You'll be signed out, and this can't be undone." +
        (props.deleteWorkspaces.length ? ` ${list(props.deleteWorkspaces.map((w) => w.name))} will be deleted with everything in ${props.deleteWorkspaces.length === 1 ? "it" : "them"}.` : ""),
      confirmLabel: "Delete account",
      destructive: true,
    });
    if (!ok) return;
    setDeleting(true);
    setError(null);
    const r = await fetch("/api/account", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: typed }),
    });
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) {
      setDeleting(false);
      setError(data.error ?? "Couldn't delete your account. Try again.");
      return;
    }
    await signOut({ callbackUrl: "/login" });
  }

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <section className={cardCls} aria-labelledby="acct-who">
        <h2 id="acct-who" className="aos-subheading">Signed in as</h2>
        <dl className="mt-3 grid gap-2 text-base sm:grid-cols-[8rem_1fr]">
          {account.name && (
            <>
              <dt className="text-muted">Name</dt>
              <dd className="text-ink">{account.name}</dd>
            </>
          )}
          <dt className="text-muted">Email</dt>
          <dd className="text-ink">{account.email ?? "Not shared by your sign-in provider"}</dd>
          <dt className="text-muted">Account ID</dt>
          <dd className="aos-mono break-all text-sm text-ink">{account.id}</dd>
        </dl>
      </section>

      <section className={cardCls} aria-labelledby="acct-export">
        <h2 id="acct-export" className="aos-subheading">Download your data</h2>
        <p className="mt-2 text-base text-muted">
          A JSON file with your account, your workspace memberships and invites, and everything you created or
          approved in your workspaces. Passwords, keys and other secrets are never included.
        </p>
        <div className="mt-3">
          <a href="/api/account/export" download className={btnSecondary}>
            <Download size={16} aria-hidden />
            Download my data
          </a>
        </div>
        <p className={helperCls}>
          To export a whole workspace, open{" "}
          <Link href="/dashboard/settings/workspace#ws-export" className="font-semibold text-ink underline underline-offset-2">
            General
          </Link>{" "}
          as an owner or admin.
        </p>
      </section>

      <section className={cardCls} aria-labelledby="acct-delete">
        <h2 id="acct-delete" className="aos-subheading">Delete your account</h2>
        <div className="mt-2 flex flex-col gap-2 text-base text-muted">
          <p>Removes you from every workspace and deletes your notifications, keys and personal records. Anything you made in a shared workspace stays with that workspace, no longer linked to you.</p>
          {props.deleteWorkspaces.length > 0 && (
            <p>
              You&rsquo;re the only member of {list(props.deleteWorkspaces.map((w) => w.name))}, so{" "}
              {props.deleteWorkspaces.length === 1 ? "it" : "they"} will be deleted with everything in{" "}
              {props.deleteWorkspaces.length === 1 ? "it" : "them"}.
            </p>
          )}
          {props.leaveWorkspaces.length > 0 && <p>You&rsquo;ll leave {list(props.leaveWorkspaces.map((w) => w.name))}.</p>}
          <p>This can&rsquo;t be undone. Download your data first if you want a copy.</p>
        </div>
        {props.blockedMessage ? (
          <FormError id="acct-delete-blocked" message={props.blockedMessage} />
        ) : (
          <form onSubmit={remove} className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start">
            <div className="flex-1">
              <label htmlFor="acct-delete-input" className={labelCls}>
                Type <span className="aos-mono">{confirmText}</span> to confirm
              </label>
              <input
                id="acct-delete-input"
                className={`${inputCls} mt-1`}
                value={typed}
                autoComplete="off"
                onChange={(e) => setTyped(e.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "acct-delete-error" : undefined}
              />
              <FormError id="acct-delete-error" message={error} />
            </div>
            <button type="submit" className={`${btnDanger} sm:mt-6`} disabled={deleting || !matches}>
              <Trash2 size={16} aria-hidden />
              {deleting ? "Deleting" : "Delete account"}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
