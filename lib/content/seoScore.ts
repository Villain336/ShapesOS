// Marketr — explainable live SEO score (spec §5 flow 3, step 3).
// Pure function: scores a markdown draft 0–100 against the brief it was
// written from. Every check is a visible checklist item so the score is
// explainable, not a black box. Used by the client component for the live
// score AND by the save API route to persist seoScore — same function,
// same numbers.

export interface SeoCheck {
  id: string;
  label: string;
  points: number;
  max: number;
  passed: boolean;
  /** Partial credit is allowed; detail explains what was found. */
  detail: string;
}

export interface SeoScoreInput {
  bodyMarkdown: string;
  keyword: string;
  targetWordCount: number;
  /** Suggested H2s from the brief. */
  h2s: string[];
  /** People-Also-Ask questions from the brief. */
  paa: string[];
  /** Phrases of the project's OTHER saved keywords (internal-link mining). */
  otherKeywords: string[];
}

export interface SeoScoreResult {
  score: number;
  wordCount: number;
  checks: SeoCheck[];
  /** Saved keywords mentioned in the body — suggested internal-link targets. */
  internalLinkSuggestions: string[];
}

const STOPWORDS = new Set(
  "a,an,the,and,or,but,if,then,else,when,at,by,for,with,about,into,through,during,before,after,above,below,to,from,up,down,in,out,on,off,over,under,again,further,once,here,there,all,any,both,each,few,more,most,other,some,such,no,not,only,own,same,so,than,too,very,can,will,just,don,should,now,is,are,was,were,be,been,being,have,has,had,having,do,does,did,doing,would,could,ought,i,you,he,she,it,we,they,their,this,that,these,those,am,of,as,what,how,much,does,where,which,who,whom,whose,why,whether".split(
    ",",
  ),
);

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Significant tokens of a phrase: lowercase, ≥4 chars, not stopwords. */
function sigTokens(phrase: string): string[] {
  return (norm(phrase).match(/[a-z0-9]{4,}/g) ?? []).filter(
    (t) => !STOPWORDS.has(t),
  );
}

