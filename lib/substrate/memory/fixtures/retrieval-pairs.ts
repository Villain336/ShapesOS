// Marketr — Growth Memory retrieval fixtures (Phase 8 G3).
//
// ~40 labeled query → relevant-document pairs used to tune the hybrid
// fusion α and to verify hybrid+rerank beats BM25-only and vector-only
// (spec §2 G3 / §9.9 "retrieval quality battery"). Graded relevance:
//   2 = the exact document the query is about
//   1 = related document (same topic, different angle)
// These fixtures live in the repo so tuning is reproducible; the battery
// (scripts/verify-phase8-memory.mts) plants them in an isolated workspace
// and computes nDCG@10 for each variant.

export interface FixtureDoc {
  key: string;
  store: "episode" | "fact" | "learning";
  title: string;
  body: string;
  observedAt: string; // ISO
  extra?: Record<string, unknown>;
}

export interface LabeledPair {
  /** ISO timestamp for bi-temporal pairs: the fact era that must win. */
  temporalAsOf?: string;
  query: string;
  graded: Record<string, number>; // docKey -> relevance grade
  kind: "lexical" | "semantic" | "typo" | "exact" | "temporal" | "phrase";
  note: string;
}

export const FIXTURE_DOCS: FixtureDoc[] = [
  {
    key: "doc-abandoned-cart-email",
    store: "learning",
    title: "worked: Abandoned-cart email with 10% discount recovered 18% of carts",
    body: "Hypothesis: a plain-text abandoned cart email from the founder outperforms the designed template. Action: sent founder-signed plain-text email with 10% discount code CART10 within 1 hour of abandonment. Worked for DTC skincare, $2.4M revenue. Inconclusive for high-AOV furniture.",
    observedAt: "2026-06-10T14:00:00Z",
  },
  {
    key: "doc-cart-sms",
    store: "learning",
    title: "worked: Cart-abandonment SMS within 20 minutes beats email open rates",
    body: "Hypothesis: SMS follow-up beats email for cart recovery. Action: Twilio SMS 20 minutes after abandonment with checkout link. Worked: 34% click rate vs 11% for email in the same cohort.",
    observedAt: "2026-07-02T14:00:00Z",
  },
  {
    key: "doc-geo-holdout",
    store: "learning",
    title: "worked: Geo-holdout incrementality test showed 22% of paid social was cannibalized",
    body: "Hypothesis: paid social spend has real incremental lift. Action: ran geo-holdout test across 12 DMAs for 4 weeks with matched-market synthetic control. Worked: 22% of attributed conversions were cannibalized organic; reallocated $40k/mo to retail media.",
    observedAt: "2026-05-18T14:00:00Z",
  },
  {
    key: "doc-creator-whitelisting",
    store: "learning",
    title: "inconclusive: Creator whitelisting vs dark-posted UGC on TikTok",
    body: "Hypothesis: whitelisted creator handles outperform dark-posted UGC. Action: split $30k between whitelisted Spark Ads and dark-posted UGC on TikTok. Inconclusive: CPA within 4% of each other; creative variance dominated.",
    observedAt: "2026-08-01T14:00:00Z",
  },
  {
    key: "doc-landing-speed",
    store: "fact",
    title: "predicate: landing_page_lcp_threshold",
    body: "Pages with LCP above 2.5s convert 31% worse than pages under 2.5s, measured across 14 landing pages in Q2 2026.",
    observedAt: "2026-06-30T14:00:00Z",
    extra: { predicate: "landing_page_lcp_threshold", origin: "user_told", confidence: 0.95 },
  },
  {
    key: "doc-brand-bid",
    store: "learning",
    title: "failed: Bidding on competitor brand terms triggered retaliation",
    body: "Hypothesis: conquesting competitor brand keywords is cheap incremental volume. Action: bid on three competitor brand terms at $12k/mo. Failed: competitors retaliated on our brand terms within 9 days, CPCs doubled, net ROAS negative.",
    observedAt: "2026-04-22T14:00:00Z",
  },
  {
    key: "doc-review-reply",
    store: "episode",
    title: "episode: Google Business Profile review reply sprint",
    body: "Actor: agent. We drafted replies for 47 pending Google reviews in the approval queue. The owner approved 41 and rejected 6 for sounding too corporate. Learning: keep replies under 40 words and reference the specific service mentioned.",
    observedAt: "2026-08-20T14:00:00Z",
    extra: { actor: "agent", episodeType: "run" },
  },
  {
    key: "doc-email-subject",
    store: "learning",
    title: "worked: Subject lines with numbers beat questions by 19% open rate",
    body: "Hypothesis: numeric subject lines beat question subject lines. Action: A/B tested 12 newsletter sends, numeric vs question framing. Worked: numbers won by 19% relative open rate, consistent across segments.",
    observedAt: "2026-03-15T14:00:00Z",
  },
  {
    key: "doc-q4-ctv",
    store: "episode",
    title: "episode: Q4 CTV flight post-mortem",
    body: "Actor: agent. The fall CTV flight on Vibe delivered 4.1M impressions at $28 CPM. QR-code vanity URL drove 3,200 sessions but only 41 purchases. Post-mortem: CTV works for awareness, not last-click; measure with geo-lift next time.",
    observedAt: "2026-09-05T14:00:00Z",
    extra: { actor: "agent", episodeType: "run" },
  },
  {
    key: "doc-seo-cannibalization",
    store: "fact",
    title: "predicate: keyword_cannibalization_threshold",
    body: "When two pages rank positions 6-15 for the same keyword cluster, consolidating them lifts the survivor by an average of 3.2 positions.",
    observedAt: "2026-05-30T14:00:00Z",
    extra: { predicate: "keyword_cannibalization_threshold", origin: "agent_inferred", confidence: 0.7 },
  },
  {
    key: "doc-pricing-test",
    store: "learning",
    title: "worked: Annual prepay discount at 20% doubled cash collected",
    body: "Hypothesis: a 20% annual prepay discount improves cash flow without hurting LTV. Action: offered 2 months free on annual plans to 400 trial users. Worked: cash collected doubled, 12-month retention unchanged.",
    observedAt: "2026-02-11T14:00:00Z",
  },
  {
    key: "doc-webinar",
    store: "learning",
    title: "inconclusive: Webinar vs live demo for mid-market pipeline",
    body: "Hypothesis: live demos convert better than webinars for mid-market. Action: ran 6 webinars and 40 live demos in parallel. Inconclusive: demo no-show rate was 55%; webinar attendees were earlier-stage.",
    observedAt: "2026-07-28T14:00:00Z",
  },
  {
    key: "doc-attribution-window",
    store: "fact",
    title: "predicate: attribution_window_days",
    body: "The account uses a 7-day click, 1-day view attribution window for paid social reporting.",
    observedAt: "2026-01-15T14:00:00Z",
    extra: { predicate: "attribution_window_days", origin: "user_told", confidence: 1.0 },
  },
  {
    key: "doc-ugc-hook",
    store: "learning",
    title: "worked: First-3-second pattern interrupt doubled hook rate",
    body: "Hypothesis: pattern-interrupt openings improve hook rate on paid social video. Action: recut 20 UGC ads with first-3-second visual interrupts. Worked: hook rate doubled from 18% to 37%, thumbstop up 22%.",
    observedAt: "2026-08-14T14:00:00Z",
  },
  {
    key: "doc-linkedin-thought",
    store: "learning",
    title: "failed: LinkedIn thought-leadership ads for SMB had $180 CAC",
    body: "Hypothesis: founder thought-leadership content converts SMB on LinkedIn. Action: $25k document-ad campaign. Failed: $180 CAC vs $65 target; audience too senior, buying committees absent.",
    observedAt: "2026-06-25T14:00:00Z",
  },
  {
    key: "doc-email-cadence",
    store: "fact",
    title: "predicate: email_send_cadence",
    body: "The newsletter sends every Tuesday at 9am ET. Open rates drop 12% when sends slip past 11am.",
    observedAt: "2026-04-01T14:00:00Z",
    extra: { predicate: "email_send_cadence", origin: "user_told", confidence: 1.0 },
  },
  {
    key: "doc-exp-1042",
    store: "learning",
    title: "worked: EXP-1042 checkout progress bar reduced abandonment",
    body: "Hypothesis: a checkout progress bar reduces perceived effort. Action: experiment EXP-1042 added a 3-step progress bar to checkout. Worked: abandonment down 9%, p=0.02 over 21 days.",
    observedAt: "2026-08-30T14:00:00Z",
    extra: { experimentId: "EXP-1042" },
  },
  {
    key: "doc-err-timeout",
    store: "episode",
    title: "episode: ERR_TIMEOUT in DataForSEO bulk keyword pull",
    body: "Actor: agent. The bulk keyword pull hit ERR_TIMEOUT after 90s on the DataForSEO Labs endpoint. Retried with paginated batches of 500 and it completed. Added retry-with-backoff to the keyword job.",
    observedAt: "2026-09-12T14:00:00Z",
    extra: { actor: "agent", episodeType: "session" },
  },
  {
    key: "doc-old-positioning",
    store: "fact",
    title: "predicate: brand_positioning",
    body: "Brand positioning as of Q1 2026: 'the affordable analytics platform for startups'.",
    observedAt: "2026-01-20T14:00:00Z",
    extra: { predicate: "brand_positioning", origin: "user_told", confidence: 1.0, validAt: "2026-01-20T00:00:00Z", invalidAt: "2026-08-01T00:00:00Z" },
  },
  {
    key: "doc-new-positioning",
    store: "fact",
    title: "predicate: brand_positioning",
    body: "Brand positioning as of Q3 2026: 'the revenue intelligence platform for growth teams'.",
    observedAt: "2026-08-01T14:00:00Z",
    extra: { predicate: "brand_positioning", origin: "user_told", confidence: 1.0, validAt: "2026-08-01T00:00:00Z" },
  },
  {
    key: "doc-referral",
    store: "learning",
    title: "worked: Double-sided referral ($25/$25) beat single-sided",
    body: "Hypothesis: double-sided referral incentives beat single-sided. Action: tested $25/$25 vs $50 giver-only. Worked: double-sided drove 2.3x referral starts at equal CAC.",
    observedAt: "2026-05-05T14:00:00Z",
  },
  {
    key: "doc-podcast",
    store: "learning",
    title: "inconclusive: Podcast host-read ads vs programmatic",
    body: "Hypothesis: host-read podcast ads beat programmatic for B2B. Action: $18k host-read test on 3 shows vs programmatic baseline. Inconclusive: vanity URL traffic up but attribution muddy; promo-code usage near zero.",
    observedAt: "2026-07-19T14:00:00Z",
  },
  {
    key: "doc-churn-survey",
    store: "episode",
    title: "episode: Churn survey synthesis",
    body: "Actor: strategist. Synthesized 120 churn survey responses. Top reasons: price (34%), missing integration (28%), never onboarded (22%). Recommendation: onboarding checklist experiment next quarter.",
    observedAt: "2026-06-18T14:00:00Z",
    extra: { actor: "strategist", episodeType: "sync" },
  },
  {
    key: "doc-free-trial",
    store: "learning",
    title: "worked: 14-day trial beat 30-day on activation",
    body: "Hypothesis: shorter trials create urgency and improve activation. Action: cut trial from 30 to 14 days for 50% of signups. Worked: activation up 11%, paid conversion unchanged.",
    observedAt: "2026-03-28T14:00:00Z",
  },
];

