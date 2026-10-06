// Marketr — security settings page (milestone 21, part D1).
// Admin+ only (server-gated), read-only display: SSO auto-provisioning status,
// secrets provider, and session/auth notes. No secret material is shown.
// Phase 4a: the require-2FA policy (owners toggle, admins see it) and SCIM
// provisioning tokens (owners only), via WorkspaceSecurityControls.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { ssoAutoProvisioningConfigured } from "@/lib/sso";
import { getSecretsProvider } from "@/lib/secrets";
import SettingsNav from "@/components/settings/SettingsNav";
import { WorkspaceSecurityControls } from "@/components/security/WorkspaceSecurityControls";

export const dynamic = "force-dynamic";

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs ${
        ok ? "bg-canvas text-muted border border-line" : "bg-canvas text-muted"
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
        <h1 className="aos-heading">Security</h1>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          {workspace.name} — authentication, SSO, and secret-storage posture.
          Read-only; changes happen on the host via environment.
        </p>
      </div>
      <SettingsNav />

      {/* Phase 4a: require-2FA policy (owners change it) + SCIM tokens (owners). */}
      <WorkspaceSecurityControls isOwner={membership.role === "owner"} />

      <div className="rounded-xl border border-line bg-paper p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Single sign-on (SSO)</h2>
          <StatusBadge
            ok={ssoOn}
            label={ssoOn ? "auto-provisioning on" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-muted">Domain</dt>
            <dd className="font-mono text-xs">{ssoDomain || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Default role for provisioned users</dt>
            <dd className="font-mono text-xs">{ssoOn ? ssoDefaultRole : "—"}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted">
          {ssoOn
            ? "Users signing in via the OIDC/SAML provider with a verified email on this domain are added to the SSO workspace automatically. SSO can never mint owners, and invites are claimed via single-use token links."
            : "Set SSO_WORKSPACE_ID and SSO_DOMAIN on the host to enable domain-based auto-provisioning (env values only — never shown here)."}
        </p>
      </div>

      <div className="rounded-xl border border-line bg-paper p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Secrets provider</h2>
          <StatusBadge ok={secretsProviderId === "env"} label={secretsProviderId} />
        </div>
        <p className="mt-3 text-xs text-muted">
          Connector credentials and provider keys are encrypted with AES-256-GCM
          through this provider (env key by default, KMS-ready). Encrypt/decrypt
          happen server-side only — secrets are never sent to the browser.
          Selected via SECRETS_PROVIDER; the key itself is never displayed.
        </p>
      </div>

      <div className="rounded-xl border border-line bg-paper p-5">
        <h2 className="font-medium">Sessions & sign-in</h2>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-muted">Session strategy</dt>
            <dd>JWT, 12-hour absolute lifetime — re-authentication required after that.</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Sign-in methods</dt>
            <dd>
              Google, credentials, and SAML/OIDC where configured; passkeys. Members manage their own authenticator app and
              passkeys under Your security.
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted">
          Pending member invites are single-use token links valid 7 days; bare
          email matching never grants access.
        </p>
      </div>
    </div>
  );
}
