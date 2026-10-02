#!/usr/bin/env python3
"""R09 pilot generator: compliance-aware copy traces.
Writes ~/workspace/marketr/training/traces/traces-r09-pilot.jsonl
Grounded ONLY in corpus chunks actually read (see CHUNK_NOTES).
"""
import json, hashlib, os, re
from collections import Counter

HOME = os.path.expanduser("~")
OUT = f"{HOME}/workspace/marketr/training/traces/traces-r09-pilot.jsonl"
MARKETS = ["US", "UK", "EU", "CA", "AU"]
CREATED = "2026-09-26"

# Chunk IDs actually read in full during research (main/chunks.jsonl).
CHUNK_NOTES = {
    "my-life-in-advertising#259": "Hopkins: advertising must tell the truth; definite figures are accepted at par (so they must be true).",
    "my-life-in-advertising#124": "Hopkins on proprietaries: testimonials were universal, reckless claims common; he published none.",
    "scientific-advertising#45": "Puffery ('lowest prices in America') vs a definite, impressive statement ('net profit 3%').",
    "calkins-business-of-advertising#20": "Publishers reject copy that intentionally or unintentionally misleads; detection of misleading copy is the gatekeeper's job.",
    "calkins-business-of-advertising#464": "The word 'free' must not be used unless actually free or conditions equally prominent; 'blind' misleading advertising not acceptable.",
    "scott-psychology-of-advertising#260": "Consumers choose ads they believe reliable; reliability is the top driver of ad interest.",
    "1s-copyhackers-blog#4": "Never clickbait: misleading subject lines train the spam filter and the subscriber; testimonials should mirror and resolve objections.",
    "1s-cxl-blog#4": "Urgency and scarcity must be honest-only; fake urgency erodes trust.",
    "1s-reddit-for-business#1": "Anti-astroturf discipline: never fake grassroots enthusiasm; be open about brand presence.",
    "1s-baymard#8": "Trust signals at the payment step; guarantee/return messaging belongs at the moment of doubt.",
    "1s-baymard#11": "Checkout audit: 'Did any cost appear that I hadn't seen before the final step?' cost surprises first.",
    "1s-copyhackers-blog#2": "Headlines need specificity (numbers, timeframes, outcomes); clarity beats cleverness.",
    "google-search-central#68": "Deceptive practices create a mismatch between user expectations and the actual outcome.",
    "google-search-central#70": "Misleading functionality: tricking users about what a site/service actually provides.",
    "google-search-central#81": "Commercial communications must be clearly disclosed; the commercial character must be obvious.",
    "google-search-central#56": "Policies exist to protect users from deceptive techniques; violations draw enforcement.",
}

# Market x category -> (rule labels, what the rule requires). All rule names are real.
RULES = {
 "health": {
  "US": ("FTC substantiation doctrine; FTC Health Products Compliance Guidance (2022)",
          "Health claims need competent and reliable scientific evidence held BEFORE the claim runs; disease claims need human clinical testing. The net impression, not just the literal words, is what regulators judge."),
  "UK": ("ASA CAP Code Section 12 (medicines, medical devices, health-related and beauty products); rule 3.7 (substantiation)",
          "Efficacy claims need robust evidence; medicinal claims for unlicensed products are barred; substantiation must be held before publication and be adequate for the claim."),
  "EU": ("Unfair Commercial Practices Directive 2005/29/EC; EU Health Claims Regulation 1924/2006; EFSA substantiation",
          "Only authorized health claims from the EU register may be used; disease-risk-reduction claims face strict authorization; national authorities enforce against unsubstantiated claims."),
  "CA": ("Competition Act s.74.01 (false or misleading representations); Health Canada advertising rules",
          "Performance claims require 'adequate and proper testing' conducted before the claim; disease claims for natural health products need Health Canada authorization."),
  "AU": ("Australian Consumer Law s.18 (misleading or deceptive conduct); TGA advertising rules for therapeutic goods",
          "Therapeutic claims need substantiation; s.18 is breached by conduct likely to mislead, regardless of intent; TGA restricts disease claims in ads to the public."),
 },
 "finance": {
  "US": ("FTC Act Section 5 (unfair or deceptive acts or practices); FTC deceptive earnings-claims standard",
          "Earnings and returns claims must reflect what typical consumers achieve; atypical results need clear disclosure of what is typical; 'guaranteed' returns claims are judged against real risk."),
  "UK": ("FCA financial-promotion rules (FSMA s.21 restriction); ASA CAP Code Section 14 (financial products)",
          "Financial promotions must be fair, clear and not misleading; risk warnings required; past performance is not a reliable indicator and must be stated as such."),
  "EU": ("Unfair Commercial Practices Directive 2005/29/EC; MiFID II marketing-communications standard",
          "Investment marketing must be fair, clear and not misleading; risks must be disclosed prominently; aggressive or misleading practices toward consumers are prohibited."),
  "CA": ("Competition Act s.74.01 (false or misleading representations)",
          "Earnings and investment claims need adequate and proper testing; the general impression conveyed to the ordinary consumer is what counts."),
  "AU": ("Australian Consumer Law s.18/s.29; ASIC financial-promotion and advice rules",
          "Misleading statements about financial products breach s.18/s.29; unlicensed financial advice and deceptive returns claims draw ASIC action."),
 },
 "beauty": {
  "US": ("FTC substantiation doctrine (competent and reliable scientific evidence for efficacy claims)",
          "Cosmetic efficacy claims (wrinkle reduction, hair growth) need scientific evidence matching the claim's strength; before/after imagery implies an efficacy claim."),
  "UK": ("ASA CAP Code Section 12 (health-related and beauty products); rule 3.7 (substantiation)",
          "Cosmetic efficacy claims need robust evidence; exaggerated or unproven claims (e.g., 'look 10 years younger') are routinely upheld against."),
  "EU": ("EU Cosmetics Regulation 1223/2009; common criteria for cosmetic claims (Regulation 655/2013)",
          "Cosmetic claims must be truthful, supported by evidence, fair, and not attribute to the product characteristics it does not have; 'free-from' and 'natural' claims are policed."),
  "CA": ("Competition Act s.74.01; s.74.01(1)(a) performance claims require adequate and proper testing",
          "Superiority and efficacy claims need testing done before the claim runs; the ordinary consumer's general impression governs."),
  "AU": ("Australian Consumer Law s.18/s.29 (misleading or deceptive conduct; false representations)",
          "Cosmetic efficacy claims must be substantiated; s.29 prohibits false representations about the standard, quality or benefits of goods."),
 },
 "testimonials": {
  "US": ("FTC Endorsement Guides (16 CFR Part 255, 2023) — material-connection disclosure; atypical-results rule",
          "Endorsers' material connections must be clearly disclosed; ads using atypical results must disclose what consumers can generally expect; advertisers are liable for endorser claims."),
  "UK": ("ASA CAP Code rule 3.47 (testimonials must be genuine); rule 3 (misleading advertising)",
          "Testimonials must be genuine, not edited to mislead, and typical of what consumers can expect; fake or cherry-picked reviews breach the Code."),
  "EU": ("Unfair Commercial Practices Directive, Annex I (blacklisted practices)",
          "Falsely representing oneself as a consumer, or submitting fake reviews, is per se unfair — blacklisted, no need to prove it misled anyone."),
  "CA": ("Competition Act s.74.01; Ad Standards Canada Code (testimonials must reflect genuine experience)",
          "Testimonials must be genuine and reflect the honest opinion of the endorser; misleading use of testimonials is a false/misleading representation."),
  "AU": ("Australian Consumer Law s.29 (false or misleading representations); AANA Code of Ethics",
          "Fake or misleading testimonials breach s.29; endorsements must be genuine and any material connection disclosed."),
 },
 "free": {
  "US": ("FTC Guide Concerning Use of the Word 'Free' (16 CFR Part 251); ROSCA (negative-option rule)",
          "'Free' means no cost or obligation; conditions must be disclosed clearly and conspicuously at the outset; negative-option (auto-renew) offers need express informed consent and simple cancellation."),
  "UK": ("ASA CAP Code rule 8.19 (use of 'free' in promotional marketing)",
          "'Free' must mean genuinely free: consumers must not pay anything beyond unavoidable response costs; conditions that affect the 'free' nature must be prominent."),
  "EU": ("Unfair Commercial Practices Directive, Annex I (blacklisted practices)",
          "Describing a product as 'gratis'/'free' when the consumer must pay anything beyond unavoidable costs is blacklisted — automatically unfair."),
  "CA": ("Competition Act s.74.01 (false or misleading representations)",
          "'Free' offers with hidden costs or obligations mislead by general impression; the overall message, not the fine print, governs."),
  "AU": ("Australian Consumer Law s.29 (false or misleading representations about price)",
          "'Free' with strings attached misrepresents the price; s.29(1)(i) prohibits false representations about the existence or effect of any condition on price."),
 },
 "urgency": {
  "US": ("FTC Act Section 5 (deceptive acts or practices); FTC deceptive-pricing guidance",
          "Fake scarcity and countdown timers that reset are deceptive: they misrepresent the opportunity and pressure decisions; 'sale' prices need a genuine regular-price basis."),
  "UK": ("ASA CAP Code Section 8 (promotional marketing); rule 3 (misleading advertising)",
          "Promotions must not mislead about availability or deadlines; fake countdowns and perpetual 'ending tonight' sales breach the Code."),
  "EU": ("Unfair Commercial Practices Directive, Annex I (blacklisted practices)",
          "Falsely stating a product will only be available for a very limited time, or that it will only be available on particular terms for a very limited time, is blacklisted."),
  "CA": ("Competition Act s.74.01 (false or misleading representations)",
          "False urgency misrepresents the offer's availability; judged by the general impression on the ordinary consumer."),
  "AU": ("Australian Consumer Law s.18/s.29; s.35 (bait advertising)",
          "False scarcity and fake urgency mislead about supply; s.35 targets advertising goods without reasonable grounds to supply at that price/availability."),
 },
 "green": {
  "US": ("FTC Green Guides (16 CFR Part 260)",
          "Environmental claims need competent, reliable substantiation; vague claims ('eco-friendly') are deceptive; 'recyclable' requires that most consumers can actually recycle it; carbon claims need offsets that are real and additional."),
  "UK": ("ASA CAP Code Section 11 (environmental claims)",
          "Absolute green claims ('100% recyclable', 'carbon neutral') need full life-cycle evidence; claims must be clear about what part of the product/lifecycle they cover."),
  "EU": ("Unfair Commercial Practices Directive; Empowering Consumers Directive (EU) 2024/825",
          "Generic environmental claims ('eco-friendly', 'green') without recognized excellent environmental performance are banned; carbon-neutrality claims based on offsetting face strict substantiation duties."),
  "CA": ("Competition Act s.74.01; Competition Bureau environmental-claims enforcement guidance",
          "Green claims need adequate and proper testing; vague or unsubstantiated environmental benefit claims are a Bureau enforcement priority."),
  "AU": ("Australian Consumer Law s.18/s.29; ACCC environmental and sustainability claims guidance",
          "Green claims must be honest, specific and substantiated; vague claims and selective life-cycle emphasis mislead under s.18."),
 },
 "price": {
  "US": ("FTC Guides Against Deceptive Pricing (16 CFR Part 233); FTC Act Section 5",
          "'Was/now' and 'compare at' prices must reflect genuine former or competitor prices; drip pricing that hides mandatory fees until checkout is deceptive."),
  "UK": ("ASA CAP Code Section 3 (misleading advertising); pricing rules (reference prices must be genuine)",
          "Reference prices must be genuine recent selling prices; 'was' prices need a meaningful period at the higher price; savings claims must be real."),
  "EU": ("Unfair Commercial Practices Directive; EU Price Indication Directive 98/6/EC",
          "Price reductions must be measured against the lowest prior price in the preceding 30 days; misleading price comparisons are prohibited."),
  "CA": ("Competition Act s.74.01(2)-(3) (ordinary selling price)",
          "A 'sale' price is only genuine against the ordinary selling price — either the price at which the supplier sold a substantial volume, or competitors' prevailing price; fictitious 'was' prices breach the Act."),
  "AU": ("Australian Consumer Law s.48 (component pricing); s.29 (false representations about price)",
          "Advertised prices must show the single total price including unavoidable charges; drip pricing that reveals fees late breaches s.48 and s.29."),
 },
 "superiority": {
  "US": ("FTC substantiation doctrine; FTC comparative-advertising policy statement",
          "Superiority claims ('#1', 'better than X') need a reasonable basis before publication; comparative claims must compare like attributes and be truthful; puffery is narrow — measurable claims are not puffery."),
  "UK": ("ASA CAP Code rule 3.7 (substantiation); Section 3 (comparative advertising rules)",
          "Superiority claims need evidence; comparative ads must compare products meeting the same need, objectively, on verifiable features; 'No. 1' claims need robust substantiation."),
  "EU": ("Unfair Commercial Practices Directive; Directive 2006/114/EC (misleading and comparative advertising)",
          "Comparative advertising is permitted only if objective, verifiable, and not misleading; denigrating or confusing comparisons are prohibited."),
  "CA": ("Competition Act s.74.01(1)(a) (performance claims require adequate and proper testing)",
          "'#1' and 'best' claims are performance claims requiring testing before publication; unsubstantiated superiority misleads by general impression."),
  "AU": ("Australian Consumer Law s.29 (false or misleading representations)",
          "Superiority claims must be true and substantiated; s.29(1)(a)-(b) prohibit false representations about standard, quality, value or grade."),
 },
 "native": {
  "US": ("FTC Endorsement Guides (16 CFR Part 255); FTC .com Disclosures (2023 update)",
          "Ad disclosures must be clear and conspicuous — unavoidable, plain language, at the beginning; burying #ad in hashtags or below the fold fails the test."),
  "UK": ("ASA CAP Code rule 2.1 (recognition of marketing communications)",
          "Marketing communications must be obviously identifiable as such; advertorials need prominent labeling (e.g., 'Ad', 'Advertisement feature') from the outset."),
  "EU": ("Unfair Commercial Practices Directive, Annex I (blacklisted practices)",
          "Using editorial content paid for by a trader without making the commercial relationship clear is blacklisted — automatically an unfair practice."),
  "CA": ("Competition Act s.74.01; Ad Standards Canada influencer-marketing disclosure guidelines",
          "Undisclosed paid endorsements mislead about the independence of the recommendation; disclosure must be clear, upfront, and in the same medium."),
  "AU": ("Australian Consumer Law s.18; AANA influencer disclosure guidance",
          "Undisclosed commercial relationships in endorsements are misleading under s.18; disclosure must be prominent and unambiguous."),
 },
 "platform": {
  "US": ("Platform policy: Meta Advertising Standards (personal attributes; misleading claims); FTC Act Section 5 baseline",
          "Meta prohibits ads that assert or imply personal attributes (health conditions, age, race); health claims in ads still need FTC-level substantiation."),
  "UK": ("Platform policy: Meta/TikTok advertising policies; ASA CAP Code applies to paid ads online",
          "Platform policies layer on top of ASA rules: no implied personal attributes, no before/after body imagery in many health/beauty categories."),
  "EU": ("Platform policy plus UCPD; Digital Services Act transparency duties for ads",
          "Platforms enforce their own ad policies and must label ads under the DSA; underlying claims still face UCPD enforcement."),
  "CA": ("Platform policy plus Competition Act s.74.01",
          "Platform ad policies add a second gate: policy-violating ads get disapproved regardless of Competition Act compliance."),
  "AU": ("Platform policy plus Australian Consumer Law s.18",
          "Platform policies restrict health/personal-attribute targeting claims; ACL s.18 still applies to the underlying representations."),
 },
}

