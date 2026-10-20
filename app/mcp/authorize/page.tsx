// ShapesOS — OAuth consent screen (Phase C, W5; G3 workspace picker).
//
// Browser page showing the EXACT scopes the client requested, rendered from
// the AES-GCM-sealed grant (server-side decrypt), plus a workspace picker:
// the token binds to the workspace the approver CHOOSES here (previously the
// approver's default workspace). The choice is membership-verified again on
// POST (T14).
//
// Phase 1 (anti-phishing): the page names the app (self-declared at dynamic
// registration, so labelled unverified) and the host the approval is sent
// back to, never just the random client id. Only workspaces where the user
// is an editor or above are offered — viewers can't approve MCP access.

import { redirect } from "next/navigation";
import { requireUser, getAccessibleWorkspaces, getOrCreateWorkspace } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { secrets } from "@/lib/secrets";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { SCOPE_LABELS, type McpToolName } from "@/lib/mcp/scopes";
import { MCP_CONSENT_MIN_ROLE, type PendingAuthorization } from "@/lib/mcp/oauth";
import { ConsentForm } from "./ConsentForm";

export const dynamic = "force-dynamic";

function toolNameOf(scope: string): McpToolName | null {
  const name = scope.startsWith("tools:") ? scope.slice(6) : "";
  return name in SCOPE_LABELS ? (name as McpToolName) : null;
}

/** Host the authorization code is delivered to (shown so phishing is visible). */
function redirectHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

export default async function McpAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<{ grant?: string }>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const { grant } = await searchParams;
  let pending: PendingAuthorization | null = null;
  try {
    if (grant) pending = JSON.parse(secrets().decrypt(grant)) as PendingAuthorization;
  } catch {
    pending = null;
  }
  if (!pending || !Array.isArray(pending.scopes)) {
    return (
      <div className="min-h-dvh bg-canvas px-4 py-10">
        <div className="mx-auto max-w-lg rounded-lg bg-paper p-6 shadow-hairline">
          <h1 className="aos-heading">Authorization failed</h1>
          <p className="mt-2 text-sm text-muted">
            The authorization request is invalid or expired. Start the connection again from the app.
          </p>
        </div>
      </div>
    );
  }
  const scopes = pending.scopes
    .map((s) => ({ scope: s, label: toolNameOf(s) ? SCOPE_LABELS[toolNameOf(s)!] : null }))
    .filter((s) => s.label);

  const client = await prisma.mcpOAuthClient.findUnique({
    where: { clientId: pending.clientId },
    select: { clientName: true },
  });
  const clientName = client?.clientName?.trim() || "An unnamed app";
  const host = redirectHost(pending.redirectUri);

  // Workspace picker: only workspaces where this user may approve (editor+,
  // re-checked on POST). Default preselects the user's current workspace.
  const accessible = await getAccessibleWorkspaces(user.id);
  const eligible = [];
  for (const w of accessible) {
    const m = await getMembership(user.id, w.id);
    if (m && roleAtLeast(m.role, MCP_CONSENT_MIN_ROLE)) eligible.push({ id: w.id, name: w.name });
  }
  const fallback = await getOrCreateWorkspace(user.id, user.email);
  const defaultWorkspaceId = eligible.some((w) => w.id === fallback.id)
    ? fallback.id
    : (eligible[0]?.id ?? "");

  return (
    <div className="min-h-dvh bg-canvas px-4 py-10">
      <div className="mx-auto max-w-lg rounded-lg bg-paper p-6 shadow-hairline">
        <h1 className="aos-heading">Connect an app to ShapesOS</h1>
        <p className="mt-2 text-sm text-ink">
          <span className="font-semibold">{clientName}</span> wants access with these exact
          permissions. Approving sends you back to{" "}
          <code className="rounded bg-canvas px-1 font-mono text-[0.8125rem]">{host}</code>.
        </p>
        <div className="mt-4 rounded-md border border-line bg-canvas px-3 py-2 text-[0.8125rem] text-ink">
          <p>
            ShapesOS hasn&apos;t verified this app. Its name comes from the app itself. Only approve
            if you started this connection and you trust{" "}
            <code className="font-mono">{host}</code>.
          </p>
          <p className="mt-1 text-muted">
            Client ID <code className="font-mono">{pending.clientId}</code>
          </p>
        </div>
        <ul className="mt-4 divide-y divide-line rounded-md border border-line">
          {scopes.map(({ scope, label }) => (
            <li key={scope} className="p-4">
              <div className="text-sm font-semibold text-ink">{label!.title}</div>
              <div className="mt-0.5 text-[0.8125rem] text-muted">{label!.description}</div>
              <code className="mt-1 inline-block rounded bg-canvas px-1.5 py-0.5 font-mono text-xs text-muted">
                {scope}
              </code>
            </li>
          ))}
        </ul>
        {eligible.length === 0 ? (
          <p className="mt-6 text-sm text-ink">
            You need the editor role or higher in a workspace to connect apps. Ask a workspace admin
            to change your role, then start the connection again.
          </p>
        ) : (
          <ConsentForm grant={grant!} workspaces={eligible} defaultWorkspaceId={defaultWorkspaceId} />
        )}
        <p className="mt-4 text-[0.8125rem] text-muted">
          The token is bound to the workspace you choose, limited to what your role there allows,
          and expires after 1 hour. Revoke access any time in Settings → API / MCP.
        </p>
      </div>
    </div>
  );
}
