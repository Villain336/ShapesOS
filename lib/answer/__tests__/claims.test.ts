// Phase 21A (WS=agentweb): claim parsing and the verification pass. A claim with
// no supporting stored snippet is marked unsupported, whatever the model said.
// The sources and claims are hand-written; the expected statuses are worked from
// the rules in claims.ts's header, not computed by the code.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSynthesis, verifyClaims, extractClaims } from "../claims";
import type { Source } from "../types";

const src = (id: number, text: string): Source => ({ id, url: `https://s${id}.test/`, title: `S${id}`, text, providers: ["mock"], trust: 0.5, freshness: 0.5, score: 0.5 });
const S1 = src(1, "Riverside Dental is open Monday to Friday, 9:00 to 17:00, and closed on weekends. Phone 020 7946 0000.");
const S2 = src(2, "A crown costs £450 at most NHS band 3 practices. Check-ups cost £26.80.");

const claim = (text: string, cites: number[], evidence: string[] = []) => ({ text, cites, evidence, status: "unsupported" as const });

describe("verifyClaims", () => {
  it("supports a claim whose figures and key words are in the cited source, with its quote", () => {
    const [c] = verifyClaims([claim("Riverside Dental is open Monday to Friday from 9:00 to 17:00.", [1], ["open Monday to Friday, 9:00 to 17:00"])], [S1, S2]);
    assert.deepEqual([c!.status, c!.supportedBy], ["supported", [1]]);
  });
  it("supports a claim without a quote when the source covers it", () => {
    assert.equal(verifyClaims([claim("Check-ups cost £26.80.", [2])], [S1, S2])[0]!.status, "supported");
  });
  it("marks a claim unsupported when a figure is not in the source", () => {
    const [c] = verifyClaims([claim("A crown costs £500.", [2], ["A crown costs £500"])], [S1, S2]);
    assert.deepEqual([c!.status, c!.reason], ["unsupported", "The figure 500 is not in the cited source."]);
  });
  it("marks a claim unsupported when the source says nothing about it", () => {
    const [c] = verifyClaims([claim("The practice offers free parking.", [1])], [S1, S2]);
    assert.deepEqual([c!.status, c!.reason], ["unsupported", "The cited source does not mention this."]);
  });
  it("marks a claim unsupported when the quote the model gave is not in the source", () => {
    const [c] = verifyClaims([claim("A crown costs £450.", [2], ["Crowns are free for everyone"])], [S1, S2]);
    assert.deepEqual([c!.status, c!.reason], ["unsupported", "The quote given is not in the cited source."]);
  });
  it("marks a claim with no citation, and one citing a source that does not exist", () => {
    const [a, b] = verifyClaims([claim("Dentists are great.", []), claim("A crown costs £450.", [7])], [S1, S2]);
    assert.deepEqual([a!.status, a!.reason], ["unsupported", "No source is cited for this."]);
    assert.deepEqual([b!.status, b!.reason], ["unsupported", "It cites a source that is not in the list."]);
  });
  it("one supporting source among several cited is enough, and says which", () => {
    const [c] = verifyClaims([claim("A crown costs £450.", [1, 2])], [S1, S2]);
    assert.deepEqual([c!.status, c!.supportedBy], ["supported", [2]]);
  });
  it("is not fooled by matching currency symbols or punctuation", () => {
    assert.equal(verifyClaims([claim("A crown costs 450 pounds.", [2])], [S1, S2])[0]!.status, "supported");
  });
});

describe("parseSynthesis", () => {
  it("reads claims, cites, evidence and follow-ups from the model's JSON, in a fence or not", () => {
    const raw = '```json\n{"claims":[{"text":"A crown costs £450.","cites":[2],"evidence":["A crown costs £450"]}],"followUps":["What does a check-up cost?"]}\n```';
    assert.deepEqual(parseSynthesis(raw), { claims: [claim("A crown costs £450.", [2], ["A crown costs £450"])], followUps: ["What does a check-up cost?"] });
  });
  it("clips long text, drops junk and non-integer cites, and caps the count", () => {
    const raw = JSON.stringify({ claims: [{ text: "x".repeat(900), cites: [1, "2", 1.5, -1, 3], evidence: ["e".repeat(500), 5] }, { text: 42 }, ...Array.from({ length: 30 }, (_, i) => ({ text: `c${i}`, cites: [1] }))] });
    const got = parseSynthesis(raw)!;
    assert.equal(got.claims[0]!.text.length, 400);
    assert.deepEqual(got.claims[0]!.cites, [1, 3]);
    assert.equal(got.claims[0]!.evidence[0]!.length, 240);
    assert.equal(got.claims.length, 12);
  });
  it("returns null when there is no usable JSON", () => {
    assert.equal(parseSynthesis("I cannot help with that."), null);
    assert.equal(parseSynthesis('{"claims":"nope"}'), null);
  });
});

describe("extractClaims (no model: an extract of the top sources, not a written answer)", () => {
  it("quotes the best-matching sentence of each source that matches, citing it", () => {
    assert.deepEqual(
      extractClaims("when is Riverside Dental open", [S1, S2], 3).map((c) => [c.text, c.cites]),
      [["Riverside Dental is open Monday to Friday, 9:00 to 17:00, and closed on weekends.", [1]]],
    );
    assert.deepEqual(extractClaims("how much does a crown cost", [S1, S2], 3).map((c) => [c.text, c.cites]), [["A crown costs £450 at most NHS band 3 practices.", [2]]]);
  });
  it("says nothing when no source matches", () => {
    assert.deepEqual(extractClaims("weather in Paris", [S1, S2], 3), []);
  });
  it("every extracted claim passes verification by construction", () => {
    const got = verifyClaims(extractClaims("crown cost", [S1, S2], 3), [S1, S2]);
    assert.ok(got.length > 0 && got.every((c) => c.status === "supported"));
  });
});

describe("verifyClaims: reason codes (so a screen can say it in the person's language)", () => {
  it("each unsupported reason has a stable code", () => {
    const got = verifyClaims([claim("x is here.", []), claim("A crown costs £450.", [7]), claim("A crown costs £500.", [2]), claim("A crown costs £450.", [2], ["Crowns are free for everyone"]), claim("The practice offers free parking.", [1])], [S1, S2]);
    assert.deepEqual(got.map((c) => c.reasonCode), ["no_citation", "bad_cite", "figure", "quote", "overlap"]);
  });
  it("a supported claim has none", () => {
    assert.equal(verifyClaims([claim("Check-ups cost £26.80.", [2])], [S1, S2])[0]!.reasonCode, undefined);
  });
});
