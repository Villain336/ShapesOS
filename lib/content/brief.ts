// Marketr — SERP-informed content brief builder (spec §5 flow 3, step 1).
// Pure function: takes a keyword + a SERP snapshot and produces a structured
// brief (intent, H1, H2 outline derived from the top-10 titles, People-Also-Ask
// questions, target word count, entities/topics, sources). No DB, no I/O —
// the API route persists the result to ContentItem.

import type {
  KeywordIntentLabel,
  SerpSnapshot,
} from "@/lib/providers/types";

export interface ContentBriefSource {
  title: string;
  url: string;
  domain: string;
}

export interface ContentBrief {
  keyword: string;
  intent: KeywordIntentLabel;
  h1: string;
  /** Suggested H2s derived from the top-10 ranking titles. */
  h2s: string[];
  /** People-Also-Ask questions to answer in the article. */
  paa: string[];
  /** Target word count (heuristic — see below). */
  targetWordCount: number;
  /** Related entities/topics extracted from SERP titles + snippets. */
  entities: string[];
  /** The top-10 sources the brief was derived from. */
  sources: ContentBriefSource[];
  /** True when the underlying SERP snapshot was mock data. */
  mock: boolean;
}

const STOPWORDS = new Set(
  "a,an,the,and,or,but,if,then,else,when,at,by,for,with,about,into,through,during,before,after,above,below,to,from,up,down,in,out,on,off,over,under,again,further,once,here,there,all,any,both,each,few,more,most,other,some,such,no,not,only,own,same,so,than,too,very,can,will,just,don,should,now,is,are,was,were,be,been,being,have,has,had,having,do,does,did,doing,would,could,ought,i,you,he,she,it,we,they,them,his,her,its,our,their,this,that,these,those,am,of,as".split(
    ",",
  ),
);

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip a ranking title down to its angle: remove the target keyword and brand suffixes. */
function titleToAngle(title: string, keyword: string): string | null {
  // 1. Strip trailing brand suffixes (" | Brand", " - Brand", …). Colons are
  //    left alone — they're usually subtitles, not brands.
  let t = title.replace(/\s*[|\-–—]\s*[A-Z][A-Za-z0-9 .&'’\-]{1,30}$/, "");
  // 2. Split into sentences and take the first one that still says something
  //    meaningful after the keyword is removed.
  const sentences = t.split(/(?<=[.!?])\s+/);
  const kwRe = new RegExp(escapeRegExp(keyword), "gi");
  for (const s of sentences) {
    let c = s.replace(kwRe, "");
    // 3. Drop bare parens/brackets — keyword removal often unbalances them.
    c = c.replace(/[()[\]{}]/g, "");
    c = c
      .replace(/^[\s:|\-–—.,!?/"'“”‘’]+/, "")
      .replace(/[\s:|\-–—.,!?/"'“”‘’]+$/, "");
    c = c.replace(/\s{2,}/g, " ").trim();
    const tokens = c.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
    // Keep it only if it has substance: 2+ real words, or 12+ chars.
    if ((tokens.length >= 2 || c.length >= 12) && c.length <= 90) {
      return c.charAt(0).toUpperCase() + c.slice(1);
    }
  }
  return null;
}

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter(
    (t) => !STOPWORDS.has(t),
  );
}

export function buildBrief(
  phrase: string,
  intent: KeywordIntentLabel,
  serp: SerpSnapshot,
): ContentBrief {
  const keyword = phrase.trim();
  const keywordWords = new Set(tokens(keyword));

  // H2 outline from the top-10 titles, deduped (case-insensitive).
  const seen = new Set<string>();
  const h2s: string[] = [];
  for (const r of serp.results) {
    const angle = titleToAngle(r.title, keyword);
    if (angle && !seen.has(angle.toLowerCase())) {
      seen.add(angle.toLowerCase());
      h2s.push(angle);
    }
    if (h2s.length >= 8) break;
  }

  // Entities: most frequent significant tokens across titles + snippets,
  // excluding the keyword's own words.
  const counts = new Map<string, number>();
  for (const r of serp.results) {
    for (const t of tokens(`${r.title} ${r.description ?? ""}`)) {
      if (keywordWords.has(t)) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const entities = [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([t]) => t);

  // Target word count is a heuristic: SERP APIs don't report body length.
  // Base 1200 words + 100 per PAA question (up to 6) + 25 per outline H2
  // (up to 400), rounded to the nearest 50. Documented, not data-driven.
  const paaCount = Math.min(serp.peopleAlsoAsk.length, 6);
  const h2Count = Math.min(h2s.length, 16);
  const raw = 1200 + 100 * paaCount + 25 * h2Count;
  const targetWordCount = Math.round(raw / 50) * 50;

  return {
    keyword,
    intent,
    h1: titleCase(keyword),
    h2s,
    paa: serp.peopleAlsoAsk.slice(0, 8),
    targetWordCount,
    entities,
    sources: serp.results.map((r) => ({
      title: r.title,
      url: r.url,
      domain: r.domain,
    })),
    mock: serp.mock ?? false,
  };
}

/** Plain-text word count of a markdown body (strips common markup). */
export function wordCount(markdown: string): number {
  const text = markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~`>#|\-[\]()]/g, " ");
  return (text.match(/\S+/g) ?? []).length;
}