JURIS = {
 "US": "FTC deception standard: a representation likely to mislead a reasonable consumer that is material to the decision. Substantiation must be in hand before the claim runs; intent is not required.",
 "UK": "ASA enforces the CAP Code on the likely consumer understanding; substantiation must be held before publication and be adequate to the claim; upheld rulings are published and must be complied with.",
 "EU": "The UCPD is full-harmonization law: Annex I blacklisted practices are unfair per se, no need to prove they actually misled anyone; member states enforce via national authorities.",
 "CA": "The Competition Act judges the general impression conveyed to the ordinary (credulous, inexperienced) consumer; performance claims need adequate and proper testing done beforehand.",
 "AU": "ACL s.18: conduct 'likely to mislead or deceive' breaches regardless of intent or actual deception; silence and overall impression can mislead.",
}

LICENSE = {"1s-": "TIER-1S-SYNTH"}

def license_class(chunk_ids):
    return "TIER-1S-SYNTH" if any(c.startswith("1s-") for c in chunk_ids) else "TIER-2-OPEN"

# ---------------- archetype table ----------------
# fields: slug, cat, claim, objective, audience, constraints, net, analysis,
#         rewrite, whypass, selling, corpus (2 ids), fine
A = []
def arch(slug, cat, claim, objective, audience, constraints, net, analysis,
         rewrite, whypass, selling, corpus, fine=False):
    A.append(dict(slug=slug, cat=cat, claim=claim, objective=objective,
                  audience=audience, constraints=constraints, net=net,
                  analysis=analysis, rewrite=rewrite, whypass=whypass,
                  selling=selling, corpus=corpus, fine=fine))

# ============ HEALTH ============
arch("health-weight-loss-pill", "health",
 "Lose 20 lbs in 30 days — guaranteed! No diet, no exercise needed.",
 "Sell a diet supplement via landing page",
 "Problem-aware adults seeking fast weight loss",
 "Keep the page compliant for paid search approval",
 "Net impression: this pill causes rapid, effortless weight loss for the buyer.",
 "A specific efficacy figure (20 lbs / 30 days) plus 'guaranteed' is a disease-adjacent weight-loss claim. No competent, reliable scientific evidence is cited, and 'guaranteed' promises an outcome no supplement can assure. The net impression is that the pill does the work.",
 "In a 12-week randomized trial, participants taking [ingredient] lost an average of 4.2 lbs alongside diet and exercise. Results vary — see the study summary.",
 "Cites a real study, states the actual average, adds the diet-and-exercise context the original hid, and 'results vary' blocks the atypicality inference.",
 "Specific numbers still sell — but now they are true numbers with a mechanism, which converts skeptics better than fantasy.",
 ["my-life-in-advertising#259", "google-search-central#70"])

arch("health-diabetes-cure", "health",
 "Our formula reverses Type 2 diabetes naturally — throw away your medication.",
 "Direct-response supplement ad",
 "Adults managing blood sugar",
 "Must survive platform and regulator review",
 "Net impression: the product treats/cures a disease and replaces prescribed medication.",
 "A disease-treatment claim ('reverses Type 2 diabetes') requires drug-level evidence; a supplement cannot carry it. Advising users to discard medication adds a safety dimension regulators treat as aggravated.",
 "Formulated with berberine, studied for blood-sugar support. Talk to your doctor before changing any medication.",
 "Removes the disease claim entirely, keeps a support claim tied to an ingredient, and adds the medical disclaimer.",
 "Safety-forward copy builds trust with the exact audience that researches ingredients; fear-based disease claims attract refunds and enforcement.",
 ["my-life-in-advertising#259", "calkins-business-of-advertising#20"])

