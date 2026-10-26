// ShapesOS — authenticated proxy to a project's persistent dev sandbox
// (in-product browser "Dev preview" v1, server-only). Mirrors the run-scoped
// preview-proxy security posture, tightened for a shared project sandbox:
//
//  - Two auth paths, both enforced by the ROUTE before this runs: the
//    browser panel's same-origin session, or a read-only capability URL
//    (/cap/<token>/, lib/sandbox/dev-preview-token.ts). No cookies or
//    ambient credentials are minted or required here.
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
import { rewritePreviewCss, rewritePreviewJs, rewritePreviewHtml } from "./dev-preview-html";
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

// Segment-safe encoding shared by the proxy and the route's canonical
// redirect: encodeURIComponent is too aggressive for path segments - it
// escapes legal pchar characters like "@" to "%40", and real dev servers
// treat those as DIFFERENT paths (observed against Vite v8:
// "<base>/%40vite/client" returns the SPA fallback HTML instead of the HMR
// client JS, breaking every vite-internal @path). Keep RFC 3986 sub-delims,
// ":" and "@" raw; still escape "?", "#", "%", spaces, etc.
export const encodeDevPreviewPathSegment = (s: string): string =>
  encodeURIComponent(s).replace(/%(21|24|26|27|28|29|2A|2B|2C|3A|3B|3D|40)/gi, (m) => decodeURIComponent(m));

export async function proxyDevPreview(
  req: Request,
  params: { projectId: string; port: string; path?: string[] },
  ctx: { workspaceId: string; canWrite: boolean; linkPrefix?: string },
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
  // Links/emitted URLs point at the token-full prefix when the request came
  // in on a capability URL; the upstream always speaks the tokenless base.
  const linkPrefix = ctx.linkPrefix ?? prefix;
  // Segment-safe encoding: encodeURIComponent is too aggressive for path
  // segments - it escapes legal pchar characters like "@" to "%40", and real
  // dev servers treat those as DIFFERENT paths (observed against Vite v8:
  // "<base>/%40vite/client" returns the SPA fallback HTML instead of the HMR
  // client JS, breaking every vite-internal @path). Keep RFC 3986 sub-delims,
  // ":" and "@" raw; still escape "?", "#", "%", spaces, etc.
  const seg = encodeDevPreviewPathSegment;
  // Sensitive-path guard (defense in depth; the dev server remains the real
  // boundary). The previewed app necessarily possesses its own bearer, so
  // any content it serves can exfiltrate whatever the dev server will serve:
  // framework dev servers happily return project files like .env, and Vite's
  // /@fs/<absolute> reads any path inside its fs.allow root. Refuse the
  // obvious sensitive shapes at the proxy; documented in the PR body.
  // Path segments arrive DECODED (Next decodes %2e/%2f before params), so a
  // literal ".." or a segment with an embedded slash/backslash would reach
  // the dev server as a traversal after our own re-encoding - refuse them
  // deterministically instead of relying on upstream normalization.
  // Dotfile guards cover the common credential files; NOT exhaustive
  // (residual: *.pem, id_rsa outside .ssh, etc. - named in the PR body).
  // @fs stays fail-closed for v1: monorepo/npm-linked deps living OUTSIDE
  // the project root are UNSUPPORTED (documented, not silently relaxed).
  if ((params.path ?? []).some((s) =>
    /^\.{2,}$/.test(s) || s.includes("/") || s.includes("\\") ||
    s === ".env" || s.startsWith(".env.") || s === ".git" || s === "@fs" ||
    s === ".npmrc" || s === ".aws" || s === ".ssh" || s === ".gnupg" || s === ".docker")) {
    return text(404, "Not found.");
  }
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
  // Redirects: in-base Locations are rewritten to the LINK prefix (token
  // preserved); external origins are DENIED (header dropped), never passed
  // through - an upstream redirect must not bounce the pane off-origin with
  // its capability URL.
  const loc = res.headers.get("location");
  if (loc) {
    try {
      const l = new URL(loc, target);
      if (l.origin === upstream.origin) {
        const p = l.pathname.startsWith(prefix) ? `${linkPrefix}${l.pathname.slice(prefix.length)}` : `${linkPrefix}${l.pathname.replace(/^\//, "")}`;
        headers.set("location", `${p}${l.search}${l.hash}`);
      } else headers.delete("location");
    } catch {
      headers.delete("location");
    }
  }
  // Credentialless CORS for the sandboxed (opaque-origin) preview document:
  // module scripts and fetch/XHR run in CORS mode and need an explicit ACAO;
  // "null" is the origin these documents carry. NO Access-Control-Allow-
  // Credentials: auth is the URL token, never a cookie, so no ambient
  // authority rides any request (v1's ACAC + SameSite=None cookie was the
  // null-origin read primitive the security review removed).
  headers.set("access-control-allow-origin", "null");
  // The capability token lives in the URL: never leak it via Referer to
  // third-party origins the previewed app talks to.
  headers.set("referrer-policy", "no-referrer");

  // Link rewriting (compatibility, NOT a boundary): the dev server emits
  // the STATIC tokenless base (baked --base); served HTML, JS and CSS get the
  // request's token-full prefix instead, plus a bootstrap that rewrites
  // runtime fetch/XHR URLs the same way. Buffered and capped; larger bodies
  // stream through with the tokenless base (assets then 404 - logged, not
  // hidden). No credentials are forced anywhere: auth is the URL token.
  const ctype = headers.get("content-type") ?? "";
  if (method === "GET" && res.status === 200 && ctype.includes("text/html")) {
    const html = await bufferWithCap(res.body, MAX_REWRITE_BYTES);
    if (html !== null) {
      headers.delete("content-length");
      return new Response(rewritePreviewHtml(html, prefix, linkPrefix), { status: res.status, statusText: res.statusText, headers });
    }
    console.warn(`[dev-preview] HTML over ${MAX_REWRITE_BYTES} bytes: served without link rewriting`);
  }
  if (method === "GET" && res.status === 200 && /javascript|ecmascript/.test(ctype)) {
    const js = await bufferWithCap(res.body, MAX_REWRITE_BYTES);
    if (js !== null) {
      headers.delete("content-length");
      return new Response(rewritePreviewJs(js, prefix, linkPrefix), { status: res.status, statusText: res.statusText, headers });
    }
    console.warn(`[dev-preview] JS over ${MAX_REWRITE_BYTES} bytes: served without link rewriting`);
  }
  if (method === "GET" && res.status === 200 && ctype.includes("text/css")) {
    const css = await bufferWithCap(res.body, MAX_REWRITE_BYTES);
    if (css !== null) {
      headers.delete("content-length");
      return new Response(rewritePreviewCss(css, prefix, linkPrefix), { status: res.status, statusText: res.statusText, headers });
    }
    console.warn(`[dev-preview] CSS over ${MAX_REWRITE_BYTES} bytes: served without link rewriting`);
  }
  return new Response(method === "HEAD" ? null : res.body, { status: res.status, statusText: res.statusText, headers });
}

const MAX_REWRITE_BYTES = 4 * 1024 * 1024;

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
