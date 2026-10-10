// ShapesOS — Phase 21A (WS=agentweb): claims, citations and the verification pass (PURE).
//
// The model writes the answer as CLAIMS: one factual sentence each, citing
// numbered sources and quoting the words that back it. We do not trust that.
// verifyClaims() re-checks every claim against the text we stored for the
// sources it cites, with rules a person could check by hand:
//
//   - a claim must cite a source that exists;
//   - if the model quoted evidence, at least one quote (12+ characters) must
//     appear in the cited source's stored text;
//   - every figure in the claim (9:00, 450, 26.80) must appear in that text;
//   - at least 60% of the claim's key words (5+ letters, not filler) must too.
//
// A claim passes when ONE cited source passes all of that. Otherwise it is
// marked unsupported with the reason, and the UI shows it as such. This catches
// invented figures, invented facts and fake quotes. It cannot catch a claim
// that reuses a source's words but means something else; it is a floor, not a
// proof, and the answer always links the sources for a person to read.

import type { Claim, Source } from "./types";

const MAX_CLAIMS = 12;
const STOP = new Set([
  "about", "after", "again", "among", "because", "before", "being", "between", "could", "every", "other", "their", "there", "these", "those", "through", "under", "until", "where", "which", "while", "would", "should", "still", "often", "usually", "generally", "typically", "includes", "include", "offers", "offer", "provides", "provide",
]);

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
const stem = (w: string) => w.replace(/(ing|es|s)$/, "");

function figures(s: string): string[] {
  return [...norm(s).matchAll(/\d+(?:[.,:]\d+)*/g)].map((m) => m[0].replace(/,/g, ""));
}
function keyWords(s: string): string[] {
  return [...new Set([...norm(s).matchAll(/[a-z][a-z'-]{4,}/g)].map((m) => stem(m[0])).filter((w) => !STOP.has(w) && !STOP.has(`${w}s`)))];
}
const flat = (s: string) => norm(s).replace(/[^a-z0-9:.,]+/g, " ").replace(/\s+/g, " ").trim();

interface Check {
  ok: boolean;
  reason: string;
  rank: number;
}

function checkAgainst(claim: Claim, source: Source): Check {
  const text = flat(source.text);
  const stems = new Set(keyWords(source.text));
  const bodyFigures = new Set(figures(source.text));
  const missing = figures(claim.text).find((f) => !bodyFigures.has(f.replace(/\.$/, "")) && !text.includes(f));
  if (missing) return { ok: false, reason: `The figure ${missing.replace(/[.,]$/, "")} is not in the cited source.`, rank: 3 };
  const quotes = claim.evidence.map(flat).filter((q) => q.length >= 12);
  if (claim.evidence.length > 0 && !quotes.some((q) => text.includes(q))) return { ok: false, reason: "The quote given is not in the cited source.", rank: 2 };
  const words = keyWords(claim.text);
  const covered = words.filter((w) => stems.has(w)).length;
  if (words.length > 0 && covered / words.length < 0.6) return { ok: false, reason: "The cited source does not mention this.", rank: 1 };
  return { ok: true, reason: "", rank: 0 };
}

export function verifyClaims(claims: Claim[], sources: Source[]): Claim[] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return claims.map((c) => {
    if (c.cites.length === 0) return { ...c, status: "unsupported", reason: "No source is cited for this." };
    const cited = c.cites.map((id) => byId.get(id)).filter((s): s is Source => !!s);
    if (cited.length === 0) return { ...c, status: "unsupported", reason: "It cites a source that is not in the list." };
    const checks = cited.map((s) => ({ s, ...checkAgainst(c, s) }));
    const passing = checks.filter((x) => x.ok);
    if (passing.length) return { ...c, status: "supported", supportedBy: passing.map((x) => x.s.id), reason: undefined };
    const worst = checks.sort((a, b) => b.rank - a.rank)[0]!;
    return { ...c, status: "unsupported", supportedBy: undefined, reason: worst.reason };
  });
}

/** Parse the model's JSON reply. Null when there is nothing usable. */
export function parseSynthesis(raw: string): { claims: Claim[]; followUps: string[] } | null {
  const body = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)?.[1] ?? raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let j: { claims?: unknown; followUps?: unknown };
  try {
    j = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(j.claims)) return null;
  const claims: Claim[] = [];
  for (const c of j.claims as Array<Record<string, unknown>>) {
    if (!c || typeof c.text !== "string" || !c.text.trim()) continue;
    claims.push({
      text: c.text.trim().slice(0, 400),
      cites: (Array.isArray(c.cites) ? c.cites : []).filter((x): x is number => Number.isInteger(x) && (x as number) >= 1),
      evidence: (Array.isArray(c.evidence) ? c.evidence : []).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 240)).slice(0, 3),
      status: "unsupported",
    });
    if (claims.length >= MAX_CLAIMS) break;
  }
  const followUps = (Array.isArray(j.followUps) ? j.followUps : []).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 160)).slice(0, 3);
  return { claims, followUps };
}

/** No model: quote the sentence of each matching source that best matches the question. */
export function extractClaims(question: string, sources: Source[], max = 4): Claim[] {
  const want = new Set(keyWords(question).concat(norm(question).split(/[^a-z0-9]+/).filter((w) => w.length > 3).map(stem)));
  const out: Claim[] = [];
  for (const s of sources) {
    const sentences = s.text.split(/(?<=[.!?])\s+(?=[A-Z0-9£$€])/).map((x) => x.trim()).filter((x) => x.length > 15);
    let best: { text: string; n: number } | null = null;
    for (const sentence of sentences) {
      const n = [...new Set(norm(sentence).split(/[^a-z0-9]+/).map(stem))].filter((w) => w.length > 3 && want.has(w)).length;
      if (n > 0 && (!best || n > best.n)) best = { text: sentence, n };
    }
    if (best) out.push({ text: best.text.slice(0, 400), cites: [s.id], evidence: [best.text.slice(0, 240)], status: "unsupported" });
    if (out.length >= max) break;
  }
  return out;
}
