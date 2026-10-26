// ShapesOS — preview HTML bootstrap rewriting for the dev-preview proxy.
// Kept in its own module (no prisma/db imports) so it is unit-testable in
// environments where the Prisma client is not generated.

/**
 * The opaque-origin bootstrap, injected before the app's first script.
 * prefix is the preview path ("/api/projects/<id>/dev-preview/<port>/").
 */
export function rewritePreviewHtml(html: string, prefix: string): string {
  const boot = `<script>(function(){var B=${JSON.stringify(prefix)};` +
    `var of=window.fetch;if(of){window.fetch=function(u,o){o=o||{};` +
    `if(typeof u==="string"){if(u.charAt(0)==="/"){if(u.indexOf("/api/projects/")!==0)u=B+u.slice(1);}` +
    `else if(!/^[a-z][a-z0-9+.-]*:/i.test(u))u=B+u;` +
    `if(u.indexOf(B)===0)o.credentials="include";}` +
    `return of.call(this,u,o);};}` +
    `var oo=XMLHttpRequest.prototype.open;if(oo){XMLHttpRequest.prototype.open=function(m,u){` +
    `if(typeof u==="string"){if(u.charAt(0)==="/"){if(u.indexOf("/api/projects/")!==0)u=B+u.slice(1);}` +
    `else if(!/^[a-z][a-z0-9+.-]*:/i.test(u))u=B+u;}` +
    `var r=oo.apply(this,arguments);try{this.withCredentials=true;}catch(e){}return r;};}})();</script>`;
  let out = html.replace(/<script(?![^>]*\bcrossorigin\b)([^>]*type="module"[^>]*)>/g, '<script crossorigin="use-credentials"$1>');
  const head = out.indexOf("<head>");
  if (head >= 0) out = out.slice(0, head + 6) + boot + out.slice(head + 6);
  else {
    const script = out.indexOf("<script");
    out = script >= 0 ? out.slice(0, script) + boot + out.slice(script) : boot + out;
  }
  return out;
}
