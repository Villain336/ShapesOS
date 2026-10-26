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
import { rewritePreviewHtml } from "./dev-preview-html";
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
  // Segment-safe encoding: encodeURIComponent is too aggressive for path
  // segments - it escapes legal pchar characters like "@" to "%40", and real
  // dev servers treat those as DIFFERENT paths (observed against Vite v8:
  // "<base>/%40vite/client" returns the SPA fallback HTML instead of the HMR
  // client JS, breaking every vite-internal @path). Keep RFC 3986 sub-delims,
  // ":" and "@" raw; still escape "?", "#", "%", spaces, etc.
  const seg = (s: string) =>
    encodeURIComponent(s).replace(/%(21|24|26|27|28|29|2A|2B|2C|3A|3B|3D|40)/gi, (m) => decodeURIComponent(m));
  const rest = (params.path ?? []).map(seg).join("/");
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
  // CORS for the sandboxed (opaque-origin) preview document: its module
  // scripts, fetch and XHR run in CORS mode with credentials (the path-scoped
  // capability cookie), which requires an explicit ACAO. "null" is the opaque
  // origin these documents carry - it opens nothing to named origins beyond
  // what the capability cookie already intends (observed in the real-browser
  // harness: without this, vite's module graph 401s/blocks).
  headers.set("access-control-allow-origin", "null");
  headers.set("access-control-allow-credentials", "true");

  // HTML bootstrap: make the previewed app actually run from an opaque
  // origin. (1) module scripts need crossorigin="use-credentials" or they
  // never send the capability cookie (observed). (2) app fetch/XHR default
  // to credentials "same-origin" - never sent from an opaque origin - and to
  // root-absolute paths that would hit ShapesOS instead of the dev server;
  // the bootstrap routes same-origin absolute paths back through the preview
  // prefix and forces credentials. Buffered and capped; larger HTML streams
  // through unchanged (module scripts then 401 - logged, not hidden).
  const ctype = headers.get("content-type") ?? "";
  if (method === "GET" && res.status === 200 && ctype.includes("text/html")) {
    const html = await bufferWithCap(res.body, MAX_HTML_REWRITE_BYTES);
    if (html !== null) {
      headers.delete("content-length");
      return new Response(rewritePreviewHtml(html, prefix), { status: res.status, statusText: res.statusText, headers });
    }
    console.warn(`[dev-preview] HTML over ${MAX_HTML_REWRITE_BYTES} bytes: served without the module/credentials bootstrap`);
  }
  return new Response(method === "HEAD" ? null : res.body, { status: res.status, statusText: res.statusText, headers });
}

const MAX_HTML_REWRITE_BYTES = 4 * 1024 * 1024;

async function bufferWithCap(body: ReadableStream<Uint8Array> | null, cap: number): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

