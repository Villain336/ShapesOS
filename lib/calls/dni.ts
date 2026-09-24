// Marketr — call tracking (R5): dynamic number insertion (DNI).
//
// Resolution rule (deterministic, documented):
//   1. an ACTIVE tracking number whose `campaign` matches the requested
//      source (case-insensitive exact match) wins;
//   2. otherwise the workspace's first active number (the default pool);
//   3. if the workspace has no active numbers, null — the site keeps its
//      hard-coded number.
//
// The public DNI endpoint + snippet run in a visitor's browser, so they are
// PUBLIC BY DESIGN and rate-limited. They only expose phone numbers the
// business already publishes on its site.

import { prisma } from "@/lib/prisma";

export async function resolveDniNumber(
  workspaceId: string,
  source?: string | null,
): Promise<{ e164: string; campaign: string | null } | null> {
  const numbers = await prisma.callNumber.findMany({
    where: { workspaceId, status: "active" },
    orderBy: { createdAt: "asc" },
    select: { e164: true, campaign: true },
    take: 50,
  });
  if (numbers.length === 0) return null;
  const s = (source ?? "").trim().toLowerCase();
  if (s) {
    const hit = numbers.find((n) => (n.campaign ?? "").trim().toLowerCase() === s);
    if (hit) return { e164: hit.e164, campaign: hit.campaign };
  }
  return { e164: numbers[0].e164, campaign: numbers[0].campaign };
}

/**
 * The embeddable snippet. Usage:
 *   <script src="https://app.example.com/api/calls/dni/snippet?workspace=WS_ID"></script>
 * It reads the source from ?utm_source= (falling back to ?source=), fetches
 * the resolved tracking number, and rewrites:
 *   - every <a href="tel:…"> link,
 *   - every element with [data-mk-number] (text content).
 */
export function dniSnippetJs(workspaceId: string, apiBase: string): string {
  const safe = workspaceId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return `(function(){
var WS=${JSON.stringify(safe)};
var API=${JSON.stringify(apiBase)};
function source(){
  var q=new URLSearchParams(window.location.search);
  return q.get("utm_source")||q.get("source")||"";
}
function apply(num){
  if(!num) return;
  document.querySelectorAll('a[href^="tel:"]').forEach(function(a){
    a.setAttribute("href","tel:"+num.replace(/[^+\\d]/g,""));
  });
  document.querySelectorAll("[data-mk-number]").forEach(function(el){
    el.textContent=num;
  });
}
fetch(API+"/api/calls/dni?workspace="+encodeURIComponent(WS)+"&source="+encodeURIComponent(source()))
  .then(function(r){return r.json();})
  .then(function(d){ if(d&&d.number) apply(d.number); })
  .catch(function(){});
})();`;
}
