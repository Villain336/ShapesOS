// Marketr — security settings page (milestone 21, part D1).
// Admin+ only (server-gated), read-only display: SSO auto-provisioning status,
// secrets provider, and session/auth notes. No secret material is shown.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { ssoAutoProvisioningConfigured } from "@/lib/sso";
import { getSecretsProvider } from "@/lib/secrets";
import SettingsNav from "@/components/settings/SettingsNav";

export const dynamic = "force-dynamic";

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs ${
        ok ? "bg-emerald-50 text-emerald-700" : "bg-zinc-100 text-zinc-500"
      }`}
    >
      {label}
    </span>
  );
}

export default async function SecuritySettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");

  const ssoOn = ssoAutoProvisioningConfigured();
  const ssoDomain = (process.env.SSO_DOMAIN ?? "").trim();
  const ssoDefaultRole = (process.env.SSO_DEFAULT_ROLE ?? "editor").trim();
  let secretsProviderId: string;
  try {
    secretsProviderId = getSecretsProvider().id;
  } catch (e) {
    secretsProviderId = `misconfigured: ${e instanceof Error ? e.message : "unknown error"}`;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Security</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {workspace.name} — authentication, SSO, and secret-storage posture.
          Read-only; changes happen on the host via environment.
        </p>
      </div>
      <SettingsNav />

      <div className="rounded-xl border border-zinc-200 bg-white/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Single sign-on (SSO)</h2>
          <StatusBadge
            ok={ssoOn}
            label={ssoOn ? "auto-provisioning on" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-zinc-500">Domain</dt>
            <dd className="font-mono text-xs">{ssoDomain || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Default role for provisioned users</dt>
            <dd className="font-mono text-xs">{ssoOn ? ssoDefaultRole : "—"}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-zinc-500">
          {ssoOn
            ? "Users signing in via the OIDC/SAML provider with a verified email on this domain are added to the SSO workspace automatically. SSO can never mint owners, and invites are claimed via single-use token links."
            : "Set SSO_WORKSPACE_ID and SSO_DOMAIN on the host to enable domain-based auto-provisioning (env values only — never shown here)."}
        </p>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Secrets provider</h2>
          <StatusBadge ok={secretsProviderId === "env"} label={secretsProviderId} />
        </div>
        <p className="mt-3 text-xs text-zinc-500">
          Connector credentials and provider keys are encrypted with AES-256-GCM
          through this provider (env key by default, KMS-ready). Encrypt/decrypt
          happen server-side only — secrets are never sent to the browser.
          Selected via SECRETS_PROVIDER; the key itself is never displayed.
        </p>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white/60 p-5">
        <h2 className="font-medium">Sessions & sign-in</h2>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-zinc-500">Session strategy</dt>
            <dd>JWT, 12-hour absolute lifetime — re-authentication required after that.</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Sign-in methods</dt>
            <dd>Google, credentials, and SAML/OIDC where configured.</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-zinc-500">
          Pending member invites are single-use token links valid 7 days; bare
          email matching never grants access.
        </p>
      </div>
    </div>
  );
}
