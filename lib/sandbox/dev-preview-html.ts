// ShapesOS — preview HTML/CSS link rewriting for the dev-preview proxy.
// Kept in its own module (no prisma/db imports) so it is unit-testable in
// environments where the Prisma client is not generated.
//
// v2 (capability URLs): auth rides the URL (/cap/<token>/), not a cookie, so
// NO crossorigin attributes, NO credentials forcing, NO ambient authority.
// This module does two compatibility-only jobs (neither is a security
// boundary; the token + route checks are):
//  1. Replace the dev server's STATIC tokenless base (baked in via --base at
//     share time) with the request's token-full prefix in served HTML and
//     CSS, so emitted asset/links resolve under the authenticated prefix.
//  2. Inject a small bootstrap before the app's first script that rewrites
//     fetch/XHR URLs the same way for RUNTIME-constructed relative or
//     root-absolute paths. Documented limitation: absolute URLs a framework
//     constructs inside JS chunks WITHOUT going through fetch/XHR (e.g.
//     new EventSource("/x"), img.src = "/x", WebSocket) are not rewritten;
//     root-absolute app-API paths ("/api/projects/...") are deliberately NOT
//     rewritten - they belong to ShapesOS, not the dev server.

/**
 * Rewrite the tokenless base to the token-full link prefix in served HTML
 * and inject the URL-rewriting bootstrap first in <head>.
 * basePrefix:  /api/projects/<id>/dev-preview/<port>/   (static, baked --base)
 * linkPrefix:  basePrefix + "cap/<token>/"              (this request's auth)
 */
export function rewritePreviewHtml(html: string, basePrefix: string, linkPrefix: string): string {
  const boot = `<script>(function(){var B=${JSON.stringify(linkPrefix)};` +
    `var rw=function(u){if(typeof u!=="string")return u;` +
    `if(u.charAt(0)==="/"){if(u.indexOf("/api/projects/")!==0)return B+u.slice(1);return u;}` +
    `if(!/^[a-z][a-z0-9+.-]*:/i.test(u))return B+u;return u;};` +
    `var of=window.fetch;if(of){window.fetch=function(u,o){return of.call(this,typeof u==="string"?rw(u):u,o);};}` +
    `var oo=XMLHttpRequest.prototype.open;if(oo){XMLHttpRequest.prototype.open=function(m,u){` +
    `arguments[1]=typeof u==="string"?rw(u):u;return oo.apply(this,arguments);};}})();</script>`;
  let out = html.split(basePrefix).join(linkPrefix);
  const head = out.indexOf("<head>");
  if (head >= 0) out = out.slice(0, head + 6) + boot + out.slice(head + 6);
  else {
    const script = out.indexOf("<script");
    out = script >= 0 ? out.slice(0, script) + boot + out.slice(script) : boot + out;
  }
  return out;
}

/** Same base->link replacement for stylesheets (root-absolute url()s). */
export function rewritePreviewCss(css: string, basePrefix: string, linkPrefix: string): string {
  return css.split(basePrefix).join(linkPrefix);
}

/** Same base->link replacement for JavaScript modules. Dev servers bake the
 *  STATIC tokenless base into transformed module source (static imports,
 *  vite-internal paths like @vite/client's imports, dynamic import()
 *  specifiers). Module-graph fetches are performed by the JS engine - the
 *  bootstrap cannot intercept them - so without this rewrite the graph
 *  arrives tokenless, fails closed (401), and the pane renders nothing
 *  (observed with real Chromium + real Vite v8: src/dep.js and
 *  node_modules/vite/dist/client/env.mjs both arrived tokenless). */
export function rewritePreviewJs(js: string, basePrefix: string, linkPrefix: string): string {
  return js.split(basePrefix).join(linkPrefix);
}