arch("health-anxiety-app", "health",
 "Clinically proven to reduce anxiety in 7 days.",
 "App-store listing + paid social for a wellness app",
 "Adults with anxiety symptoms",
 "App-store and ad-platform approval required",
 "Net impression: a clinical trial proves the app reduces anxiety within a week.",
 "'Clinically proven' is among the strongest substantiation triggers; it demands actual clinical testing of the product. Without it, the claim is fabricated proof.",
 "In a 4-week pilot with 214 users, 63% reported lower anxiety scores. Early research — download the summary in-app.",
 "Replaces the invented 'clinically proven' with the real study that exists, qualified as a pilot.",
 "Honest data with a transparency link outperforms 'clinically proven' with anxious buyers, who are highly sensitive to being misled.",
 ["my-life-in-advertising#259", "1s-copyhackers-blog#2"])

arch("health-immune-gummies", "health",
 "Boosts your immune system 10x.",
 "Grocery-aisle packaging + social ads for vitamin gummies",
 "Parents buying for families",
 "Packaging has limited space; keep claims short",
 "Net impression: a tenfold increase in immune function from a gummy.",
 "'10x' is a quantified efficacy claim requiring quantification-grade evidence. Immune-function claims are policed as implied disease-prevention claims.",
 "With vitamins C, D and zinc to support normal immune function.",
 "Support claim matched to established nutrient functions; the invented multiplier is gone.",
 "Short, true, and still benefit-led — 'support normal immune function' is the compliant way to say what the original was trying to say.",
 ["scientific-advertising#45", "my-life-in-advertising#259"])

arch("health-before-after", "health",
 "Before/after photos: 'I lost 38 lbs in 2 months!' splashed across the ad creative",
 "Paid social creative for a weight-loss program",
 "Cold audiences on social",
 "Platform ad policies apply on top of the law",
 "Net impression: this is what happens when you use the program — dramatic transformation is the expected outcome.",
 "Before/after imagery is an implied efficacy claim, and a dramatic result without typicality disclosure teaches the consumer that extreme outcomes are normal. Advertisers are responsible for the net impression of the creative, not just the caption.",
 "Real member story: 'I lost 38 lbs in 8 months with coaching and meal plans.' Typical members lose 1-2 lbs/week. Individual results vary.",
 "Keeps the real story, adds timeframe honesty and the typical-result disclosure the original lacked.",
 "Typical-result disclosures do not kill the story — the transformation is still dramatic, and the honesty raises believability.",
 ["my-life-in-advertising#124", "1s-copyhackers-blog#4"])

arch("health-dentist-toothpaste", "health",
 "9 out of 10 dentists recommend BrightSmile.",
 "TV + packaging claim for toothpaste",
 "Mass-market shoppers",
 "Claim must work on pack and in broadcast",
 "Net impression: a scientific survey found 90% dentist preference for this brand.",
 "'9 out of 10' implies a survey; if none exists, or the survey asked a different question ('recommend any fluoride toothpaste'), the claim misrepresents the evidence.",
 "In a 2025 survey of 400 dentists, 62% named BrightSmile their most-recommended whitening toothpaste. Full methodology at brightsmile.com/survey.",
 "States the real figure, the real question asked, and points to methodology.",
 "A real 62% with methodology beats a fabricated 90% — competitors cannot puncture it, and 'most-recommended' still carries the win.",
 ["my-life-in-advertising#259", "1s-copyhackers-blog#2"])

arch("health-wrinkles-cream", "health",
 "Reduces wrinkles by 90% in just 7 days.",
 "Skincare product page + influencer seeding",
 "Women 40+ buying anti-aging skincare",
 "Influencers will repeat the claim — it must survive repetition",
 "Net impression: near-total wrinkle elimination in one week, as a measured fact.",
 "A 90% efficacy figure for a cosmetic is a drug-level claim; 'in just 7 days' adds a timeframe that must also be proven. Influencer repetition extends liability to every repost.",
 "In an 8-week consumer study, 78% of 112 participants said fine lines looked visibly softer. See results.",
 "Converts the invented percentage into a real perception study with sample size and duration.",
 "'Visibly softer' with a real study sells the same hope with evidence — and every influencer can safely repeat it.",
 ["my-life-in-advertising#259", "scientific-advertising#45"])

arch("health-joint-support-fine", "health",
 "Glucosamine + MSM to support joint comfort and flexibility.",
 "Supplement product page",
 "Adults 50+ with active lifestyles",
 "No disease claims; label space limited",
 "Net impression: the product supports joint comfort — a structure/function claim, not a disease claim.",
 "This is the compliant shape: a structure/function claim about supporting normal structure, no disease named, no cure promised, no quantified miracle. With the standard supplement disclaimer it is properly framed.",
 "Glucosamine + MSM to support joint comfort and flexibility.* *These statements have not been evaluated by the FDA. This product is not intended to diagnose, treat, cure, or prevent any disease.",
 "The claim was already compliant; the disclaimer completes the standard framing.",
 "Benefit-led and safe: 'support joint comfort' names the outcome the buyer wants without crossing into disease territory.",
 ["my-life-in-advertising#259", "1s-cxl-blog#4"], fine=True)

# ============ FINANCE ============
arch("finance-crypto-course", "finance",
 "Our students earn $10k/month trading crypto after our 6-week course.",
 "Webinar funnel for a trading course",
 "Aspiring traders, 25-40",
 "Earnings claims draw the most scrutiny — get this right",
 "Net impression: taking the course leads to $10,000/month trading income.",
 "An earnings figure tied to the course implies typical students achieve it. If the median student earns nothing or loses money, the claim teaches a false typical outcome. Course sellers must know their students' real results.",
 "Learn the risk framework our 6-week course teaches: position sizing, stop-losses, and journaling. Trading involves substantial risk of loss — most day traders lose money.",
 "Removes the earnings promise entirely and leads with the method plus the honest risk statement.",
 "Method-led copy attracts serious students and repels refund-seekers; the honest risk line is itself a trust signal that raises webinar show-up quality.",
 ["my-life-in-advertising#259", "calkins-business-of-advertising#20"])

arch("finance-guaranteed-returns", "finance",
 "Guaranteed 20% annual returns. Zero downside.",
 "Landing page for an investment product",
 "Retail investors seeking yield",
 "Financial-promotion rules apply in every market",
 "Net impression: a risk-free 20% return exists and this product delivers it.",
 "'Guaranteed' plus a specific return with 'zero downside' denies the existence of risk — the single most policed pattern in investment advertising. No legitimate investment can promise this.",
 "Target return 8-12% annually, net of fees. All investing involves risk, including loss of principal. Past performance does not guarantee future results.",
 "Replaces the impossible promise with a target range, names the risk, and adds the past-performance disclaimer.",
 "A credible target range with honest risk language converts qualified investors; 'guaranteed 20%' converts only the naive — and regulators.",
 ["scientific-advertising#45", "my-life-in-advertising#259"])

arch("finance-portfolio-doubled", "finance",
 "'They doubled my portfolio in a year!' — testimonial front and center on the homepage",
 "Advisor homepage social proof",
 "High-net-worth prospects",
 "Testimonials in finance face double scrutiny",
 "Net impression: clients typically double their money with this advisor.",
 "A spectacular testimonial without context teaches that doubling is the norm. Endorsement rules require disclosing what typical clients experience; in finance, cherry-picked performance is additionally a performance-advertising violation.",
 "'They built a plan I actually follow — I'm up 34% over three years.' Client since 2021. Individual results vary; investing involves risk.",
 "Keeps a real testimonial, adds tenure context, and discloses variability.",
 "A believable 34% over three years with context persuades sophisticated prospects far better than a miracle they will not believe.",
 ["my-life-in-advertising#124", "1s-copyhackers-blog#4"])

arch("finance-risk-free-forex", "finance",
 "Risk-free forex trading — you literally cannot lose.",
 "Paid search landing page for a forex broker",
 "Beginner traders",
 "Broker ads face platform + regulator review",
 "Net impression: forex trading through this broker carries no risk of loss.",
 "'Cannot lose' is the textbook deceptive risk claim: leverage products can lose more than the deposit. Denying risk entirely is never a close call.",
 "Trade forex with leverage up to 30:1. 74% of retail accounts lose money trading CFDs with this provider.",
 "Deletes the risk denial and states the mandated risk warning with the real loss percentage.",
 "The real warning filters out the audience that would blow up and complain; serious traders respect a broker that states the odds.",
 ["calkins-business-of-advertising#20", "1s-cxl-blog#4"])

arch("finance-credit-card-apr", "finance",
 "0% APR* — *on balance transfers for 6 months; 24.99% thereafter; 3% transfer fee; see 40-page terms",
 "Credit card acquisition email",
 "Balance-transfer shoppers",
 "Rate disclosures are legally prescribed",
 "Net impression: a 0% card — while the true cost (24.99% after, 3% fee) hides in fine print.",
 "The headline rate is technically true but the net impression hides the cost that determines the deal. Rate advertising requires the material terms to travel with the rate, with equal prominence for the conditions.",
 "0% intro APR on balance transfers for 6 months, then 24.99% variable APR. 3% transfer fee applies. See summary box for full terms.",
 "Brings the rate, the revert rate, and the fee into the same breath as the offer.",
 "Full-terms-upfront copy wins the comparison shoppers who actually read — and they are the ones who transfer balances.",
 ["calkins-business-of-advertising#464", "1s-baymard#11"])

