// Marketr — OAuth consent screen (Phase C, W5).
//
// Browser page showing the EXACT scopes the client requested, rendered from
// the AES-GCM-sealed grant (server-side decrypt). Approve/deny POSTs to
// /api/mcp/oauth/consent. Signed-in users only.

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { secrets } from "@/lib/secrets";
import { SCOPE_LABELS, type McpToolName } from "@/lib/mcp/scopes";
import type { PendingAuthorization } from "@/lib/mcp/oauth";
import { ConsentForm } from "./ConsentForm";

export const dynamic = "force-dynamic";

function toolNameOf(scope: string): McpToolName | null {
  const name = scope.startsWith("tools:") ? scope.slice(6) : "";
  return name in SCOPE_LABELS ? (name as McpToolName) : null;
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
      <div className="mx-auto max-w-lg p-8">
        <h1 className="text-xl font-semibold">Authorization failed</h1>
        <p className="mt-2 text-sm text-zinc-500">The authorization request is invalid or expired. Please restart the connection flow.</p>
      </div>
    );
  }
  const scopes = pending.scopes
    .map((s) => ({ scope: s, label: toolNameOf(s) ? SCOPE_LABELS[toolNameOf(s)!] : null }))
    .filter((s) => s.label);

  return (
    <div className="mx-auto max-w-lg p-8">
      <h1 className="text-xl font-semibold">Connect to Marketr</h1>
      <p className="mt-2 text-sm text-zinc-600">
        <span className="font-medium">{pending.clientId}</span> is requesting access to your Marketr
        workspace with these exact permissions:
      </p>
      <ul className="mt-4 divide-y divide-zinc-200 rounded-lg border border-zinc-200">
        {scopes.map(({ scope, label }) => (
          <li key={scope} className="p-4">
            <div className="text-sm font-medium">{label!.title}</div>
            <div className="mt-0.5 text-sm text-zinc-500">{label!.description}</div>
            <code className="mt-1 inline-block rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">{scope}</code>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-zinc-500">
        The token is bound to your workspace and expires after 1 hour. You can revoke access by
        deleting the OAuth client; API keys can be revoked in Settings → API / MCP.
      </p>
      <ConsentForm grant={grant!} />
    </div>
  );
}
