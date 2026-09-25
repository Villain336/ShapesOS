// Marketr — O2 digital PR: draft workspace builder (pure).
// Builds the research brief, pitch-the-gap analysis, structured quote
// skeleton (NEVER send-ready), the pre-send checklist, and the de-AI
// rewrite pass. Drafts are working documents — they never send themselves.

export interface JournalistBrief {
  name: string;
  outlet: string;
  recentBeats: string[];
  recentArticles: { title: string; outlet: string; topics: string[] }[];
  alreadyCovered: string[];
  pitchingGuidelines: string[];
  notes: string[];
}

export interface PitchTheGap {
  querySummary: string;
  whatTheyCovered: string[];
  theGap: string[];
  suggestedAngle: string;
  whyClientFits: string;
}

export interface ChecklistItem {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface DeAiResult {
  passed: boolean;
  flags: string[];
  suggestions: string[];
}

/** Fixture journalist research — stands in for beat/article lookup. */
const JOURNALIST_FIXTURES: Record<string, JournalistBrief> = {
  "maya chen": {
    name: "Maya Chen",
    outlet: "The Register",
    recentBeats: ["cybersecurity", "enterprise security", "AI threats"],
    recentArticles: [
      {
        title: "Ransomware crews are automating initial access — here's the data",
        outlet: "The Register",
        topics: ["ransomware", "automation", "enterprise"],
      },
      {
        title: "The SMB security gap: why small firms get hit hardest",
        outlet: "The Register",
        topics: ["small-business", "security", "breach"],
      },
    ],
    alreadyCovered: ["ransomware automation", "SMB breach economics"],
    pitchingGuidelines: [
      "Prefers concrete numbers over vendor claims",
      "No embargoed news without prior agreement",
      "Email subject: query keyword + your credential",
    ],
    notes: ["Fast responder; quotes needed same day", "Skeptical of AI-vendor hype"],
  },
  "priya natarajan": {
    name: "Priya Natarajan",
    outlet: "Forbes",
    recentBeats: ["AI in enterprise", "customer experience", "SaaS"],
    recentArticles: [
      {
        title: "The chatbot backlash: customers want humans back",
        outlet: "Forbes",
        topics: ["chatbots", "customer-experience", "ai"],
      },
      {
        title: "What mid-market AI adoption actually looks like",
        outlet: "Forbes",
        topics: ["ai", "mid-market", "adoption"],
      },
    ],
    alreadyCovered: ["chatbot backlash", "mid-market AI adoption patterns"],
    pitchingGuidelines: [
      "Forbes contributor guidelines: original data or contrarian take",
      "Include headshot + one-line bio with the pitch",
    ],
    notes: ["Covers both enterprise and mid-market"],
  },
};

function defaultBrief(journalist: string, outlet: string): JournalistBrief {
  return {
    name: journalist,
    outlet,
    recentBeats: [],
    recentArticles: [],
    alreadyCovered: [],
    pitchingGuidelines: ["No beat data on file — research the journalist's last 3 articles before pitching"],
    notes: [],
  };
}

/** Research brief from fixture data (beat lookup stand-in). */
export function buildResearchBrief(journalist: string, outlet: string): JournalistBrief {
  return JOURNALIST_FIXTURES[journalist.toLowerCase().trim()] ?? defaultBrief(journalist, outlet);
}

/** Pitch-the-gap: compare the query against what the journalist already covered. */
export function pitchTheGap(
  brief: JournalistBrief,
  queryText: string,
  expertiseSummary: string,
): PitchTheGap {
  const queryLower = queryText.toLowerCase();
  const coveredOverlap = brief.alreadyCovered.filter((t) =>
    t
      .split(/\s+/)
      .some((w) => w.length > 4 && queryLower.includes(w)),
  );
  const gap: string[] = [];
  if (coveredOverlap.length > 0) {
    gap.push(
      `They already covered: ${coveredOverlap.join(", ")}. Do not repeat — bring a contrasting or deeper angle.`,
    );
  }
  gap.push("Uncovered angle: the practitioner's first-hand view — what actually worked in production, with specifics.");
  gap.push("Data gap: journalists quote the source with a number. Bring one real metric or it dies in the inbox.");

  return {
    querySummary: queryText.length > 220 ? `${queryText.slice(0, 220)}…` : queryText,
    whatTheyCovered: brief.alreadyCovered.length > 0 ? brief.alreadyCovered : ["no prior coverage on file"],
    theGap: gap,
    suggestedAngle: `Position the client as the counterpoint to generic advice — a specific, opinionated take grounded in "${expertiseSummary}".`,
    whyClientFits: `Client expertise (${expertiseSummary}) directly intersects the query; the pitch must prove fit in the first two sentences.`,
  };
}

/** Structured quote skeleton — working scaffolding, never send-ready prose. */
export function buildQuoteSkeleton(opts: {
  gap: PitchTheGap;
  journalist: string;
}): string {
  return [
    "[HOOK — 1 sentence, specific and opinionated. NOT a generic opener.]",
    "",
    `[CREDENTIAL — why you specifically: role, scale, proof point]`,
    "",
    "[QUOTE BLOCK — 2–3 sentences, first-person, quotable. Include ONE concrete number or named tactic.]",
    "",
    "[CONTRARIAN EDGE — the take that differs from what they've already covered]",
    "",
    `[CLOSE — 1 line: available for follow-up today/tomorrow; headshot + one-line bio attached as links, never attachments]`,
    "",
    `Context: pitching ${opts.journalist} — angle: ${opts.gap.suggestedAngle}`,
  ].join("\n");
}

export interface ChecklistInput {
  guidelinesChecked: boolean;
  audienceFit: boolean;
  subject: string;
  bodyText: string;
  pitchTheGapDone: boolean;
}

/** Pre-send checklist — all items must pass before a human sends. */
export function buildChecklist(input: ChecklistInput): ChecklistItem[] {
  const items: ChecklistItem[] = [
    {
      id: "guidelines_checked",
      label: "Journalist pitching guidelines checked",
      passed: input.guidelinesChecked,
      detail: input.guidelinesChecked
        ? "Guidelines reviewed against the research brief."
        : "Review the journalist's guidelines in the research brief first.",
    },
    {
      id: "audience_fit",
      label: "Audience fit referenced (outlet reader, not just the journalist)",
      passed: input.audienceFit,
      detail: input.audienceFit
        ? "Outlet audience is addressed in the pitch."
        : "Add one line showing why this story fits the outlet's readers.",
    },
    {
      id: "no_attachments",
      label: "No attachments — text pasted, kit linked",
      passed: true,
      detail: "Structural rule: pitches carry no attachments, ever.",
    },
    {
      id: "subject_length",
      label: "Subject ≤ 49 characters",
      passed: input.subject.length <= 49 && input.subject.length > 0,
      detail:
        input.subject.length === 0
          ? "Subject is empty."
          : `Subject is ${input.subject.length} chars (max 49).`,
    },
    {
      id: "pitch_the_gap",
      label: "Pitch-the-gap analysis completed",
      passed: input.pitchTheGapDone,
      detail: input.pitchTheGapDone
        ? "Gap vs. prior coverage is documented."
        : "Complete the pitch-the-gap analysis — never pitch what they already covered.",
    },
  ];
  return items;
}

export function checklistAllPassed(items: ChecklistItem[]): boolean {
  return items.every((i) => i.passed);
}

// ---------------------------------------------------------------------------
// De-AI rewrite pass. Journalists run AI detectors and are hypersensitive to
// AI signals. Heuristic flags (em-dash density, formulaic openers, tell words,
// uniform paragraph rhythm); returns actionable suggestions. A fail here
// blocks the draft from reaching the human until it is reworked.
// ---------------------------------------------------------------------------

const FORMULAIC_OPENERS = [
  "i hope this email finds you well",
  "i hope this message finds you well",
  "in today's fast-paced",
  "in the ever-evolving",
  "in the digital age",
  "as we navigate",
  "it's important to note that",
  "delve into",
  "it's worth noting",
  "without further ado",
  "hope you're doing well",
];

const AI_TELL_WORDS = [
  "delve",
  "leverage",
  "utilize",
  "furthermore",
  "moreover",
  "tapestry",
  "landscape", // as in "the current landscape" boilerplate
  "robust",
  "seamless",
  "cutting-edge",
  "game-changer",
  "unlock",
  "elevate",
  "holistic",
  "paramount",
  "testament",
  "boasts",
];

/** Run the de-AI heuristic pass over draft text. */
export function deAiPass(text: string): DeAiResult {
  const flags: string[] = [];
  const suggestions: string[] = [];
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const wordCount = Math.max(words.length, 1);

  // Em-dash density: >2 per 100 words is a classic AI signal.
  const emDashCount = (text.match(/—/g) ?? []).length;
  const emDashDensity = (emDashCount / wordCount) * 100;
  if (emDashCount > 0 && emDashDensity > 2) {
    flags.push(`em-dash density: ${emDashCount} em-dashes in ${wordCount} words (${emDashDensity.toFixed(1)}/100w)`);
    suggestions.push("Replace em-dashes with commas, periods, or colons — or just delete the aside.");
  }

  const foundOpeners = FORMULAIC_OPENERS.filter((o) => lower.includes(o));
  if (foundOpeners.length > 0) {
    flags.push(`formulaic opener(s): "${foundOpeners[0]}"`);
    suggestions.push("Open with the specific, opinionated point — never a greeting formula.");
  }

  const foundTells = AI_TELL_WORDS.filter((w) => new RegExp(`\\b${w}\\b`).test(lower));
  if (foundTells.length >= 2) {
    flags.push(`AI tell words: ${foundTells.slice(0, 4).join(", ")}`);
    suggestions.push("Swap tell words for plain verbs a human would use (use, not utilize).");
  }

  // Uniform rhythm: 3+ paragraphs of near-identical sentence counts.
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length >= 3) {
    const sentenceCounts = paragraphs.map((p) => (p.match(/[.!?]+/g) ?? []).length || 1);
    const unique = new Set(sentenceCounts);
    if (unique.size === 1 && sentenceCounts[0] >= 2) {
      flags.push("uniform paragraph rhythm: every paragraph has the same sentence count");
      suggestions.push("Vary sentence and paragraph length — break the cadence deliberately.");
    }
  }