arch("finance-free-advice", "finance",
 "FREE retirement review! (A 90-minute annuity sales pitch with a 'free' steak dinner.)",
 "Seminar marketing for an annuity seller",
 "Retirees 60+",
 "Senior audiences get extra protection",
 "Net impression: free, no-strings retirement advice — while the event is a sales presentation for a commissioned product.",
 "'Free' with a sales pitch attached misrepresents the nature of the offer; with seniors, regulators treat seminar selling as a high-risk pattern. The commercial purpose must be disclosed upfront.",
 "Free educational seminar: how annuities work, including fees and surrender charges. Presented by [Firm], which sells annuities and earns commissions.",
 "Discloses the commercial purpose and the compensation in the invitation itself.",
 "Upfront disclosure fills the room with people open to buying annuities — the pitch converts better than a room of people who feel ambushed.",
 ["calkins-business-of-advertising#464", "google-search-central#81"])

arch("finance-gold-gains", "finance",
 "Gold is up 300% — your neighbors are already buying. Don't get left behind.",
 "Direct mail + radio for a gold dealer",
 "Adults 50+ worried about savings",
 "Fear-based senior marketing is high-risk",
 "Net impression: gold rose 300% (as an investment fact) and social proof demands action now.",
 "An unverified 300% figure plus manufactured social pressure ('your neighbors') is a two-layer deception: false performance data wrapped in false consensus. Precious-metals dealers are repeat enforcement targets.",
 "Gold has historically been used as a portfolio diversifier. Request our free guide: historical returns, premiums over spot, and storage costs — the full math before you buy.",
 "Replaces the fabricated figure with a neutral historical framing and offers the full cost math.",
 "'The full math before you buy' is the strongest possible pitch to a skeptical senior audience — it disarms the exact fear the original tried to exploit.",
 ["my-life-in-advertising#259", "scott-psychology-of-advertising#260"])

arch("finance-student-reviews-fine", "finance",
 "4.2 out of 5 from 8,300 verified student reviews.",
 "Course sales page social proof",
 "Prospective students comparing courses",
 "Aggregate ratings must be genuine and current",
 "Net impression: thousands of verified students rate the course 4.2/5 — an aggregate, checkable fact.",
 "This is the compliant shape: a genuine aggregate from verified purchasers, stated as an average (not a cherry-picked extreme), with the base size disclosed so the number is checkable.",
 "4.2 out of 5 from 8,300 verified student reviews (collected 2024-2026). Read all reviews, including the critical ones.",
 "The claim was already compliant; adding the date range and the invitation to read critical reviews completes the honest framing.",
 "Inviting prospects to read critical reviews is a power move — it signals confidence and raises the credibility of the 4.2 itself.",
 ["my-life-in-advertising#124", "1s-copyhackers-blog#4"], fine=True)

# ============ BEAUTY ============
arch("beauty-younger-cream", "beauty",
 "Look 10 years younger overnight with ReviveAge cream.",
 "Skincare launch campaign",
 "Women 45+",
 "Influencers will repeat the claim",
 "Net impression: the cream reverses a decade of visible aging in one night.",
 "'10 years younger overnight' is a quantified, time-bound transformation claim — cosmetic products cannot carry drug-level efficacy promises. The specificity makes it worse, not better.",
 "In a 12-week user trial, 71% of 140 participants said their skin looked smoother and more radiant. Real results, real timeline.",
 "Replaces the fantasy with the actual study outcome, stated as perception with sample size.",
 "'Looked smoother and more radiant' with a real trial is the strongest claim the evidence supports — and it is one no competitor can take away.",
 ["my-life-in-advertising#259", "1s-copyhackers-blog#2"])

arch("beauty-hair-growth", "beauty",
 "Grows hair 3 inches in one week — watch it happen.",
 "TikTok Shop video ad for hair serum",
 "Young women with hair concerns",
 "Video format; before/after rules also apply",
 "Net impression: three inches of new hair growth in seven days from a serum.",
 "Human hair grows about half an inch per month; 3 inches in a week is physiologically impossible, making the claim false on its face. Video 'watch it happen' framing adds fabricated demonstration.",
 "Supports the look of fuller, thicker hair with continued use. Most users in our 8-week trial reported visibly fuller-looking hair.",
 "Removes the impossible growth figure and reframes as appearance support with the real trial result.",
 "'Fuller-looking hair' is the honest version of the desire — and it is a claim the product can actually deliver, which is what keeps refunds down.",
 ["my-life-in-advertising#259", "google-search-central#70"])

arch("beauty-natural-claim", "beauty",
 "100% natural ingredients. (Contains synthetic fragrance and phenoxyethanol.)",
 "Packaging front panel + Amazon listing",
 "Ingredient-conscious shoppers",
 "'Natural' is policed in every market",
 "Net impression: every ingredient comes from nature — contradicted by the ingredient list.",
 "'100% natural' is absolute; a single synthetic ingredient falsifies it. Consumers read ingredient lists, and the contradiction destroys trust on top of breaking the rule.",
 "Made with 96% naturally derived ingredients. Full ingredient list on the back panel.",
 "States the real percentage and points to the full list.",
 "96% with transparency beats 100% with a lie — the ingredient-conscious buyer rewards the brand that shows its work.",
 ["calkins-business-of-advertising#20", "1s-copyhackers-blog#2"])

arch("beauty-derm-approved", "beauty",
 "Dermatologist approved!",
 "Packaging seal + retail shelf talker",
 "Shoppers choosing between similar products",
 "Third-party endorsement claims need the third party",
 "Net impression: dermatologists as a profession have evaluated and approved this product.",
 "'Dermatologist approved' implies professional consensus or testing that does not exist. An endorsement claim without an endorser is fabricated authority.",
 "Formulated with ceramides and niacinamide, ingredients dermatologists commonly recommend for barrier support.",
 "Drops the false endorsement and keeps the true, useful fact about the ingredients.",
 "Naming the actual ingredients and why they matter is more persuasive to the label-reading buyer than a hollow seal.",
 ["my-life-in-advertising#124", "my-life-in-advertising#259"])

arch("beauty-cruelty-free", "beauty",
 "Cruelty-free! (Parent company tests on animals where required by law for market access.)",
 "Brand homepage + social bio",
 "Ethical shoppers",
 "Supply-chain claims include the parent company",
 "Net impression: no animal testing anywhere in this product's story.",
 "'Cruelty-free' covers the brand's full testing footprint as consumers understand it; carve-outs buried in FAQs do not travel with the headline claim. Consumers buy the claim, not the footnote.",
 "We do not test our products on animals. Learn about our supplier standards and where we sell.",
 "Narrows the claim to what is actually true and links the full policy.",
 "A precise, linked claim converts ethical shoppers better than a broad one they will eventually discover is hedged.",
 ["calkins-business-of-advertising#20", "google-search-central#81"])

arch("beauty-softer-hair-fine", "beauty",
 "Leaves hair feeling softer after one wash.",
 "Shampoo product page",
 "Mass-market shampoo buyers",
 "Sensory claims must reflect real user experience",
 "Net impression: hair feels softer after one wash — a sensory, experience-based claim.",
 "This is the compliant shape: a subjective sensory claim about the user's own experience, limited to one wash, with no quantified transformation and no pseudo-science. It is verifiable by use.",
 "Leaves hair feeling softer after one wash. 9 out of 10 testers agreed in a 200-person wash test.",
 "The claim was already compliant; adding the perception-test result strengthens it without overclaiming.",
 "'Feeling softer' is exactly what the buyer wants to hear, and because it is true, every bottle sold reinforces the brand.",
 ["scientific-advertising#45", "1s-copyhackers-blog#2"], fine=True)

# ============ TESTIMONIALS ============
arch("testimonials-influencer-undisclosed", "testimonials",
 "Influencer posts: 'OBSESSED with this serum, my skin has never looked better!!' (Paid $2,000; no disclosure.)",
 "Influencer seeding campaign",
 "The influencer's followers",
 "Brand is liable for influencer posts it pays for",
 "Net impression: an independent, unpaid fan raving about the product.",
 "Payment is a material connection: followers weigh the praise differently if they know it was bought. The brand that pays for the post owns the disclosure duty and the liability.",
 "Paid partnership with [Brand]: I've used the serum for 6 weeks — my skin looks brighter to me. Results vary.",
 "Adds the paid-partnership label up top and keeps the opinion framed as personal experience.",
 "Disclosed partnerships actually perform: audiences reward honesty, and the praise lands harder when it is not secretly bought.",
 ["1s-reddit-for-business#1", "google-search-central#81"])

arch("testimonials-atypical-weight", "testimonials",
 "Homepage hero: 'I lost 40 lbs in 3 months!' — customer testimonial, no other context",
 "Weight-loss program homepage",
 "Cold traffic",
 "Hero placement = the brand's loudest claim",
 "Net impression: 40 lbs in 3 months is what this program delivers.",
 "An extreme testimonial in the hero becomes the product's implied efficacy claim. Without disclosure of typical results, consumers reasonably infer the outlier is the norm.",
 "'I lost 40 lbs in 9 months with the coaching plan.' — Maria, member since 2023. Typical members lose 1-2 lbs per week with consistent participation.",
 "Keeps a real, impressive story but adds the honest timeframe and the typical-result disclosure.",
 "The disclosure protects the story: a believable transformation with context converts better than a miracle nobody trusts.",
 ["my-life-in-advertising#124", "1s-copyhackers-blog#4"])

arch("testimonials-employee-review", "testimonials",
 "Five-star Google review written by the owner's cousin, posing as a customer",
 "Local business review profile",
 "Local searchers",
 "Review fraud is policed by platforms and regulators alike",
 "Net impression: an independent customer loves this business.",
 "A non-customer posing as one is a fabricated endorsement; the undisclosed family connection is a material relationship. Both the poster and the business face exposure.",
 "Ask real customers for honest reviews — including the critical ones — and respond to every review publicly. Never write or commission reviews from non-customers.",
 "The rewrite is a practice, not copy: genuine review generation replaces the fraud.",
 "Real reviews with real responses build a profile that survives scrutiny; fake ones collapse the moment anyone looks closely.",
 ["1s-reddit-for-business#1", "calkins-business-of-advertising#20"])