export const LABELED_PAIRS: LabeledPair[] = [
  // Lexical: rare distinctive terms.
  { query: "abandoned cart discount email recovery", graded: { "doc-abandoned-cart-email": 2, "doc-cart-sms": 1 }, kind: "lexical", note: "Distinctive cart-email terms; SMS doc is topical sibling" },
  { query: "geo holdout incrementality cannibalized conversions", graded: { "doc-geo-holdout": 2 }, kind: "lexical", note: "Rare compound terms" },
  { query: "Spark Ads whitelisted creator handles TikTok CPA", graded: { "doc-creator-whitelisting": 2 }, kind: "lexical", note: "Platform-specific vocabulary" },
  { query: "competitor brand conquesting retaliation CPC doubled", graded: { "doc-brand-bid": 2 }, kind: "lexical", note: "Conquesting narrative" },
  { query: "EXP-1042 checkout progress bar", graded: { "doc-exp-1042": 2 }, kind: "exact", note: "Experiment ID exact match" },
  { query: "ERR_TIMEOUT DataForSEO bulk keyword pull", graded: { "doc-err-timeout": 2 }, kind: "exact", note: "Error code exact match" },
  { query: "double-sided referral incentive twenty-five dollars", graded: { "doc-referral": 2 }, kind: "lexical", note: "Numbers-as-words lexical" },
  { query: "podcast host-read vanity URL attribution muddy", graded: { "doc-podcast": 2 }, kind: "lexical", note: "Podcast-specific vocabulary" },

  // Semantic: paraphrases with little term overlap.
  { query: "how to win back shoppers who left items in their basket", graded: { "doc-abandoned-cart-email": 2, "doc-cart-sms": 1 }, kind: "semantic", note: "Paraphrase of cart recovery" },
  { query: "measuring true incremental lift of ad spend with control markets", graded: { "doc-geo-holdout": 2 }, kind: "semantic", note: "Paraphrase of geo-holdout" },
  { query: "what video openings keep viewers watching past three seconds", graded: { "doc-ugc-hook": 2 }, kind: "semantic", note: "Paraphrase of hook rate" },
  { query: "shorter free trials converting better than long ones", graded: { "doc-free-trial": 2 }, kind: "semantic", note: "Paraphrase of trial length" },
  { query: "paying customers to invite friends vs rewarding only the inviter", graded: { "doc-referral": 2 }, kind: "semantic", note: "Paraphrase of double-sided referral" },
  { query: "when two pages compete for the same search terms", graded: { "doc-seo-cannibalization": 2 }, kind: "semantic", note: "Paraphrase of keyword cannibalization" },
  { query: "slow pages hurting conversion rate", graded: { "doc-landing-speed": 2 }, kind: "semantic", note: "Paraphrase of LCP threshold" },
  { query: "founder-signed plain text messages for recovering lost sales", graded: { "doc-abandoned-cart-email": 2, "doc-cart-sms": 1 }, kind: "semantic", note: "Paraphrase mixing email + SMS docs" },

  // Typos: trigram robustness.
  { query: "abandond cart emial discount", graded: { "doc-abandoned-cart-email": 2 }, kind: "typo", note: "Two typos, trigram should still match" },
  { query: "geo holdot incrementality", graded: { "doc-geo-holdout": 2 }, kind: "typo", note: "Single typo" },
  { query: "referal incntive double sided", graded: { "doc-referral": 2 }, kind: "typo", note: "Two typos" },
  { query: "chekout progress bar experiment", graded: { "doc-exp-1042": 2 }, kind: "typo", note: "Typo + experiment context" },

  // Exact: quoted phrases and IDs.
  { query: '"pattern interrupt doubled hook rate"', graded: { "doc-ugc-hook": 2 }, kind: "exact", note: "Quoted phrase" },
  { query: "EXP-1042", graded: { "doc-exp-1042": 2 }, kind: "exact", note: "Bare experiment ID" },

  // Temporal: as_of behavior (battery sets asOf explicitly).
  { query: "brand positioning", graded: { "doc-new-positioning": 2 }, kind: "temporal", note: "Current era: new positioning wins", temporalAsOf: "2026-09-01T00:00:00Z" },
  { query: "brand positioning", graded: { "doc-old-positioning": 2 }, kind: "temporal", note: "Old era: old positioning was current", temporalAsOf: "2026-05-01T00:00:00Z" },

  // Phrase / mixed.
  { query: "subject lines with numbers open rate test", graded: { "doc-email-subject": 2 }, kind: "phrase", note: "Numeric subject line test" },
  { query: "CTV flight QR code vanity URL purchases", graded: { "doc-q4-ctv": 2 }, kind: "lexical", note: "CTV post-mortem details" },
  { query: "Google review reply approval queue too corporate", graded: { "doc-review-reply": 2 }, kind: "lexical", note: "Review reply episode" },
  { query: "newsletter send time Tuesday morning open rates", graded: { "doc-email-cadence": 2 }, kind: "semantic", note: "Email cadence fact, paraphrased" },
  { query: "attribution window paid social reporting", graded: { "doc-attribution-window": 2 }, kind: "lexical", note: "Attribution window fact" },
  { query: "LinkedIn document ads SMB customer acquisition cost too high", graded: { "doc-linkedin-thought": 2 }, kind: "semantic", note: "LinkedIn failure, paraphrased" },
  { query: "annual prepay discount cash flow retention", graded: { "doc-pricing-test": 2 }, kind: "lexical", note: "Pricing test" },
  { query: "webinar versus live demo no-show rate pipeline", graded: { "doc-webinar": 2 }, kind: "lexical", note: "Webinar inconclusive" },
  { query: "churn survey price missing integration never onboarded", graded: { "doc-churn-survey": 2 }, kind: "lexical", note: "Churn synthesis episode" },
  { query: "SMS twenty minutes after abandonment click rate", graded: { "doc-cart-sms": 2, "doc-abandoned-cart-email": 1 }, kind: "lexical", note: "SMS timing detail" },
  { query: "dark-posted UGC versus whitelisted Spark Ads", graded: { "doc-creator-whitelisting": 2 }, kind: "phrase", note: "Creator test phrasing" },
  { query: "thumbstop rate pattern interrupt UGC recut", graded: { "doc-ugc-hook": 2 }, kind: "lexical", note: "Hook-rate vocabulary" },
  { query: "two pages ranking for same keyword cluster consolidate", graded: { "doc-seo-cannibalization": 2 }, kind: "phrase", note: "Cannibalization consolidation" },
  { query: "LCP above two point five seconds convert worse", graded: { "doc-landing-speed": 2 }, kind: "semantic", note: "LCP paraphrase" },
  { query: "founder thought leadership document ads senior audience", graded: { "doc-linkedin-thought": 2 }, kind: "phrase", note: "LinkedIn audience mismatch" },
  { query: "trial urgency activation paid conversion unchanged", graded: { "doc-free-trial": 2 }, kind: "semantic", note: "Trial result paraphrase" },
  { query: "host read ads promo code usage near zero", graded: { "doc-podcast": 2 }, kind: "phrase", note: "Podcast detail phrase" },
];

export interface TemporalLabeledPair extends LabeledPair {
  temporalAsOf?: string;
}

export const TEMPORAL_PAIRS: TemporalLabeledPair[] = LABELED_PAIRS.filter(
  (p) => (p as TemporalLabeledPair).temporalAsOf,
) as TemporalLabeledPair[];

/** nDCG@k for one query: graded relevance, standard formulation. */
export function ndcgAtK(rankedKeys: string[], graded: Record<string, number>, k = 10): number {
  const gains = rankedKeys.slice(0, k).map((key) => graded[key] ?? 0);
  const dcg = gains.reduce((sum, g, i) => sum + (Math.pow(2, g) - 1) / Math.log2(i + 2), 0);
  const ideal = Object.values(graded)
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, g, i) => sum + (Math.pow(2, g) - 1) / Math.log2(i + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}
