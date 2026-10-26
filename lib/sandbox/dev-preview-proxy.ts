// ShapesOS — authenticated proxy to a project's persistent dev sandbox
// (in-product browser "Dev preview" v1, server-only). Mirrors the run-scoped
// preview-proxy security posture, tightened for a shared project sandbox:
//
//  - Session-only: no signed-token path. The browser panel is same-origin,
//    so app cookies ride the iframe; there is no cross-site surface.
//  - viewer+ to look; POST/PUT/PATCH/DELETE need editor+ (a dev sandbox is
//    shared project state - there is no single "starter").
//  - Only ports recorded on the ProjectDevSandbox row, only the sandbox's
//    own allow-listed upstream, app cookies never forwarded, CSP sandbox on
//    the response (all from ./preview helpers).
//  - NEVER wakes a paused sandbox: wake happens only through the explicit
//    resume route. A paused sandbox answers 409 so the UI can show its
//    Resume button.

import { assertSafeUrl } from "@/lib/safe-url";
import { getDevSandboxRow } from "./dev-sandbox";
import {
  forwardRequestHeaders,
  isPreviewCapable,
  isValidPreviewPort,
  previewResponseHeaders,
  upstreamAllowed,
} from "./preview";
import { getSandboxProvider } from "./index";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export function devPreviewPath(projectId: string, port: number): string {
  return `/api/projects/${projectId}/dev-preview/${port}/`;
}

export async function proxyDevPreview(
  req: Request,
  params: { projectId: string; port: string; path?: string[] },
  ctx: { workspaceId: string; canWrite: boolean },
): Promise<Response> {
  const port = Number(params.port);
  if (!isValidPreviewPort(port)) return text(404, "Not found");
  const method = req.method.toUpperCase();
  if (!READ_METHODS.has(method) && !ctx.canWrite) {
    return text(403, "Only editors can send changes to this preview.");
  }

  const row = await getDevSandboxRow(ctx.workspaceId, params.projectId);
  if (!row || row.status === "destroyed") return text(404, "This project has no dev preview yet.");
  if (row.status !== "running") {
    return text(409, "This preview is paused. Resume it from the browser panel.");
  }
  if (!row.exposedPorts.includes(port)) return text(404, `Port ${port} isn't exposed for this preview.`);

  const provider = getSandboxProvider();
  const live = provider ? await provider.get(row.sandboxId) : null;
  if (!live || !isPreviewCapable(live)) return text(409, "This preview's sandbox is not running.");
  const upstream = await live.previewUpstream(port);

  const incoming = new URL(req.url);
  const prefix = devPreviewPath(params.projectId, port);
  const rest = (params.path ?? []).map(encodeURIComponent).join("/");
  const candidates = [`${prefix}${rest}`, `/${rest}`];
  const body = READ_METHODS.has(method) ? undefined : await req.arrayBuffer();
  if (body && body.byteLength > MAX_BODY_BYTES) return text(413, "Request body too large for a preview.");

  let res: Response | null = null;
  let target: URL | null = null;
  for (const [i, path] of candidates.entries()) {
    if (i > 0 && !READ_METHODS.has(method)) break;
    target = new URL(`${path}${incoming.search}`, upstream.origin);
    if (!upstreamAllowed(target, upstream)) return text(502, "Preview upstream refused.");
    if (upstream.kind === "public") {
      try {
        await assertSafeUrl(target.toString());
      } catch {
        return text(502, "Preview upstream refused.");
      }
    }
    try {
      res = await fetch(target.toString(), {
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
  return new Response(method === "HEAD" ? null : res.body, { status: res.status, statusText: res.statusText, headers });
}