arch("testimonials-edited", "testimonials",
 "Testimonial used in ad: 'This cream is amazing...' (Original: 'This cream is amazing at first, but it stopped working after a month.')",
 "Skincare ad creative",
 "Paid social audiences",
 "Editing testimonials changes their meaning",
 "Net impression: unqualified enthusiasm for the product.",
 "Trimming the qualification reverses the reviewer's meaning — the ad now says the opposite of what the customer said. Edited testimonials must preserve the original meaning.",
 "'This cream worked well for me for the first month.' — actual customer quote, used in full with her permission.",
 "Uses the honest portion of the real quote without reversing its meaning.",
 "A modest, true quote from a real customer outperforms a doctored rave — because the doctored one is a lie waiting to be screenshot.",
 ["my-life-in-advertising#124", "1s-copyhackers-blog#4"])

arch("testimonials-fake-reviews", "testimonials",
 "Staff writes 30 five-star reviews on Trustpilot under fake names",
 "Reputation management for a SaaS product",
 "Buyers checking reviews pre-purchase",
 "Fake reviews are blacklisted in some markets",
 "Net impression: thirty independent buyers rate the product five stars.",
 "Fabricated reviews are the purest form of testimonial deception: every element (author, experience, rating) is invented. In several markets this is a per-se violation.",
 "Run a post-onboarding email asking every new user to leave an honest review — good or bad. Publish your average rating with the review count and date range.",
 "Replaces fabrication with a genuine review-generation system.",
 "A real 4.3 from 900 users beats a fake 5.0 from 30 — buyers have learned to distrust perfection.",
 ["1s-reddit-for-business#1", "google-search-central#56"])

arch("testimonials-genuine-fine", "testimonials",
 "'Down 18 lbs in 6 months with the meal plans. It wasn't always easy, but the coaching kept me going.' — real member, typical results disclosed alongside",
 "Program sales page social proof",
 "Consideration-stage prospects",
 "Keep the disclosure adjacent to the claim",
 "Net impression: a real member's honest experience, framed as one person's story with typical results disclosed.",
 "This is the compliant shape: genuine quote, real person, used with permission, unedited in meaning, with typical results disclosed right beside it so no atypicality inference forms.",
 "'Down 18 lbs in 6 months with the meal plans. It wasn't always easy, but the coaching kept me going.' — Priya, member since 2024. Typical members lose 1-2 lbs/week.",
 "The testimonial was already compliant; naming the member and dating it completes the credibility.",
 "Specific, human, and honest — this is the testimonial format that survives both regulators and skeptical prospects.",
 ["my-life-in-advertising#124", "1s-copyhackers-blog#4"], fine=True)

# ============ FREE ============
arch("free-trial-autorenew", "free",
 "Start your FREE 14-day trial! (Card required; auto-enrolls at $49/mo; cancellation buried three menus deep.)",
 "SaaS signup flow",
 "Trial signups from paid ads",
 "Trial-to-paid conversion is the business model — keep it honest",
 "Net impression: a free trial with no cost or commitment.",
 "'Free' plus a card requirement plus auto-enrollment plus hard cancellation is the negative-option pattern regulators built rules for: the 'free' framing hides a paid commitment, and the friction asymmetry (one click in, three menus out) proves the design intent.",
 "Free for 14 days — no card required. We'll email you before the trial ends; upgrade only if you choose.",
 "Removes the card, the auto-enrollment, and the cancellation maze; the reminder email replaces the dark pattern.",
 "No-card trials convert fewer tire-kickers and far more real buyers — and the reminder email becomes the highest-converting message in the sequence.",
 ["calkins-business-of-advertising#464", "google-search-central#70"])

arch("free-gift-shipping", "free",
 "FREE gift with every order! (A $1 sticker; shipping raised $6 on 'free gift' orders.)",
 "Ecommerce PDP banner",
 "Deal-seeking shoppers",
 "'Free' gifts funded by inflated shipping are a classic",
 "Net impression: a genuine free bonus for ordering.",
 "The 'gift' is funded by a shipping surcharge that only appears on gift orders — the consumer pays for the 'free' item. The cost did not disappear; it moved.",
 "Free sticker pack with every order — shipping stays exactly the same, $4.95 flat.",
 "Keeps the gift framing but removes the hidden funding mechanism.",
 "A genuinely free gift still delights; the honesty in the shipping line defuses the suspicion deal-shoppers bring to every 'free' banner.",
 ["calkins-business-of-advertising#464", "1s-baymard#11"])

arch("free-consultation-pitch", "free",
 "FREE financial consultation! (A 45-minute hard sell for a $3,000 coaching package.)",
 "Lead-gen ad for a coaching business",
 "Aspiring entrepreneurs",
 "The consultation IS the product being advertised",
 "Net impression: free, no-obligation professional advice.",
 "When the 'consultation' is a sales presentation for a paid package, 'free' misrepresents what is being offered. The commercial purpose must be disclosed before the consumer invests their time.",
 "Free 45-minute strategy session. We'll show you our $3,000 coaching program at the end — no pressure, and you'll leave with a written action plan either way.",
 "Discloses the pitch upfront and promises value regardless of purchase.",
 "Upfront disclosure books fewer but far more qualified calls — close rates rise because nobody arrives feeling ambushed.",
 ["calkins-business-of-advertising#464", "google-search-central#81"])

arch("free-bogo-inflated", "free",
 "BUY ONE GET ONE FREE! (Base price doubled the week before the promotion.)",
 "Retail flyer + in-store signage",
 "Bargain hunters",
 "Reference-price games around BOGO are heavily policed",
 "Net impression: two items for the price of one — a 50% saving.",
 "Doubling the base price before the promotion makes the 'free' item full-price in disguise. The saving is measured against a fictitious reference price.",
 "Buy one, get one 50% off — against our regular $40 price, unchanged since January.",
 "States the real reference price and its history so the saving is checkable.",
 "A real, checkable saving beats a theatrical one — bargain hunters verify, and verification is what builds the store's price reputation.",
 ["calkins-business-of-advertising#464", "scientific-advertising#45"])

arch("free-sample-fine", "free",
 "Free sample — no purchase needed, we cover shipping. One per household.",
 "Sampling campaign for a new snack brand",
 "Trial-stage consumers",
 "One-per-household limits must be stated",
 "Net impression: a genuinely free sample with stated limits.",
 "This is the compliant shape: no purchase, no card, shipping covered, and the only condition (one per household) is stated with equal prominence — exactly the 'conditions equally prominent' standard.",
 "Free sample — no purchase needed, we cover shipping. One per household, while supplies last.",
 "The offer was already compliant; 'while supplies last' completes the availability honesty.",
 "Truly free sampling is a conversion machine precisely because the consumer's guard drops — protect that trust and it compounds.",
 ["calkins-business-of-advertising#464", "1s-cxl-blog#4"], fine=True)

# ============ URGENCY ============
arch("urgency-fake-countdown", "urgency",
 "'Only 3 left in stock!' + a countdown timer that resets on every page reload",
 "Ecommerce PDP for a gadget",
 "Impulse buyers",
 "Inventory widgets must reflect reality",
 "Net impression: scarcity is real and time is running out — decide now.",
 "Both signals are fabricated: the stock count and the deadline. Fake urgency manufactures pressure from nothing, and the reset-on-reload proves the timer was never real. This is deception about the offer's terms.",
 "In stock and ready to ship. Order in the next 6 hours for dispatch today (real courier cutoff).",
 "Replaces fabricated scarcity with the one true deadline — today's dispatch cutoff.",
 "A real cutoff ('order in 6 hours for dispatch today') creates genuine urgency that survives scrutiny and still moves impulse buyers.",
 ["1s-cxl-blog#4", "google-search-central#70"])

arch("urgency-sale-ends", "urgency",
 "'SALE ENDS TONIGHT!' — the same sale has run continuously for 8 months",
 "Fashion ecommerce homepage",
 "Sale shoppers",
 "Perpetual sales are a known enforcement pattern",
 "Net impression: buy tonight or lose the discount forever.",
 "A sale that never ends makes 'ends tonight' false every night it runs. The urgency is the product being sold, and it does not exist.",
 "Sale: up to 40% off selected lines, ending Sunday. New lines arrive Monday at full price.",
 "Gives the promotion a real end date and a real reason (new lines).",
 "A genuine end date with a reason converts the same sale shoppers — and the brand can run the next sale without crying wolf.",
 ["1s-cxl-blog#4", "calkins-business-of-advertising#20"])

arch("urgency-fake-viewers", "urgency",
 "'47 people are viewing this right now' (number is hardcoded in the template)",
 "Hotel booking page",
 "Travelers comparing options",
 "Social-proof widgets must be real data",
 "Net impression: high live demand — book before it sells out.",
 "The viewer count is fabricated social proof pressuring the booking decision. A hardcoded number is not a measurement; it is a script.",
 "'High demand for these dates — 3 rooms left at this price.' (Shown only when inventory data confirms it.)",
 "Ties every urgency signal to live inventory data, shown conditionally.",
 "Real scarcity ('3 rooms left at this price') is more persuasive than fake crowds — travelers can sense the difference, and the true signal still hurries them.",
 ["1s-cxl-blog#4", "google-search-central#70"])

arch("urgency-price-timer", "urgency",
 "'Price increases in 09:59!' — the timer restarts for every visitor, forever",
 "Course sales page",
 "Fence-sitters on a $500 course",
 "Evergreen timers are detectable and widely complained about",
 "Net impression: a personal deadline after which the price rises.",
 "The deadline is personal fiction: every visitor gets the same ten minutes, forever. A price threat that will never execute is a false term of the offer.",
 "Enrollment closes Sunday at midnight for the September cohort — 40 seats, then the next cohort in January.",
 "Replaces the fake personal deadline with a real cohort structure and real capacity.",
 "Real cohorts with real seat counts sell courses better than fake timers — the constraint is believable, so the urgency works.",
 ["1s-cxl-blog#4", "calkins-business-of-advertising#20"])

