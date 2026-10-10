// Phase 21A (WS=agentweb): actions on a result map to existing tools (so they run
// through executeTool and its gates) or to a link that fills in a draft for a person.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAction, ACTION_IDS } from "../actions";
import type { AnswerPayload } from "../types";

const payload: AnswerPayload = {
  question: "When is Riverside Dental open?",
  plan: { kind: "lookup", use: ["web"], queries: ["q"], recent: false, by: "rules" },
  claims: [
    { text: "Riverside Dental is open Monday to Friday 9:00 to 17:00.", cites: [1], evidence: [], status: "supported", supportedBy: [1] },
    { text: "Parking is free.", cites: [1], evidence: [], status: "unsupported", reason: "The cited source does not mention this." },
  ],
  sources: [
    { id: 1, url: "https://riverside.example.test/hours", title: "Opening hours - Riverside Dental", text: "Open Mon-Fri.", providers: ["brave"], trust: 0.55, freshness: 1, score: 0.8, captureId: "cap_abc" },
    { id: 2, url: "/dashboard/notes?note=n1", title: "Our note", text: "x", providers: ["workspace"], trust: 1, freshness: 1, score: 0.7 },
  ],
  followUps: [],
  notes: [],
  partial: false,
  writtenBy: "model",
};

describe("buildAction", () => {
  it("lists exactly the actions the plan names", () => {
    assert.deepEqual([...ACTION_IDS], ["save_note", "save_drive", "add_crm", "monitor_page", "draft_email"]);
  });

  it("save_note writes a note with the claims, their status and the receipts", () => {
    const a = buildAction("save_note", payload, undefined)!;
    assert.equal(a.kind, "tool");
    assert.equal((a as { tool: string }).tool, "create_note");
    const args = (a as { args: Record<string, string> }).args;
    assert.equal(args.title, "Answer: When is Riverside Dental open?");
    assert.match(args.body, /Riverside Dental is open Monday to Friday 9:00 to 17:00\. \[1\]/);
    assert.match(args.body, /Parking is free\. \[1\] \(unsupported: The cited source does not mention this\.\)/);
    assert.match(args.body, /\[1\] Opening hours - Riverside Dental — https:\/\/riverside\.example\.test\/hours \(receipt cap_abc\)/);
  });

  it("save_drive writes a document", () => {
    const a = buildAction("save_drive", payload, undefined) as { tool: string; args: Record<string, string> };
    assert.equal(a.tool, "create_document");
    assert.match(a.args.markdown, /^# Answer: When is Riverside Dental open\?/);
  });

  it("add_crm makes a company from a web source's name and domain", () => {
    const a = buildAction("add_crm", payload, 1) as { tool: string; args: Record<string, string> };
    assert.deepEqual([a.tool, a.args.name, a.args.domain], ["ops_create_company", "Opening hours - Riverside Dental", "riverside.example.test"]);
  });

  it("monitor_page watches a web source daily", () => {
    const a = buildAction("monitor_page", payload, 1) as { tool: string; args: Record<string, string> };
    assert.deepEqual([a.tool, a.args.url, a.args.cadence], ["web_monitor_page", "https://riverside.example.test/hours", "daily"]);
  });

  it("page actions need a web source: a workspace record or a missing id gives nothing", () => {
    assert.equal(buildAction("add_crm", payload, 2), null);
    assert.equal(buildAction("monitor_page", payload, 99), null);
    assert.equal(buildAction("monitor_page", payload, undefined), null);
  });

  it("draft_email opens Mail with a draft filled in for the person to review; nothing is sent", () => {
    const a = buildAction("draft_email", payload, 1) as { kind: string; href: string };
    assert.equal(a.kind, "link");
    const u = new URL(a.href, "https://x.test");
    assert.equal(u.pathname, "/dashboard/mail");
    assert.equal(u.searchParams.get("compose"), "1");
    assert.equal(u.searchParams.get("subject"), "Re: When is Riverside Dental open?");
    assert.match(u.searchParams.get("body")!, /Riverside Dental is open Monday to Friday/);
    assert.equal(u.searchParams.has("to"), false);
  });

  it("an unknown action is nothing", () => {
    assert.equal(buildAction("buy_it" as never, payload, 1), null);
  });
});
