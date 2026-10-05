// ShapesOS — Phase 8: the authenticated preview proxy (server-only).
//
// /api/agent-runs/<runId>/preview/<port>/<path…> → the run's sandbox dev
// server. Never public:
//   - who: a signed-in member of the run's workspace (viewer+ to look,
//     editor+ or the run's starter for anything but GET/HEAD); or the
//     short-lived preview cookie the first signed-in request set (needed
//     because the page runs as an opaque origin — see preview.ts) — whose
//     user must still be a member;
//   - where: only a port the run exposed (agent_run_sandboxes.exposed_ports),
//     only the upstream its own sandbox names (Docker: exactly the gateway's
//     loopback origin; E2B/Daytona: https, the per-sandbox host pattern AND
//     assertSafeUrl), redirects not followed;
//   - what: the app's cookies / Authorization never forwarded; the response
//     runs under CSP sandbox and can't set cookies on the app's origin.

import { requireWorkspaceRole } from "@/lib/authz";
import { assertSafeUrl } from "@/lib/safe-url";
import { getAgentRun } from "@/lib/agents/runs/service";
import { liveSandboxForRun } from "./index";
import {
  forwardRequestHeaders,
  isPreviewCapable,
  isValidPreviewPort,
  PREVIEW_COOKIE,
  PREVIEW_TOKEN_TTL_SECONDS,
  previewPath,
  previewResponseHeaders,
  previewSecret,
  readCookie,
  signPreviewToken,
  upstreamAllowed,
  verifyPreviewToken,
} from "./preview";

const READ_METHODS = new Set(["GET", "HEAD"]);
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export interface PreviewSession {
  /** The signed-in user (null when only the preview cookie is presented). */
  user: { id: string; email?: string | null } | null;
  /** Resolves the caller's current workspace (session path only). */
  workspaceFor: (user: { id: string; email?: string | null }) => Promise<{ id: string }>;
  /** The role check (lib/authz requireWorkspaceRole), passed in by the route. */
  requireRole?: typeof requireWorkspaceRole;
}

export async function proxyPreview(
  req: Request,
  params: { runId: string; port: string; path?: string[] },
  session: PreviewSession,
  deps: { fetch?: typeof fetch; resolve?: (host: string) => Promise<string[]> } = {},
): Promise<Response> {
  const port = Number(params.port);
  if (!isValidPreviewPort(port)) return text(404, "Not found");
  const method = req.method.toUpperCase();
  const secret = previewSecret();

  // 1. Who is asking, and may they see this run?
  let workspaceId: string;
  let userId: string;
  let viaSession = false;
  if (session.user) {
    workspaceId = (await session.workspaceFor(session.user)).id;
    userId = session.user.id;
    viaSession = true;
  } else {
    const claims = secret ? verifyPreviewToken(readCookie(req.headers.get("cookie"), PREVIEW_COOKIE), params.runId, secret) : null;
    if (!claims) return text(401, "Sign in to view this preview.");
    workspaceId = claims.workspaceId;
    userId = claims.userId;
  }
  const requireRole = session.requireRole ?? requireWorkspaceRole;
  const membership = await requireRole(userId, workspaceId, "viewer");
  if (!membership) return text(viaSession ? 403 : 401, "You can't view this preview.");
  const run = await getAgentRun(workspaceId, params.runId);
  if (!run) return text(404, "Run not found");
  if (!READ_METHODS.has(method) && run.startedBy !== userId && !(await requireRole(userId, workspaceId, "editor"))) {
    return text(403, "Only editors or the person who started this run can send changes to its preview.");
  }

  // 2. Which upstream? Only a port this run exposed, on its own sandbox.
  const live = await liveSandboxForRun({ workspaceId, runId: run.id });
  if (!live) return text(409, "This run's sandbox has ended, so its preview is gone.");
  if (!live.row.exposedPorts.includes(port)) return text(404, `Port ${port} isn't exposed for this run.`);
  if (!isPreviewCapable(live.sandbox)) return text(501, "This sandbox can't serve previews.");
  const upstream = await live.sandbox.previewUpstream(port);

  const incoming = new URL(req.url);
  const prefix = previewPath(run.id, port);
  const rest = (params.path ?? []).map(encodeURIComponent).join("/");
  const candidates = [`${prefix}${rest}`, `/${rest}`];
  const body = READ_METHODS.has(method) ? undefined : await req.arrayBuffer();
  if (body && body.byteLength > MAX_BODY_BYTES) return text(413, "Request body too large for a preview.");
  const doFetch = deps.fetch ?? fetch;

  let res: Response | null = null;
  let target: URL | null = null;
  // Dev servers started with the preview base path expect the full path; a
  // plain static server expects it stripped — try the full one first (GET/HEAD).
  for (const [i, path] of candidates.entries()) {
    if (i > 0 && !READ_METHODS.has(method)) break;
    target = new URL(`${path}${incoming.search}`, upstream.origin);
    if (!upstreamAllowed(target, upstream)) return text(502, "Preview upstream refused.");
    if (upstream.kind === "public") {
      try {
        await assertSafeUrl(target.toString(), deps.resolve ? { resolve: deps.resolve } : undefined);
      } catch {
        return text(502, "Preview upstream refused.");
      }
    }
    try {
      res = await doFetch(target.toString(), {
        method,
        headers: { ...forwardRequestHeaders(req.headers), ...upstream.headers },
        body: body ? new Uint8Array(body) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      return text(502, `Nothing answered on port ${port} in the sandbox. Is the dev server running?`);
    }
    if (res.status !== 404 || i === candidates.length - 1) break;
    await res.body?.cancel().catch(() => undefined);
  }
  if (!res || !target) return text(502, "Preview upstream refused.");

  const headers = previewResponseHeaders(res.headers);
  // Keep redirects inside the preview.
  const loc = res.headers.get("location");
  if (loc) {
    try {
      const l = new URL(loc, target);
      if (l.origin === upstream.origin) {
        const p = l.pathname.startsWith(prefix) ? l.pathname : `${prefix}${l.pathname.replace(/^\//, "")}`;
        headers.set("location", `${p}${l.search}${l.hash}`);
      } else headers.delete("location");
    } catch {
      headers.delete("location");
    }
  }
  if (viaSession && secret) {
    const token = signPreviewToken(
      { runId: run.id, userId, workspaceId, exp: Math.floor(Date.now() / 1000) + PREVIEW_TOKEN_TTL_SECONDS },
      secret,
    );
    headers.append(
      "set-cookie",
      `${PREVIEW_COOKIE}=${encodeURIComponent(token)}; Path=${previewPath(run.id, port).replace(/\/\d+\/$/, "/")}; Max-Age=${PREVIEW_TOKEN_TTL_SECONDS}; HttpOnly; Secure; SameSite=None`,
    );
  }
  return new Response(method === "HEAD" ? null : res.body, { status: res.status, statusText: res.statusText, headers });
}