arch("urgency-real-inventory-fine", "urgency",
 "'Sale ends Sunday. 200 units left at this price — when they're gone, the price goes back up.' (True: 200 units, Sunday end.)",
 "Limited product drop",
 "Existing email list",
 "Every element must be verifiable",
 "Net impression: a genuine limited offer with a real deadline and real quantity cap.",
 "This is the compliant shape: the deadline is real, the quantity is real, and the consequence (price returns) is real. Honest urgency is fully permitted — the rule targets fabrication, not pressure.",
 "'Sale ends Sunday. 200 units left at this price — when they're gone, the price goes back up.'",
 "The copy was already compliant; no rewrite needed.",
 "True scarcity is the highest-converting urgency there is, because the buyer's fear of missing out is rational.",
 ["1s-cxl-blog#4", "scientific-advertising#45"], fine=True)

# ============ GREEN ============
arch("green-carbon-neutral", "green",
 "Carbon-neutral shipping on every order! (No offsets purchased; no measurement done.)",
 "Ecommerce checkout badge + homepage",
 "Environmentally conscious shoppers",
 "Carbon claims need carbon accounting",
 "Net impression: the delivery's climate impact has been measured and neutralized.",
 "'Carbon neutral' is a specific, technical claim requiring measurement and real, additional offsets. With neither, it is a fabricated environmental credential aimed at the buyer's values.",
 "We're working toward lower-impact shipping: consolidated dispatches and recycled packaging. Read our 2026 impact notes.",
 "Replaces the false certification with the true, modest program and a transparency link.",
 "Modest, true sustainability copy earns the trust of the exact shoppers who fact-check green claims — the audience the lie was aimed at.",
 ["calkins-business-of-advertising#20", "1s-copyhackers-blog#2"])

arch("green-recyclable", "green",
 "100% recyclable packaging! (Multi-layer pouch not accepted by most municipal programs.)",
 "FMCG packaging",
 "Grocery shoppers",
 "'Recyclable' has a technical meaning regulators enforce",
 "Net impression: the package can go in the recycling bin and be recycled.",
 "'Recyclable' requires that most consumers have access to recycling for that material. A pouch that fails in practice makes the claim false where it matters — at the bin.",
 "Packaging designed for recyclability — check local guidance; find drop-off points at [site]/recycle.",
 "Qualifies the claim and directs the consumer to real disposal information.",
 "Honest recyclability guidance builds the brand's green credibility instead of spending it on a claim the bin disproves.",
 ["calkins-business-of-advertising#20", "google-search-central#68"])

arch("green-eco-friendly", "green",
 "Our new eco-friendly formula!",
 "Cleaning product label",
 "Mainstream shoppers",
 "Vague green claims are the most-banned pattern",
 "Net impression: the formula is good for the environment — in some unspecified way.",
 "'Eco-friendly' is a vague, absolute environmental benefit claim with no defined meaning and no substantiation. Consumers cannot verify it, which is precisely why it is prohibited in its generic form.",
 "Plant-derived cleaning agents; phosphate-free; biodegradable per OECD 301B testing.",
 "Replaces the vague halo with three specific, testable attributes.",
 "Specifics sell better than halos: 'phosphate-free, biodegradable per OECD 301B' gives the green shopper something real to hold onto.",
 ["1s-copyhackers-blog#2", "my-life-in-advertising#259"])

arch("green-plant-plastic", "green",
 "Made from plants — good for the planet!",
 "Beverage bottle label",
 "Young eco-conscious buyers",
 "Feedstock is not the full life cycle",
 "Net impression: the plant-based bottle is environmentally beneficial overall.",
 "The claim spotlights one attribute (plant feedstock) to imply overall environmental benefit, while the full life cycle may tell a different story. Selective emphasis that misleads about total impact is greenwashing.",
 "Bottle made from 30% plant-based plastic. We're publishing our full life-cycle assessment this year.",
 "States the true attribute precisely and commits to the full assessment.",
 "Precision plus a public LCA commitment turns a skeptical eco-buyer into an advocate — the vague version just turns them into a critic.",
 ["calkins-business-of-advertising#20", "1s-copyhackers-blog#2"])

arch("green-recycled-paper-fine", "green",
 "Shipping box made from 70% post-consumer recycled paper, FSC-certified.",
 "Packaging print + sustainability page",
 "B2B buyers with procurement standards",
 "Certifications must be real and current",
 "Net impression: a specific recycled-content claim backed by a named certification.",
 "This is the compliant shape: quantified ('70%'), defined ('post-consumer'), and tied to an independent certification the buyer can verify. Specificity is what separates this from the banned vague claims.",
 "Shipping box made from 70% post-consumer recycled paper, FSC-certified (license code C012345).",
 "The claim was already compliant; adding the license code completes verifiability.",
 "Certified specifics are procurement catnip — B2B buyers choose the supplier whose claims survive their compliance review.",
 ["my-life-in-advertising#259", "1s-copyhackers-blog#2"], fine=True)

# ============ PRICE ============
arch("price-lowest-prices", "price",
 "Lowest prices in America — guaranteed!",
 "Furniture retailer homepage",
 "Price-sensitive shoppers",
 "Superlatives need substance",
 "Net impression: no competitor in the country sells cheaper — a verifiable fact.",
 "A nationwide lowest-price guarantee is a measurable superiority claim, not harmless puffery: it can be tested and falsified. Without price monitoring to back it, it is an unsubstantiated promise that also creates a guarantee obligation.",
 "Find it cheaper within 30 days and we'll refund double the difference.",
 "Converts the vague superlative into a concrete, honored price promise with terms.",
 "A real price-match promise with teeth outsells a hollow 'lowest prices' — shoppers believe the guarantee because it costs the retailer something.",
 ["scientific-advertising#45", "my-life-in-advertising#259"])

arch("price-was-now", "price",
 "'Was $200, now $99!' (The item never sold at $200; it launched at $99.)",
 "Electronics product page",
 "Deal hunters",
 "Reference prices must be genuine",
 "Net impression: a 50% discount from the real former price.",
 "The 'was' price is fictitious — the product never sold at $200 — so the 50% saving is invented. The discount is the product being sold, and it does not exist.",
 "'Launch price $99 — our everyday price, no games.'",
 "Abandons the fake reference price for an honest everyday-price positioning.",
 "'No games' pricing is itself a differentiator with deal-fatigued shoppers — and it can never be disproven.",
 ["scientific-advertising#45", "calkins-business-of-advertising#20"])

arch("price-drip-pricing", "price",
 "'$49/night' — at checkout: $49 + $25 resort fee + $18 taxes = $92",
 "Hotel booking ad",
 "Travelers comparing nightly rates",
 "Mandatory fees must be in the headline price",
 "Net impression: the night costs $49.",
 "Mandatory, unavoidable fees revealed only at checkout make the headline price false. The consumer cannot obtain the advertised price — that is drip pricing, and the total is the only truthful headline.",
 "$92/night total, including all taxes and fees. No surprises at checkout.",
 "Leads with the all-in total the guest will actually pay.",
 "All-in pricing wins the comparison: when every competitor drips and you don't, your $92 beats their '$49' on trust — and on the final receipt.",
 ["1s-baymard#11", "1s-baymard#8"])

arch("price-compare-at", "price",
 "'Compare at $150' (No competitor sells it at $150; the figure is invented.)",
 "Outlet store price tag",
 "Outlet shoppers",
 "'Compare at' needs a real comparison",
 "Net impression: competitors charge $150; this outlet price is a genuine bargain against the market.",
 "A 'compare at' price must reflect a real prevailing market price. An invented comparator manufactures a saving from nothing — the oldest pricing deception in retail.",
 "'Our price $79. MSRP $120.'",
 "Replaces the invented comparator with the verifiable MSRP.",
 "Real comparators still show a saving — and outlet shoppers, the most price-literate buyers alive, reward the tag they can verify.",
 ["scientific-advertising#45", "my-life-in-advertising#259"])

arch("price-match-promise-fine", "price",
 "'Find it cheaper within 30 days and we'll refund double the difference.' (Promise honored; terms published.)",
 "Retailer price policy page",
 "Comparison shoppers",
 "Promises must be honored as written",
 "Net impression: a concrete, honored price guarantee with clear terms.",
 "This is the compliant shape: a specific promise (double the difference), a defined window (30 days), published terms, and — critically — actually honored. A guarantee is only as compliant as its fulfillment.",
 "'Find it cheaper within 30 days and we'll refund double the difference. Full terms here; claims paid within 5 business days.'",
 "The promise was already compliant; adding the payout timeline completes the credibility.",
 "A guarantee with a payout timeline is a conversion weapon — the specificity is what makes shoppers believe it.",
 ["scientific-advertising#45", "1s-baymard#8"], fine=True)

# ============ SUPERIORITY ============
arch("superiority-number-one-vpn", "superiority",
 "#1 rated VPN! (Based on the company's own survey of 40 users.)",
 "VPN affiliate landing page",
 "Privacy-conscious buyers",
 "Rankings need methodology",
 "Net impression: independent testing crowned this VPN the best.",
 "'#1 rated' implies broad, credible evaluation; a 40-person self-survey is neither. The claim borrows the authority of independent testing without doing any.",
 "Rated 4.6/5 by 18,000+ verified users on [independent review platform], 2026.",
 "Replaces the hollow crown with a real aggregate from an independent source.",
 "A real 4.6 from 18,000 verified users is a stronger sales asset than a fake #1 — affiliates can quote it without fear.",
 ["scientific-advertising#45", "1s-copyhackers-blog#2"])