  // Lists of exactly 3 parallel items are an AI fingerprint when repeated.
  const tripleLists = (text.match(/(?:^|\n)\s*(?:[-*•]|\d+\.)\s+/g) ?? []).length;
  if (tripleLists === 3) {
    flags.push("three-bullet parallel list — classic AI structure");
    suggestions.push("Break the 3-item list: fold one point into prose or reorder asymmetrically.");
  }

  return {
    passed: flags.length === 0,
    flags,
    suggestions,
  };
}

export interface DraftWorkspace {
  brief: JournalistBrief;
  gap: PitchTheGap;
  quoteSkeleton: string;
  checklist: ChecklistItem[];
  deAi: DeAiResult;
  deAiPassed: boolean;
}

/** Assemble the full draft workspace for an opportunity (pure). */
export function buildDraftWorkspace(input: {
  journalist: string;
  outlet: string;
  queryText: string;
  expertiseSummary: string;
  subject: string;
  bodyText: string;
  guidelinesChecked: boolean;
  audienceFit: boolean;
}): DraftWorkspace {
  const brief = buildResearchBrief(input.journalist, input.outlet);
  const gap = pitchTheGap(brief, input.queryText, input.expertiseSummary);
  const quoteSkeleton = buildQuoteSkeleton({ gap, journalist: input.journalist });
  const checklist = buildChecklist({
    guidelinesChecked: input.guidelinesChecked,
    audienceFit: input.audienceFit,
    subject: input.subject,
    bodyText: input.bodyText,
    pitchTheGapDone: true,
  });
  const deAi = deAiPass(input.bodyText || quoteSkeleton);
  return {
    brief,
    gap,
    quoteSkeleton,
    checklist,
    deAi,
    deAiPassed: deAi.passed && checklistAllPassed(checklist),
  };
}