function wordCount(text: string): number {
  const clean = text.replace(/^#{1,6}\s+/gm, "").replace(/[*_~`>#|[\]()\-]/g, " ");
  return (clean.match(/\S+/g) ?? []).length;
}

function headings(body: string): { level: number; text: string }[] {
  return body
    .split("\n")
    .map((l) => l.match(/^(#{1,6})\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ level: m[1].length, text: m[2].trim() }));
}

/** Share of a phrase's significant tokens present in the body text. */
function tokenCoverage(phrase: string, bodyNorm: string): number {
  const tokens = sigTokens(phrase);
  if (tokens.length === 0) return 1;
  const hits = tokens.filter((t) => bodyNorm.includes(t)).length;
  return hits / tokens.length;
}

export function scoreContent(input: SeoScoreInput): SeoScoreResult {
  const { bodyMarkdown, keyword, targetWordCount, h2s, paa, otherKeywords } =
    input;
  const body = bodyMarkdown ?? "";
  const bodyNorm = norm(body.replace(/[#*_~`>|[\]()\-]/g, " "));
  const keywordNorm = norm(keyword);
  const kw = headings(body);
  const firstHeading = kw[0]?.text ?? body.split("\n").find((l) => l.trim()) ?? "";
  const firstH1 = kw.find((h) => h.level === 1)?.text ?? "";
  const wc = wordCount(body);
  const first100 = bodyNorm.split(" ").slice(0, 100).join(" ");

  const checks: SeoCheck[] = [];

  // 1. Keyword in title (15)
  const inTitle = keywordNorm.length > 0 && norm(firstHeading).includes(keywordNorm);
  checks.push({
    id: "title",
    label: "Target keyword in the title",
    max: 15,
    points: inTitle ? 15 : 0,
    passed: inTitle,
    detail: inTitle ? `Found in “${firstHeading.slice(0, 60)}”.` : "Add the keyword to the title/first line.",
  });

  // 2. Keyword in H1 (10)
  const inH1 = keywordNorm.length > 0 && norm(firstH1).includes(keywordNorm);
  checks.push({
    id: "h1",
    label: "Target keyword in the H1",
    max: 10,
    points: inH1 ? 10 : 0,
    passed: inH1,
    detail: inH1 ? "H1 contains the keyword." : "Add the keyword to the H1.",
  });

  // 3. Keyword in first 100 words (15)
  const inFirst100 = keywordNorm.length > 0 && first100.includes(keywordNorm);
  checks.push({
    id: "intro",
    label: "Target keyword in the first 100 words",
    max: 15,
    points: inFirst100 ? 15 : 0,
    passed: inFirst100,
    detail: inFirst100
      ? "Keyword appears in the opening."
      : "Work the keyword into the first paragraph.",
  });

  // 4. H2 coverage (20): share of brief H2s whose key terms appear in the body.
  let coveredH2 = 0;
  for (const h2 of h2s) {
    if (tokenCoverage(h2, bodyNorm) >= 0.6) coveredH2++;
  }
  const h2Share = h2s.length === 0 ? 1 : coveredH2 / h2s.length;
  checks.push({
    id: "h2",
    label: `Brief H2 coverage (${coveredH2}/${h2s.length})`,
    max: 20,
    points: Math.round(20 * h2Share),
    passed: h2Share >= 0.8,
    detail:
      h2s.length === 0
        ? "No H2s in the brief."
        : `${coveredH2} of ${h2s.length} suggested H2 topics are covered.`,
  });

  // 5. Word count vs target (15)
  let wcPoints = 0;
  let wcDetail: string;
  if (targetWordCount > 0 && wc > 0) {
    const ratio = wc / targetWordCount;
    if (ratio >= 0.8 && ratio <= 1.2) {
      wcPoints = 15;
      wcDetail = `${wc.toLocaleString()} words — on target (${targetWordCount.toLocaleString()}).`;
    } else if (ratio >= 0.6 && ratio <= 1.4) {
      wcPoints = 8;
      wcDetail = `${wc.toLocaleString()} words vs target ${targetWordCount.toLocaleString()} — close.`;
    } else {
      wcDetail = `${wc.toLocaleString()} words vs target ${targetWordCount.toLocaleString()} — off target.`;
    }
  } else {
    wcDetail = "No body text yet.";
  }
  checks.push({
    id: "length",
    label: `Length vs. target (${targetWordCount.toLocaleString()} words)`,
    max: 15,
    points: wcPoints,
    passed: wcPoints === 15,
    detail: wcDetail,
  });

  // 6. PAA answered (15): share of People-Also-Ask questions whose key terms appear.
  let answeredPaa = 0;
  for (const q of paa) {
    if (tokenCoverage(q, bodyNorm) >= 0.6) answeredPaa++;
  }
  const paaShare = paa.length === 0 ? 1 : answeredPaa / paa.length;
  checks.push({
    id: "paa",
    label: `People-Also-Ask answered (${answeredPaa}/${paa.length})`,
    max: 15,
    points: Math.round(15 * paaShare),
    passed: paaShare >= 0.8,
    detail:
      paa.length === 0
        ? "No PAA questions in the brief."
        : `${answeredPaa} of ${paa.length} reader questions are addressed.`,
  });

  // 7. Internal links (10): mentions of other saved keywords = link opportunities.
  const mentioned = otherKeywords.filter(
    (k) => norm(k).length > 0 && norm(k) !== keywordNorm && bodyNorm.includes(norm(k)),
  );
  checks.push({
    id: "links",
    label: `Internal-link opportunities (${mentioned.length} found)`,
    max: 10,
    points: Math.min(5, mentioned.length) * 2,
    passed: mentioned.length >= 3,
    detail:
      mentioned.length === 0
        ? "Mention other saved keywords to create internal links."
        : `Link these: ${mentioned.slice(0, 5).join(", ")}.`,
  });

  const score = Math.max(0, Math.min(100, checks.reduce((s, c) => s + c.points, 0)));

  return {
    score,
    wordCount: wc,
    checks,
    internalLinkSuggestions: mentioned,
  };
}