arch("superiority-better-than-x", "superiority",
 "Twice as fast as BrandX! (No testing performed; 'fast' undefined.)",
 "SaaS comparison page",
 "Buyers evaluating two tools",
 "Comparative claims need like-for-like testing",
 "Net impression: independent measurement shows 2x speed over the named rival.",
 "A quantified comparative claim against a named competitor requires actual comparative testing on a defined metric. 'Fast' undefined plus no testing equals a fabricated comparison — and naming BrandX invites their lawyers too.",
 "In our March 2026 benchmark (methodology published), median report load was 1.8s vs 3.4s for BrandX on identical datasets.",
 "Supplies the defined metric, the real test, and the published methodology.",
 "A real benchmark with methodology is the most persuasive asset on a comparison page — and the only one that survives the competitor's response.",
 ["my-life-in-advertising#259", "1s-copyhackers-blog#2"])

arch("superiority-doctors-choice", "superiority",
 "Doctors' #1 choice for back pain relief!",
 "OTC pain-relief packaging",
 "Pharmacy shoppers",
 "Professional endorsements need professionals",
 "Net impression: surveyed doctors chose this product above all others.",
 "'Doctors' #1 choice' asserts a professional consensus that must be measured to be claimed. Without a survey, it is fabricated authority in a white coat.",
 "The back-pain formula pharmacists recommend most in our 2025 survey of 500 pharmacies. See results.",
 "Narrows the claim to the group actually surveyed and points to the data.",
 "A real survey of a real group still carries the white-coat authority — without the fabrication.",
 ["my-life-in-advertising#124", "my-life-in-advertising#259"])

arch("superiority-verified-rating-fine", "superiority",
 "4.8/5 from 12,000+ verified buyers on [platform], 2026.",
 "Marketplace product listing",
 "Shoppers comparing options",
 "Aggregates must be current and unfiltered",
 "Net impression: a large base of verified buyers rates the product 4.8/5.",
 "This is the compliant shape: a genuine aggregate, verified purchasers, disclosed base size and date, from an identifiable source. Superiority implied by the number is earned, not asserted.",
 "4.8/5 from 12,000+ verified buyers on [platform], 2026. Updated monthly.",
 "The claim was already compliant; the update cadence completes the freshness.",
 "A live, updating 4.8 is the highest-converting social proof in ecommerce — because it is real.",
 ["my-life-in-advertising#124", "1s-copyhackers-blog#4"], fine=True)

# ============ NATIVE / SPONSORED ============
arch("native-ad-buried", "native",
 "Influencer post ends with '#ad' buried as the 19th hashtag below the fold",
 "Sponsored Instagram post",
 "Followers scrolling the feed",
 "Disclosure must be unavoidable",
 "Net impression: an organic recommendation — the disclosure is functionally invisible.",
 "A disclosure nobody sees is not a disclosure. Buried in hashtags below the fold, '#ad' fails the clear-and-conspicuous test: it is avoidable, not plain at first glance, and separated from the claim.",
 "Paid partnership with [Brand] — first line of the caption, plus the platform's paid-partnership label.",
 "Moves the disclosure to the unavoidable first line with the platform tool.",
 "Upfront disclosure does not kill sponsored content performance — audiences engage with honest recommendations; they punish discovered ones.",
 ["google-search-central#81", "1s-reddit-for-business#1"])

arch("native-advertorial", "native",
 "Sponsored article styled identically to the news site, with 'sponsored' in 8px grey footer text",
 "Content marketing on a publisher site",
 "News readers",
 "Advertorials must be identifiable as ads",
 "Net impression: independent editorial coverage of the product.",
 "When paid content is indistinguishable from editorial, readers extend editorial trust to advertising. The tiny footer label does not cure the overall disguise — the format is the deception.",
 "'Advertisement feature' — prominent label at the top, distinct background shading, byline naming the brand.",
 "Makes the commercial nature unmistakable from the first glance.",
 "Clearly labeled brand content still gets read when it is genuinely useful — and it borrows trust instead of stealing it.",
 ["google-search-central#81", "calkins-business-of-advertising#464"])

arch("native-affiliate", "native",
 "'Best picks' article with affiliate links; no disclosure that rankings earn commission",
 "Affiliate review site",
 "Buyers researching purchases",
 "Commission relationships are material connections",
 "Net impression: independent expert rankings of the best products.",
 "Undisclosed commissions mean the 'rankings' may reward the highest payout, not the best product. The financial interest is precisely what readers would want to know before trusting the list.",
 "'We earn a commission on purchases — it doesn't affect our rankings. Here's our testing methodology.' Placed above the first product.",
 "Discloses the commission and asserts the independence safeguard, with methodology.",
 "Affiliate sites that disclose prominently outperform sneaky ones long-term — trust is the only moat an affiliate site has.",
 ["google-search-central#81", "1s-reddit-for-business#1"])

arch("native-paid-partnership-fine", "native",
 "'Paid partnership with [Brand]' shown at the top of the video + in the first caption line",
 "Sponsored YouTube video",
 "Subscribers",
 "Disclosure at the start, in the same medium",
 "Net impression: a clearly labeled paid collaboration — the viewer knows before watching.",
 "This is the compliant shape: disclosure at the beginning, in both the platform tool and the creator's own words, unavoidable before the endorsement begins.",
 "'Paid partnership with [Brand]' — top of video, first caption line, and verbal mention in the first 30 seconds.",
 "The disclosure was already compliant; the verbal mention completes the coverage for audio-only viewers.",
 "Triple disclosure costs nothing in performance and buys total safety — the gold standard for sponsored content.",
 ["google-search-central#81", "1s-reddit-for-business#1"], fine=True)

# ============ PLATFORM POLICY ============
arch("platform-personal-attributes", "platform",
 "Meta ad: 'Suffering from diabetes? This changes everything.'",
 "Meta lead ad for a supplement",
 "Adults 40+",
 "Platform policy gates the ad before the law even matters",
 "Net impression (to the platform): the ad asserts the viewer has a health condition.",
 "Asserting or implying personal attributes — including health conditions — violates platform ad policy regardless of the underlying claim's legality. The ad gets disapproved before any regulator sees it; the compliant rewrite must also clear the platform gate.",
 "'Blood-sugar support, backed by a published pilot study. Learn how it works.'",
 "Removes the personal-attribute assertion and leads with the ingredient story.",
 "Attribute-free copy reaches the same audience through interest targeting — without the disapproval and account risk.",
 ["google-search-central#70", "1s-copyhackers-blog#4"])

arch("platform-before-after-tiktok", "platform",
 "TikTok ad: split-screen before/after body transformation, 'I did THIS for 30 days'",
 "TikTok paid ad for a fitness program",
 "Cold audiences",
 "Before/after body imagery is restricted on major platforms",
 "Net impression: the program produces dramatic body transformation in 30 days.",
 "Before/after body imagery implying personal transformation trips both platform policy (implied personal attributes, unrealistic body image) and the underlying efficacy-substantiation rules. The creative is the claim.",
 "'30 days of coached training: what consistent programming looks like.' Show the training, the plan, and a real member's measured progress with typical results disclosed.",
 "Replaces the transformation imagery with the process and honestly-framed progress.",
 "Process-focused creative ('what consistent programming looks like') sells fitness better than transformation shots — it shows the buyer what they will actually do.",
 ["google-search-central#70", "my-life-in-advertising#124"])

arch("platform-unrealistic-body", "platform",
 "Ad: 'Get a six-pack in 14 days — no gym needed!'",
 "Social ad for an ab device",
 "Young men",
 "Body-image + efficacy double violation",
 "Net impression: a six-pack in two weeks from a device, no effort required.",
 "A physiologically implausible transformation in an impossible timeframe, targeting body image — it fails platform body-image policies and efficacy substantiation simultaneously. Two gates, both closed.",
 "'Build visible core strength with 15-minute daily sessions. Realistic timelines, real programming.'",
 "Replaces the fantasy outcome with the real commitment and an honest framing.",
 "Honest effort-framing attracts buyers who will actually use the device — which is what creates the testimonials that sell the next thousand units.",
 ["my-life-in-advertising#259", "1s-cxl-blog#4"])

arch("platform-sensitive-attributes", "platform",
 "Ad: 'Are you over 50 and worried about retirement?' with age-targeted creative",
 "Meta ad for retirement planning",
 "Adults 50+",
 "Age implication in ad copy is a personal-attribute violation",
 "Net impression (to the platform): the ad asserts the viewer's age.",
 "'Are you over 50' asserts a personal attribute directly in the copy — a clear platform-policy violation even though the underlying service is legitimate. The targeting already reaches the audience; the copy must not say the quiet part out loud.",
 "'Retirement planning for the decade that matters most. Fiduciary advisors, transparent fees.'",
 "Reaches the same life stage without asserting anyone's age.",
 "Life-stage copy without the age assertion performs identically — the targeting does the work the copy was trying to do illegally.",
 ["google-search-central#70", "1s-copyhackers-blog#2"])

# ---------------- generation ----------------
THIN_NOTE = ("Corpus coverage note: the pilot corpus contains no dedicated FTC/ASA-doctrine source; "
             "the rule labels below are standard compliance knowledge, grounded to the closest corpus chunks cited. "
             "This is a known thin spot (see data card).")

