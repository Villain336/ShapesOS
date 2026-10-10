// Phase 21A round 2 (WS=agentweb): the research session as a document (PURE). One section per
// answer (the question, the claims with their citations, the sources), the person's notes, the
// pages attached directly, and the receipts. When someone other than the owner reads a shared
// session, anything that came from the OWNER'S WORKSPACE records (private notes, files) is left
// out: sharing a session shares the web research, not the owner's private records.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildView, exportBundle, researchMarkdown, sealExport, verifySeal, type ResearchRow, type AnswerInput, type CaptureInput } from "../view";
import type { AnswerPayload } from "@/lib/answer/types";

const payload = (q: string): AnswerPayload => ({
  question: q,
  plan: { kind: "lookup", use: ["web", "workspace"], queries: [q], recent: false, by: "rules" },
  claims: [
    { text: "Boots cost 80 dollars.", cites: [1], evidence: ["80 dollars"], status: "supported", supportedBy: [1] },
    { text: "Our secret margin is 40 percent.", cites: [2], evidence: ["40 percent"], status: "supported", supportedBy: [2] },
    { text: "Boots are waterproof.", cites: [], evidence: [], status: "unsupported", reason: "No source backs this." },
  ],
  sources: [
    { id: 1, url: "https://shop.test/boots", title: "Boots", text: "Boots cost 80 dollars.", providers: ["brave"], trust: 1, freshness: 1, score: 1, captureId: "cap_1" },
    { id: 2, url: "/dashboard/notes?note=n1", title: "Private margin note", text: "Our secret margin is 40 percent.", providers: ["workspace"], trust: 1, freshness: 1, score: 1, captureId: "cap_2" },
  ],
  followUps: ["How much is shipping?"],
  notes: [],
  partial: false,
  writtenBy: "model",
});
const row: ResearchRow = { id: "r1", title: "Boots research", question: "What do boots cost?", status: "open", shareState: "workspace", notes: "Check the size chart.", runId: null, userId: "owner", createdAt: new Date("2026-11-01T10:00:00Z"), updatedAt: new Date("2026-11-01T11:00:00Z") };
const answers: AnswerInput[] = [{ id: "a1", question: "What do boots cost?", status: "done", createdAt: new Date("2026-11-01T10:05:00Z"), payload: payload("What do boots cost?") }];
const captures: CaptureInput[] = [
  { id: "cap_1", url: "https://shop.test/boots", fetchedAt: new Date("2026-11-01T10:04:00Z"), domHash: "d1", textHash: "t1", excerpt: "Boots cost 80 dollars.", alg: "hmac-sha256", signature: "sig1", provider: "brave" },
  { id: "cap_2", url: "/dashboard/notes?note=n1", fetchedAt: new Date("2026-11-01T10:04:00Z"), domHash: "d2", textHash: "t2", excerpt: "Our secret margin is 40 percent.", alg: "hmac-sha256", signature: "sig2", provider: "workspace" },
  { id: "cap_3", url: "https://news.test/a", fetchedAt: new Date("2026-11-01T10:06:00Z"), domHash: "d3", textHash: "t3", excerpt: "A page I attached.", alg: "none", signature: null, provider: null },
];

describe("buildView", () => {
  it("the owner sees everything on screen", () => {
    const v = buildView(row, answers, captures, { readerId: "owner", includeWorkspace: true });
    assert.equal(v.owner, true);
    assert.equal(v.answers[0].sources.length, 2);
    assert.equal(v.answers[0].sources[1].redacted, false);
    assert.equal(v.pages.length, 1, "only captures no answer cites are listed as attached pages");
  });
  it("another member sees the web research but not the owner's workspace records", () => {
    const v = buildView(row, answers, captures, { readerId: "someone" });
    assert.equal(v.owner, false);
    const s2 = v.answers[0].sources[1];
    assert.equal(s2.redacted, true);
    assert.equal(s2.title, "");
    assert.equal(s2.url, "");
    assert.equal(v.answers[0].claims[1].text, "", "a claim backed only by a workspace record is withheld");
    assert.equal(v.answers[0].claims[1].withheld, true);
    assert.equal(v.answers[0].claims[0].text, "Boots cost 80 dollars.");
  });
  it("the notes are the owner's working notes: shared sessions show them, private ones are not built for others", () => {
    assert.equal(buildView(row, answers, captures, { readerId: "someone" }).notes, "Check the size chart.");
  });
});

describe("researchMarkdown", () => {
  it("has the question, claims with citations, unsupported marks, sources, notes, pages and receipts", () => {
    const md = researchMarkdown(buildView(row, answers, captures, { readerId: "owner", includeWorkspace: true }));
    assert.match(md, /^# Boots research/);
    assert.match(md, /Boots cost 80 dollars\. \[1\]/);
    assert.match(md, /\(unsupported: No source backs this\.\)/);
    assert.match(md, /\[1\] Boots — https:\/\/shop\.test\/boots/);
    assert.match(md, /## Notes\n\nCheck the size chart\./);
    assert.match(md, /A page I attached/);
    assert.match(md, /## Receipts/);
    assert.match(md, /cap_1/);
    assert.match(md, /secret margin/, "the owner chose to include their workspace records");
  });
  it("an export leaves the owner's workspace records out unless the owner asks for them", () => {
    const md = researchMarkdown(buildView(row, answers, captures, { readerId: "owner" }));
    assert.ok(!md.includes("secret margin"));
    assert.ok(!md.includes("cap_2"));
    assert.match(md, /Boots cost 80 dollars\./);
  });
  it("a reader who is not the owner gets no workspace record text anywhere in the export", () => {
    const md = researchMarkdown(buildView(row, answers, captures, { readerId: "someone" }));
    assert.ok(!md.includes("secret margin"));
    assert.ok(!md.includes("Private margin note"));
    assert.ok(!md.includes("cap_2"), "its receipt is not exported either");
  });
});

describe("export seal", () => {
  it("signs the Markdown and the receipt ids; a changed word breaks it", () => {
    const view = buildView(row, answers, captures, { readerId: "owner" });
    const b = exportBundle(view, "secret-key-for-test", new Date("2026-11-02T00:00:00Z"), "owner");
    assert.equal(verifySeal(b, "secret-key-for-test"), true);
    assert.equal(verifySeal({ ...b, markdown: b.markdown.replace("80", "90") }, "secret-key-for-test"), false);
    assert.equal(verifySeal(b, "another-key"), false);
    assert.deepEqual(b.receipts.map((r) => r.id), ["cap_1", "cap_3"], "the web receipts; a workspace record's receipt is not exported by default");
  });
  it("without a secret the export says it is unsealed", () => {
    const b = exportBundle(buildView(row, answers, captures, { readerId: "owner" }), null, new Date(), "owner");
    assert.equal(b.seal, null);
    assert.equal(verifySeal(b, "x"), false);
  });
  it("sealExport is deterministic", () => {
    assert.equal(sealExport("md", ["a", "b"], "k"), sealExport("md", ["a", "b"], "k"));
    assert.notEqual(sealExport("md", ["a", "b"], "k"), sealExport("md", ["b", "a"], "k"));
  });
});
