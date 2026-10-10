// ShapesOS — Phase 21A round 2 (WS=agentweb): attach a web page to a research session by address.
//
// The page is read the way the answer engine reads one: honest user agent, Web Bot Auth when the
// deployment has an identity, robots.txt and the site's AI-usage preference honoured, the SSRF
// guard on every hop. A site that says no comes back as a typed outcome for the screen to explain
// (blocked_by_site, payment_required, disallowed): never a workaround. A page that was read is
// stored as a signed capture (a receipt) and attached; if the member turned browsing memory on, it
// is remembered, since they asked for it.

import { authorityAudit } from "@/lib/authority/db";
import { readPage, type PageFetchDeps, type PageOutcome } from "../page-fetch";
import { recordReceipt, receiptSecret } from "../receipts";
import { storeCapture } from "../captures-store";
import { storeDelegation } from "../identity/delegation-store";
import { rememberPage } from "../memory/store";
import { attachCapture, getResearch, ResearchError } from "./store";

export type AddPageResult = { ok: true; captureId: string; remembered: boolean } | { ok: false; outcome: PageOutcome };

export async function addPageToResearch(workspaceId: string, userId: string, researchId: string, rawUrl: string, deps: PageFetchDeps = {}): Promise<AddPageResult> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
  } catch {
    throw new ResearchError("bad_request", "Give a full web address starting with http:// or https://.");
  }
  // Ownership first: nothing is fetched for a session that is not the member's.
  const own = await getResearch(workspaceId, userId, researchId);
  if (!own || !own.owner) throw new ResearchError("not_found", "That research was not found.");
  const read = await readPage(url.toString(), deps);
  if (!read.ok) return { ok: false, outcome: read.outcome };
  const now = new Date();
  const cap = await recordReceipt(
    {
      secret: receiptSecret(),
      store: (c) => storeCapture(workspaceId, c, { via: "fetch", provider: "crawler", bodyText: read.text }),
      delegate: (d) => storeDelegation(workspaceId, d),
      audit: (e) => authorityAudit.logAsync(e),
    },
    {
      workspaceId,
      actor: `user:${userId}`,
      url: url.toString(),
      html: read.text,
      text: read.text,
      fetchedAt: now,
      step: { action: "read", klass: "benign", tier: 0, decision: "allow" },
      delegation: { delegatedBy: userId, runId: null, agent: "research", scope: { origins: [url.origin], classes: ["benign"] }, expiresAt: new Date(now.getTime() + 5 * 60_000) },
    },
  );
  await attachCapture(workspaceId, userId, researchId, cap.id);
  const d = await rememberPage(workspaceId, userId, { url: url.toString(), title: url.hostname, text: read.text, askedByPerson: true, captureId: cap.id, researchId });
  return { ok: true, captureId: cap.id, remembered: d.store };
}