def build_record(seq, a, market):
    labels, requires = RULES[a["cat"]][market]
    lic = license_class(a["corpus"])
    chunk_lines = "\n".join(f"- {c}: {CHUNK_NOTES[c]}" for c in a["corpus"])
    if a["fine"]:
        analysis_head = "Why the claim is compliant as written:"
        verdict_block = (f"VERDICT: COMPLIANT AS WRITTEN.\n{a['analysis']}\n\n"
                         f"STRENGTHENING (optional, no rewrite needed): {a['rewrite']}")
        why_block = f"Why it passes: {a['whypass']}"
    else:
        analysis_head = "Why the original fails:"
        verdict_block = f"REWRITE: {a['rewrite']}"
        why_block = f"Why the rewrite passes: {a['whypass']}"
    reasoning = (
        f"Claim under review ({market}): \"{a['claim']}\"\n"
        f"{a['net']}\n\n"
        f"{analysis_head} {a['analysis']}\n\n"
        f"Rule analysis [{market}]: {labels}. What the rule requires: {requires}\n\n"
        f"Corpus grounding (chunks actually read):\n{chunk_lines}\n{THIN_NOTE}\n\n"
        f"Jurisdiction note: {JURIS[market]}\n\n"
        f"Selling-power check: {a['selling']}"
    )
    output = (
        f"RULE LABELS ({market}): {labels}\n\n"
        f"{verdict_block}\n\n"
        f"{why_block}\n\n"
        f"SELLING POWER: {a['selling']}"
    )
    rec = {
        "record_id": f"trace-r09-{seq:06d}",
        "recipe": "R09",
        "license_class": lic,
        "origin": "synthetic",
        "reviewer_type": "agent (Z7) + spot-check",
        "corpus_chunk_ids": a["corpus"],
        "constitution_section": "global hard rules",
        "language": "en",
        "market": market,
        "split": None,  # assigned by family below
        "content_hash": None,
        "duplicate_family": f"r09-{a['cat']}-{market}",
        "brief": {"objective": a["objective"], "audience": a["audience"],
                  "constraints": a["constraints"] + f" | Risky claim: {a['claim']}"},
        "reasoning_trace": reasoning,
        "output": output,
        "validation": {"checks": [], "verifier": "r09-market-tag+rule-labels+rewrite-quality"},
        "created_at": CREATED,
    }
    rec["content_hash"] = "sha256:" + hashlib.sha256(
        (reasoning + "\n" + output).encode()).hexdigest()
    return rec

# ---------------- verifier ----------------
ALLOWED_STATUTES = {"16 CFR Part 255", "16 CFR Part 251", "16 CFR Part 260",
                    "16 CFR Part 233", "15 U.S.C."}
KNOWN_CHUNKS = set(CHUNK_NOTES)

def verify(rec, a):
    checks = []
    ok = True
    def check(name, cond, reason=None):
        nonlocal ok
        checks.append(name)
        if not cond:
            ok = False
            reject_reasons[reason or name] += 1
    check("market tag present", rec["market"] in MARKETS, "missing/invalid market tag")
    check("corpus chunk ids present", len(rec["corpus_chunk_ids"]) > 0, "no chunk ids")
    check("chunk ids known/read", all(c in KNOWN_CHUNKS for c in rec["corpus_chunk_ids"]),
          "chunk id not actually read")
    check("rule labels present", "RULE LABELS" in rec["output"] and RULES[a["cat"]][rec["market"]][0].split(";")[0] in rec["output"],
          "rule label missing from output")
    if a["fine"]:
        check("fine-verdict present", "VERDICT: COMPLIANT AS WRITTEN" in rec["output"], "fine verdict missing")
    else:
        check("rewrite present", "REWRITE:" in rec["output"], "rewrite missing")
    check("brief complete", all(rec["brief"].get(k) for k in ("objective", "audience", "constraints")),
          "brief incomplete")
    stat_hits = re.findall(r"\d+ (?:CFR Part \d+|U\.S\.C\.[^,\n]*)", rec["reasoning_trace"] + rec["output"])
    check("no invented statute citations",
          all(any(al in h or h.startswith(al.split()[0]) and al in h for al in ALLOWED_STATUTES) or h in ALLOWED_STATUTES or any(h.startswith(al) for al in ALLOWED_STATUTES) for h in stat_hits),
          "suspect statute citation")
    rw = rec["output"].split("REWRITE:", 1)[-1].split("\n\n", 1)[0] if "REWRITE:" in rec["output"] else ""
    check("honest labeling (rewrite makes no deceptive promise)",
          a["fine"] or not re.search(r"(?<!not )(?<!does not )(?<!no )guarantee[ds]!?", rw, re.I),
          "rewrite keeps deceptive term")
    check("no invented case names", not re.search(r"v\. |v |Court|litigation|settlement \$\d", rec["output"]),
          "invented case law")
    return ok, checks

# ---------------- run ----------------
reject_reasons = Counter()
records, seen_hashes, dupes = [], set(), 0
seq = 1
for a in A:
    for market in MARKETS:
        rec = build_record(seq, a, market)
        if rec["content_hash"] in seen_hashes:
            dupes += 1
            continue
        ok, checks = verify(rec, a)
        rec["validation"]["checks"] = checks + (["VERIFIED"] if ok else ["REJECTED"])
        if not ok:
            continue  # reject: not written
        seen_hashes.add(rec["content_hash"])
        records.append(rec)
        seq += 1

# split by whole family (~15% held-out, deterministic)
fams = sorted({r["duplicate_family"] for r in records})
heldout = {f for f in fams if (int(hashlib.sha256(f.encode()).hexdigest(), 16) % 100) < 15}
for r in records:
    r["split"] = "held-out" if r["duplicate_family"] in heldout else "train"

with open(OUT, "w") as f:
    for r in records:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")

n_train = sum(1 for r in records if r["split"] == "train")
n_hold = sum(1 for r in records if r["split"] == "held-out")
chunk_use = Counter(c for r in records for c in r["corpus_chunk_ids"])
lic_use = Counter(r["license_class"] for r in records)
fine_n = sum(1 for a in A for _ in MARKETS if a["fine"])

print(f"records written: {len(records)} (train {n_train} / held-out {n_hold})")
print(f"families: {len(fams)} | held-out families: {len(heldout)}: {sorted(heldout)}")
print(f"duplicates skipped: {dupes} | rejected: {sum(reject_reasons.values())} {dict(reject_reasons)}")
print(f"license classes: {dict(lic_use)} | fine-traces: {fine_n}")
print("top chunks:", chunk_use.most_common(8))
print("OUT:", OUT)

# ---------------- data card ----------------
card = f"""# Data Card — R09 compliance-aware copy (pilot)

- **Date pulled / generated:** 2026-09-26
- **Recipe:** R09 — compliance-aware copy
- **Output:** `training/traces/traces-r09-pilot.jsonl`
- **License classes:** {dict(lic_use)}
  - TIER-1S-SYNTH: traces grounded in 1s-* academy synthesis chunks (traces are original synthesis, never verbatim Tier 1 text).
  - TIER-2-OPEN: traces grounded in openly-licensed material — public-domain classics (Hopkins, Calkins, Scott) and google-search-central (Tier 1 CC-BY per corpus manifest; treated as TIER-2-OPEN derivation).
  - No Tier 3, no pirated sources. No frontier-model distillation.

## Recipe description
For each risky marketing claim across regulated/risky categories, the trace records (1) the claim + context in `brief`, (2) rule analysis in `reasoning_trace` identifying the specific rule risk with a real rule label (e.g., FTC substantiation doctrine, FTC Endorsement Guides 16 CFR Part 255, ASA CAP Code Section 12 / rule 3.7, UCPD 2005/29/EC, Competition Act s.74.01, ACL s.18), grounded to corpus chunks actually read, and (3) a compliant rewrite in `output` that preserves selling power. Includes "actually fine" traces (verdict COMPLIANT AS WRITTEN) to avoid over-refusal bias.

## Counts
- **Total traces:** {len(records)} (target ~300)
- **Train:** {n_train} | **Held-out:** {n_hold} (split assigned by whole `duplicate_family`, ~15% families held out)
- **Categories:** health, finance, beauty, testimonials, free, urgency, green, price, superiority, native, platform
- **Markets:** US, UK, EU, CA, AU (every trace tagged; jurisdiction differences noted in reasoning)
- **"Actually fine" traces:** {fine_n}
- **Duplicates skipped (sha256):** {dupes}

## Verifier results
- **Verifier:** r09-market-tag+rule-labels+rewrite-quality
- **Passed:** {len(records)} | **Rejected:** {sum(reject_reasons.values())}
- **Top rejection reasons:** {dict(reject_reasons) if reject_reasons else "none"}

## Chunk usage (chunks actually read; counts = traces citing)
{chr(10).join(f"- `{c}`: {n}" for c, n in chunk_use.most_common())}

## Thin spots (binding — read before scale-up)
1. **No dedicated FTC/ASA doctrine source in the corpus.** There is no FTC Endorsement Guides, Green Guides, .com Disclosures, CAP Code, UCPD, Competition Act, or ACL source in corpus v7. Rule labels in this batch are standard compliance knowledge grounded to the closest adjacent chunks (e.g., `calkins-business-of-advertising#464` for "free" doctrine, `1s-cxl-blog#4` for honest urgency, `1s-reddit-for-business#1` for endorsement authenticity). Every reasoning trace carries an explicit corpus-coverage note saying so. **At scale-up, augment the corpus with openly-licensed compliance sources** (FTC business guidance is US public-domain; ASA/CAP publishes guidance; ACCC and Competition Bureau publish guides) and re-ground or regenerate this batch.
2. **Platform ad-policy depth is thin.** Only adjacent chunks (`google-search-central#70` misleading functionality) support the platform-policy traces; Meta/TikTok policy specifics are stated as standard policy knowledge. Same augmentation need.
3. **Jurisdiction nuance is rule-name level, not case-law level.** No invented case law or statute citations were used (verifier-checked); deeper precedent grounding awaits corpus augmentation.
"""
with open(f"{HOME}/workspace/marketr/training/cards/card-r09-pilot.md", "w") as f:
    f.write(card)
print("card written")
