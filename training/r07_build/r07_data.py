# R07 data: voices + mechanisms (hand-authored). Briefs appended in r07_briefs_*.py.
# Every mechanism cites chunk IDs actually skimmed from the corpus (see digest notes).

VOICES = {
    "clinical-warm": {
        "name": "Clinical warmth",
        "tone": "precise, reassuring, plain-spoken",
        "do": ["use plain medical words", "state what happens step by step", "acknowledge the worry, then answer it"],
        "dont": ["no exclamation marks", "never fear-based copy", "no superlatives about outcomes"],
        "rule": "reassure with specifics, never with hype",
    },
    "engineer-plain": {
        "name": "Engineer plain-talk",
        "tone": "terse, spec-like, numbers-first",
        "do": ["lead with the spec", "short sentences", "name the mechanism"],
        "dont": ["no adjectives doing the selling", "no exclamation marks", "no vague 'powerful' claims"],
        "rule": "the spec is the pitch",
    },
    "neighborly": {
        "name": "Neighborly",
        "tone": "warm, first-person plural, straightforward",
        "do": ["sound like the shop down the street", "say what it costs", "contractions welcome"],
        "dont": ["no corporate speak", "no hype adjectives", "no fake urgency"],
        "rule": "talk like a neighbor, quote like a pro",
    },
    "dry-wry": {
        "name": "Dry wit",
        "tone": "understated, self-aware, lightly funny",
        "do": ["one dry observation per piece", "understatement over exclamation", "admit the category's flaws"],
        "dont": ["never shouty", "no superlatives", "no snark at the customer"],
        "rule": "understatement earns the laugh and the trust",
    },
    "luxury-restraint": {
        "name": "Quiet luxury",
        "tone": "restrained, confident, sensory nouns",
        "do": ["short sentences", "let materials and craft carry it", "confidence through omission"],
        "dont": ["no discount language", "no urgency tactics", "no exclamation marks"],
        "rule": "never chase the customer",
    },
    "coach-direct": {
        "name": "Coach direct",
        "tone": "blunt, second person, action verbs",
        "do": ["tell them what to do", "name the work honestly", "respect their effort"],
        "dont": ["no shame", "no body-shaming", "no miracle timelines"],
        "rule": "blunt about the work, never about the person",
    },
    "legal-precise": {
        "name": "Legal precision",
        "tone": "measured, qualified, careful",
        "do": ["qualify every claim", "name the process", "state what you cannot promise"],
        "dont": ["no guaranteed outcomes", "no superlatives", "no casual tone on serious matters"],
        "rule": "precision is the credibility",
    },
    "teacher-patient": {
        "name": "Patient teacher",
        "tone": "explaining, encouraging, jargon-free",
        "do": ["explain the why", "encourage the beginner", "define any term you must use"],
        "dont": ["no condescension", "no jargon walls", "no pressure"],
        "rule": "the beginner is the audience",
    },
    "founder-earnest": {
        "name": "Founder earnest",
        "tone": "candid, first-person, admits tradeoffs",
        "do": ["say 'we built this because'", "admit what it doesn't do", "write like one human to one human"],
        "dont": ["no growth-hack slang", "no hype adjectives", "no fake scale"],
        "rule": "candor over polish",
    },
    "data-dry": {
        "name": "Data dry",
        "tone": "numbers-forward, properly hedged",
        "do": ["cite the number and the sample", "hedge what you can't prove", "short declarative sentences"],
        "dont": ["no promises from correlations", "no hype adjectives", "no rounded miracles"],
        "rule": "numbers carry it; hedging keeps it honest",
    },
    "craftsman": {
        "name": "Craftsman pride",
        "tone": "proud of the work, concrete about materials and process",
        "do": ["name the materials", "describe the process", "stand behind the work plainly"],
        "dont": ["no marketing fluff", "no superlatives", "no rushing language"],
        "rule": "the work is the advertisement",
    },
    "minimalist": {
        "name": "Minimalist",
        "tone": "very short, noun-heavy, quiet",
        "do": ["few words", "concrete nouns", "let white space work"],
        "dont": ["no exclamation marks", "no adjectives stacks", "no urgency"],
        "rule": "fewer words, each one load-bearing",
    },
    "advocate-firm": {
        "name": "Firm advocate",
        "tone": "moral clarity, urgent but honest",
        "do": ["name what matters", "state the stakes plainly", "invite, don't shame"],
        "dont": ["no guilt manipulation", "no inflated statistics", "no despair"],
        "rule": "honest urgency, never manufactured",
    },
    "parent-reassuring": {
        "name": "Reassuring parent",
        "tone": "gentle, safety-first, evidence-cited",
        "do": ["lead with safety", "cite the evidence simply", "speak to the worry behind the question"],
        "dont": ["no fear appeals", "no hype adjectives", "no guilt"],
        "rule": "safety first, stated simply",
    },
    "old-school": {
        "name": "Old school",
        "tone": "formal-leaning, heritage cues, unhurried",
        "do": ["unhurried sentences", "heritage where it's true", "formal courtesy"],
        "dont": ["no slang", "no hype", "no exclamation marks"],
        "rule": "manners are the marketing",
    },
    "playful-clear": {
        "name": "Playful clarity",
        "tone": "light, concrete, friendly",
        "do": ["concrete images", "friendly second person", "keep it short"],
        "dont": ["no jargon", "no hype adjectives", "no trying too hard"],
        "rule": "light touch, clear meaning",
    },
}

AWARENESS_NEED = {
    "unaware": "a reason to care before a reason to buy",
    "problem-aware": "their pain named in their words before any mechanism is mentioned",
    "solution-aware": "differentiation — why this approach beats the other approaches",
    "product-aware": "proof and the offer — the final nudge, not more education",
    "most-aware": "the offer stated plainly — they are already convinced",
}

# Mechanism taxonomy. expl = hand-written expert explanation (constitution register).
# chunks = corpus chunk IDs actually skimmed. patterns = headline templates.
# subject_patterns = short variants for email subjects / social hooks.
# notes = rotating one-line mechanism notes for variants.
MECHANISMS = {
    "specificity": {
        "expl": "A definite claim is either true or false, so readers grant it full weight; a generality is discounted as sales talk. In the tradition of Hopkins: put a number, a name, or a timeframe on the claim and the claim carries its own proof.",
        "chunks": ["scientific-advertising#43", "scientific-advertising#44", "scientific-advertising#46", "my-life-in-advertising#159"],
        "patterns": [
            "{desire_cap} in {timeframe} — {stat} behind it.",
            "{stat}. {proof_cap}.",
            "It takes {stat2}: {desire}.",
            "{product_cap} with {stat} behind it.",
            "From {pain} to {desire} — in {timeframe}.",
        ],
        "subject_patterns": [
            "{stat}: {desire_short}",
            "{desire_short} in {timeframe}",
            "{stat2} to {desire_short}",
        ],
        "notes": [
            "Names the number, so the claim reads as measured rather than asserted.",
            "Specificity does the convincing; no adjective is asked to carry weight.",
            "A definite figure signals real tests behind it — readers grant it full credit.",
        ],
    },
    "curiosity-gap": {
        "expl": "Curiosity is one of the strongest buying incentives, but the gap must pay off — the headline opens a loop the body closes. In the tradition of Hopkins's puffed-grains work: name the intriguing fact, never a trick; a disappointed reader is a lost customer.",
        "chunks": ["scientific-advertising#34", "my-life-in-advertising#152", "scott-psychology-of-advertising#136"],
        "patterns": [
            "The {mech_short} {product} most {aud_short} haven't heard of.",
            "Why {aud_short} are asking for {mech_short} by name.",
            "What {stat} taught us about {product}.",
            "The {timeframe} {product} — and the {mech_short} behind it.",
            "We stopped doing {product} the old way. Here's what replaced it.",
        ],
        "subject_patterns": [
            "The {mech_short} thing",
            "Why {aud_short} switched",
            "What {stat} changed",
        ],
        "notes": [
            "Opens an information gap the body must close — curiosity with a promised payoff.",
            "Withholds the mechanism just enough to earn the click, never enough to mislead.",
            "The intrigue is in the facts, not in a trick; the payoff is named nearby.",
        ],
    },
    "headline-hails": {
        "expl": "The headline's first job is selection, not persuasion — it hails the right readers and lets the rest pass. In the tradition of Hopkins: 'Hey there, Bill Jones' — address the people you seek, and them only.",
        "chunks": ["scientific-advertising#28", "scientific-advertising#33", "my-life-in-advertising#262"],
        "patterns": [
            "For {aud}: {desire} in {timeframe}.",
            "{aud_cap} — {desire}, {offer}.",
            "Built for {aud_short}: {desire_short} in {timeframe}.",
            "Still dealing with {pain}? {desire_cap} in {timeframe}.",
        ],
        "subject_patterns": [
            "For {aud_short}: {desire_short}",
            "{aud_short_cap}: {desire_short}",
            "A note for {aud_short}",
        ],
        "notes": [
            "Hails the intended reader by name so the right people stop and the rest pass.",
            "Selection before persuasion: the headline qualifies the audience in the first words.",
            "Speaks to one reader's situation instead of broadcasting to everyone.",
        ],
    },
    "benefit-first": {
        "expl": "Hurried readers decide at a glance whether the ad offers them anything; the benefit must be visible before the mechanism. In the tradition of Hopkins: people will not be bored in print — show what's in it for them, then earn the rest of the reading.",
        "chunks": ["scientific-advertising#30", "1s-copyhackers-blog#2"],
        "patterns": [
            "{desire_cap} — without {pain}.",
            "What if {product} meant {desire}?",
            "{desire_cap}. That's the whole pitch.",
            "The {product} for people who want {desire}.",
        ],
        "subject_patterns": [
            "{desire_short}. That's it.",
            "What if {desire_short}?",
            "{desire_short}, finally",
        ],
        "notes": [
            "Leads with the reader's outcome; the mechanism can wait for the second line.",
            "Answers 'what's in it for me' before asking for a single second of attention.",
            "Benefit up front respects the hurried reader — the glance decides everything.",
        ],
    },
    "proof-in-headline": {
        "expl": "Proof placed in the headline borrows the headline's readership for the claim. In the tradition of Hopkins: the first to state actual figures on results wins the weight of every platitude competitors are still running.",
        "chunks": ["my-life-in-advertising#200", "scientific-advertising#46", "1s-copyhackers-blog#2"],
        "patterns": [
            "{proof_cap}. {desire_cap} in {timeframe}.",
            "Don't take our word for it: {proof}.",
            "{offer_cap}. {proof_cap}.",
            "{brand}: {proof}, {desire_short}.",
        ],
        "subject_patterns": [
            "{stat} can't be wrong",
            "Proof: {desire_short}",
            "{brand}, by the numbers",
        ],
        "notes": [
            "Puts the evidence where the most eyes land — the headline itself.",
            "Lets the track record make the claim so the copy doesn't have to.",
            "Proof in the headline pre-answers 'why should I believe you' at the glance.",
        ],
    },
    "mechanism-naming": {
        "expl": "People buy mechanisms they understand; naming the how turns a claim into an explanation. In the tradition of Hopkins's '125 million steam explosions': give the process a name and the product stops being one of countless.",
        "chunks": ["scientific-advertising#34", "1s-copyhackers-blog#2"],
        "patterns": [
            "The {mech_short} method: {desire} in {timeframe}.",
            "How {mech_short} delivers {desire}.",
            "{brand}'s {mech_short} — {desire}, {offer}.",
            "It's called {mech_short}. It means {desire}.",
        ],
        "subject_patterns": [
            "The {mech_short} method",
            "How {mech_short} works",
            "It's called {mech_short}",
        ],
        "notes": [
            "Names the how, turning a claim into an explanation the reader can picture.",
            "A named mechanism gives the product a reason to be different, not just a claim.",
            "The mechanism is the differentiation — stated plainly, it sells itself.",
        ],
    },
    "desire-over-fear": {
        "expl": "Buyers move toward success, beauty, and cheer far more readily than away from disaster. In the tradition of Hopkins's Pepsodent work: picture the attractive outcome, never the affliction.",
        "chunks": ["my-life-in-advertising#214", "scientific-advertising#66"],
        "patterns": [
            "Imagine {desire}.",
            "{desire_cap} — the {timeframe} version.",
            "Picture this: {desire}.",
            "The {product} for people who want {desire}.",
        ],
        "subject_patterns": [
            "Imagine {desire_short}",
            "Picture this: {desire_short}",
            "{desire_short}, the {timeframe} version",
        ],
        "notes": [
            "Aims at the attractive outcome, not the affliction — desire pulls harder than fear.",
            "Pictures the reader's success; the product is the path, not the warning.",
            "Positive aspiration outperforms scare copy for anything the reader chooses freely.",
        ],
    },
    "plain-salesmanship": {
        "expl": "Fine writing takes attention from the subject and reveals the hook; plain, sincere language is believed. In the tradition of Hopkins: write as a good salesman talks — short words, no showing off, the customer's language, not the clever one.",
        "chunks": ["scientific-advertising#12", "my-life-in-advertising#248", "1s-copyhackers-blog#3"],
        "patterns": [
            "We do {product}. {desire_cap} in {timeframe}.",
            "{brand}: {product} for {aud_short}. {offer_cap}.",
            "A straightforward {product}: {desire}, {price}.",
            "No jargon. {desire_cap} in {timeframe}.",
        ],
        "subject_patterns": [
            "{brand}: {desire_short}",
            "A straightforward {product}",
            "{desire_short} in {timeframe}",
        ],
        "notes": [
            "Plain words keep attention on the subject; nothing here performs for applause.",
            "Says what a good salesman would say face to face — no literary detours.",
            "Clarity is the persuasion; the sentence never shows off.",
        ],
    },
    "irresistible-offer": {
        "expl": "An offer the prospect cannot reasonably refuse outperforms any headline cleverness. In the tradition of Hopkins: remove the risk, show supreme confidence, and let the offer carry the sale.",
        "chunks": ["my-life-in-advertising#124", "my-life-in-advertising#189"],
        "patterns": [
            "{offer_cap}. {desire_cap} in {timeframe}.",
            "Try {product} — {offer}.",
            "{desire_cap}, {offer}.",
            "{price}. {offer_cap}.",
        ],
        "subject_patterns": [
            "{offer_cap}",
            "{price}: {desire_short}",
            "Try it: {offer}",
        ],
        "notes": [
            "Leads with the risk reversal — the offer is the argument.",
            "An offer this square disarms skepticism better than any adjective could.",
            "Puts the guarantee where the hesitant reader looks first.",
        ],
    },
    "test-verdict": {
        "expl": "Judgment about headlines errs far more often than it hits; keyed returns decide. In the tradition of Hopkins: compare one headline with another, judge by cost per result, and let the returns — not taste — pick the winner.",
        "chunks": ["scientific-advertising#31", "scientific-advertising#4", "scientific-advertising#82"],
        "patterns": [
            "{desire_cap} in {timeframe} — {stat} behind it.",
            "For {aud}: {desire} in {timeframe}.",
            "{proof_cap}. {desire_cap} in {timeframe}.",
            "The {mech_short} method: {desire} in {timeframe}.",
        ],
        "subject_patterns": [
            "{stat}: {desire_short}",
            "For {aud_short}: {desire_short}",
            "{offer_cap}",
        ],
        "notes": [
            "A test candidate, not a coronation — the keyed result gets the final vote.",
            "States the hypothesis plainly so the test can prove it wrong.",
            "Expert judgment proposes; measured returns dispose.",
        ],
    },
}

# Anti-clickbait rejected variants (status REJECTED, never the winner).
ANTIBAIT_VARIANTS = [
    "You won't BELIEVE what {brand} did to {product}!!",
    "{aud_short} are SHOCKED by this {desire_short} secret",
    "The {mech_short} trick {brand} doesn't want you to know",
    "Last chance: {desire_short} before it's GONE forever",
    "What {brand} is hiding about {product} will stun you",
]
ANTIBAIT_REJECTIONS = [
    "Rejected: curiosity without payoff. It violates the {voice_name} voice rule ('{voice_rule}'), and a misled open trains the reader to distrust the next subject line. In the tradition of the Copyhackers playbook: curiosity or clarity, never clickbait.",
    "Rejected: the body cannot cash this check. In the tradition of Hopkins, a disappointed reader is a lost customer — the short-term open rate is not worth the long-term trust.",
    "Rejected: manufactured urgency around a real offer. The offer is genuine; fake scarcity cheapens it and contradicts the voice card's ban on hype.",
    "Rejected: shame-and-secret framing. The {awareness}-stage reader reads manipulation, not invitation — and the voice card forbids it explicitly.",
]

# Awareness-stage patterns for T4 (lesson: match the Schwartz stage).
STAGE_PATTERNS = {
    "unaware": "You don't have {a_product} {product} problem. You have {pain} — {desire}.",
    "problem-aware": "Still dealing with {pain}? {desire_cap} in {timeframe}.",
    "solution-aware": "{brand} vs. the usual {product}: {mech_short} means {desire}.",
    "product-aware": "{proof_cap}. {offer_cap}.",
    "most-aware": "{offer_cap}. {price}.",
}
STAGE_ORDER = ["unaware", "problem-aware", "solution-aware", "product-aware", "most-aware"]

HEADLINE_THEORY_CHUNKS = [
    "scientific-advertising#29", "scientific-advertising#31", "scientific-advertising#50",
    "my-life-in-advertising#263", "scientific-advertising#33",
]
EMAIL_THEORY_CHUNKS = ["1s-copyhackers-blog#4", "1s-copyhackers-blog#1", "scientific-advertising#110"]
AWARENESS_THEORY_CHUNKS = ["1s-copyhackers-blog#3", "scientific-advertising#66", "my-life-in-advertising#214"]

# Batch 1: local services (18) + DTC start (7)
BRIEFS = [
dict(fam="r07-northbeam-dental-crown", brand="Northbeam Dental", industry="local dental", product="same-day crown service", aud="busy professionals, 30-55, who have put off dental work", aud_short="busy professionals", awareness="problem-aware", voice="clinical-warm", desire="a permanent crown with no temporary and no second appointment", desire_short="a permanent crown in one visit", pain="two appointments, time off work, temporary crowns that fall out", mechanism="chairside CAD/CAM milling — the crown is designed and milled while you wait", mech_short="chairside milling", proof="4,200 single-visit crowns placed since 2021", stat="4,200 crowns placed", stat2="47 minutes", timeframe="one visit", offer="free 3D scan and fixed quote before you commit", price="$1,295 all-in"),
dict(fam="r07-blueridge-hvac-tuneup", brand="Blue Ridge Heating & Air", industry="HVAC", product="AC tune-up and repair", aud="homeowners with aging systems dreading summer breakdowns", aud_short="homeowners", awareness="problem-aware", voice="neighborly", desire="an AC that holds through August without a breakdown", desire_short="an AC that survives August", pain="mid-July breakdowns, $400 emergency fees, waiting days in the heat", mechanism="21-point tune-up that catches failing capacitors and low refrigerant before they quit", mech_short="21-point tune-up", proof="9,600 tune-ups completed, 4.9 stars from 2,100 reviews", stat="9,600 tune-ups", stat2="21 points checked", timeframe="one 90-minute visit", offer="free second opinion on any repair quote over $500", price="$129 tune-up"),
dict(fam="r07-copperline-plumbing-repipe", brand="Copperline Plumbing", industry="plumbing", product="leak detection and repiping", aud="homeowners with old galvanized pipes and mystery water bills", aud_short="homeowners", awareness="problem-aware", voice="craftsman", desire="pipes you never think about again", desire_short="pipes you forget exist", pain="mystery leaks, brown water, a $300 water bill for water you never used", mechanism="acoustic leak mapping that pinpoints the break within 6 inches — no exploratory demolition", mech_short="acoustic leak mapping", proof="1,150 repipes, zero slab tear-outs in 2025", stat="1,150 repipes", stat2="6-inch pinpoint accuracy", timeframe="most jobs done in 2 days", offer="free camera inspection with any service call", price="fixed quote upfront, no hourly meter"),
dict(fam="r07-ironclad-roofing-replace", brand="Ironclad Roofing", industry="roofing", product="roof replacement", aud="homeowners with 20-year-old shingles after storm season", aud_short="homeowners", awareness="solution-aware", voice="neighborly", desire="a roof that outlasts the mortgage paperwork", desire_short="a roof done once, done right", pain="storm-chaser door knockers, vague quotes, leaks that return every spring", mechanism="photo-documented install — 40+ timestamped photos of decking, flashing, and nailing pattern", mech_short="photo-documented install", proof="640 roofs installed, zero leak callbacks in 3 years", stat="640 roofs", stat2="0 leak callbacks in 3 years", timeframe="most homes done in 1 day", offer="free drone inspection with a written report", price="50-year shingle, quoted to the dollar"),
dict(fam="r07-verdant-lawn-program", brand="Verdant Lawn Co.", industry="landscaping", product="organic lawn care program", aud="suburban homeowners tired of patchy, chemically burned lawns", aud_short="homeowners", awareness="problem-aware", voice="neighborly", desire="a thick green lawn the kids can play on barefoot", desire_short="a barefoot-safe green lawn", pain="brown patches, chemical smell, a lawn service that mows and runs", mechanism="soil-first program — we test the soil, then feed it, 6 visits a year", mech_short="soil-first program", proof="2,300 lawns on program, 94% renew each spring", stat="2,300 lawns", stat2="94% renewal", timeframe="visible change in 6 weeks", offer="first soil test free", price="$59/visit, 6 visits"),
dict(fam="r07-shield-pest-barrier", brand="Shield Pest Defense", industry="pest control", product="quarterly pest barrier", aud="families seeing ants and roaches each spring", aud_short="families", awareness="problem-aware", voice="parent-reassuring", desire="a home where you never see a roach", desire_short="a bug-free home, guaranteed", pain="sprays that fade in weeks, roaches in the kitchen at night, technicians who won't explain what they used", mechanism="exterior barrier plus entry-point sealing, pet- and kid-safe products only", mech_short="barrier-and-seal method", proof="11,000 homes protected, 4.8 stars across 3,400 reviews", stat="11,000 homes", stat2="90-day barrier", timeframe="one 45-minute visit per quarter", offer="free re-treat between visits if pests return", price="$49/month"),
dict(fam="r07-sparkle-cleaning-recurring", brand="Sparkle & Co.", industry="house cleaning", product="recurring home cleaning", aud="dual-income families drowning in weekend chores", aud_short="busy families", awareness="problem-aware", voice="neighborly", desire="coming home Friday to a clean house", desire_short="Fridays off from cleaning", pain="weekends lost to bathrooms and floors, cleaners who skip the baseboards", mechanism="same two-person team every visit, 50-point checklist you approve", mech_short="50-point checklist", proof="380 recurring clients, average tenure 3.2 years", stat="380 recurring clients", stat2="3.2-year average tenure", timeframe="first clean this week", offer="first deep clean 25% off when you start recurring", price="$189/biweekly"),
dict(fam="r07-voltwire-electric-panel", brand="VoltWise Electric", industry="electrical", product="panel upgrades and EV chargers", aud="homeowners with full panels adding EVs or hot tubs", aud_short="homeowners", awareness="solution-aware", voice="craftsman", desire="a panel with room for everything, permitted and inspected", desire_short="room for the EV charger, done right", pain="breakers tripping, a panel from 1987, electricians who won't pull permits", mechanism="load calculation first, permit pulled before work starts, inspection scheduled for you", mech_short="permit-first installs", proof="900 panel upgrades, 100% first-time inspection pass rate", stat="900 panel upgrades", stat2="100% inspection pass", timeframe="most upgrades done in a day", offer="free load calculation with any quote", price="fixed quote, permit fees itemized"),
dict(fam="r07-garagepro-door-repair", brand="GaragePro", industry="garage door", product="garage door repair and openers", aud="homeowners with a door that screams at 6am", aud_short="homeowners", awareness="problem-aware", voice="craftsman", desire="a garage door that opens quietly", desire_short="a door you can't hear", pain="a door that wakes the house, remotes that die, springs that snap on Sunday", mechanism="nylon rollers plus belt-drive openers plus spring replacement in matched pairs", mech_short="quiet-door conversion", proof="5,400 doors serviced, same-day service 6 days a week", stat="5,400 doors serviced", stat2="same-day, 6 days a week", timeframe="most repairs in under an hour", offer="free 12-point safety check with any repair", price="$89 service call, waived with repair"),
dict(fam="r07-clearflow-septic-pump", brand="ClearFlow Septic", industry="septic", product="septic pumping and inspection", aud="rural homeowners who have never thought about the tank", aud_short="rural homeowners", awareness="unaware", voice="neighborly", desire="a septic system that never backs up", desire_short="a tank you never worry about", pain="slow drains and a $9,000 replacement because pumping was skipped for a decade", mechanism="3-year pump cycle with a photo report of sludge levels each visit", mech_short="photo-report pumping", proof="3,100 tanks on cycle; last year's 12 emergency backups were all non-clients", stat="3,100 tanks on cycle", stat2="3-year cycle", timeframe="pumped in under 2 hours", offer="free inspection with first pump", price="$349 pump-out"),
dict(fam="r07-timberline-tree-removal", brand="Timberline Tree Care", industry="tree service", product="tree removal and trimming", aud="homeowners with a leaning oak over the driveway", aud_short="homeowners", awareness="problem-aware", voice="craftsman", desire="the leaning oak gone, the lawn intact", desire_short="the tree gone, the lawn intact", pain="storm-damaged limbs, quotes that skip stump grinding, ruts across the yard", mechanism="crane-assisted removal with lawn mats — no heavy equipment on your turf", mech_short="crane-and-mat removal", proof="2,800 removals, $0 in landscape damage claims", stat="2,800 removals", stat2="$0 damage claims", timeframe="most removals in half a day", offer="free risk assessment for storm-damaged trees", price="stump grinding included in every quote"),
dict(fam="r07-freshcoat-painting-interior", brand="FreshCoat Painting", industry="painting", product="interior repaint", aud="homeowners embarrassed by scuffed walls before hosting", aud_short="homeowners", awareness="problem-aware", voice="craftsman", desire="walls that look new in every light", desire_short="walls that look new", pain="roller marks, paint on the trim, a crew that leaves at 3pm for three weeks", mechanism="two-coat system with back-rolling, color matched in your lighting before we start", mech_short="two-coat back-roll system", proof="1,900 interiors, 98% would refer", stat="1,900 interiors", stat2="98% referral rate", timeframe="most homes done in 3 days", offer="free color consultation with large swatches", price="per-room fixed pricing"),
dict(fam="r07-solidstep-flooring-refinish", brand="SolidStep Flooring", industry="flooring", product="hardwood refinishing", aud="homeowners with scratched 1990s oak", aud_short="homeowners", awareness="solution-aware", voice="craftsman", desire="floors that look like the day they were laid", desire_short="floors like day one", pain="dust everywhere for a week, stain that looks orange, finish that scratches in a month", mechanism="dust-contained sanding with a 4-stage finish, stain samples on your actual floor", mech_short="dust-contained refinishing", proof="1,400 floors refinished, 3 dust complaints ever", stat="1,400 floors", stat2="3 dust complaints, ever", timeframe="3-day turnaround", offer="free stain samples on your floor", price="$4.50/sq ft, all-in"),
dict(fam="r07-heartwood-kitchen-remodel", brand="Heartwood Kitchens", industry="kitchen remodel", product="kitchen remodeling", aud="families cooking in a 1985 kitchen", aud_short="families", awareness="solution-aware", voice="craftsman", desire="a kitchen that works the way you cook", desire_short="a kitchen built around your cooking", pain="contractors who vanish, budgets that double, a kitchen torn up for 4 months", mechanism="fixed-price contract with a 3D walkthrough before demolition starts", mech_short="3D-first fixed-price remodels", proof="120 kitchens, 96% finished on the contracted date", stat="120 kitchens", stat2="96% on-time", timeframe="6-week average build", offer="free 3D design with consultation", price="fixed price in writing"),
dict(fam="r07-serenebath-conversion", brand="Serene Bath Co.", industry="bathroom remodel", product="one-day bath conversions", aud="older homeowners wanting a walk-in shower", aud_short="homeowners", awareness="solution-aware", voice="parent-reassuring", desire="a walk-in shower with no step and no slippery tub edge", desire_short="a shower with no step", pain="a tub that's hard to climb into, grout that never stays clean, remodelers who take weeks", mechanism="one-day acrylic conversion over your existing footprint — no bathroom demolition", mech_short="one-day conversion", proof="2,050 conversions, 4.9 stars", stat="2,050 conversions", stat2="1-day install", timeframe="installed in one day", offer="free in-home design visit", price="quoted to the dollar, no change orders"),
dict(fam="r07-crystalpool-weekly", brand="Crystal Pool Service", industry="pool service", product="weekly pool maintenance", aud="pool owners fighting green water", aud_short="pool owners", awareness="problem-aware", voice="neighborly", desire="a pool that's swimmable every Saturday", desire_short="swimmable every Saturday", pain="green water before the party, chemical guesswork, a service that skims and leaves", mechanism="same tech weekly, photo report of chemistry after every visit", mech_short="photo-report pool care", proof="640 pools on route, 99.2% swimmable Saturdays", stat="640 pools", stat2="99.2% swimmable", timeframe="first visit this week", offer="first month 20% off", price="$199/month"),
dict(fam="r07-keyline-locksmith-rekey", brand="Keyline Locksmith", industry="locksmith", product="home rekey and smart locks", aud="new homeowners who don't know who has keys", aud_short="new homeowners", awareness="problem-aware", voice="neighborly", desire="knowing exactly who can open your front door", desire_short="keys only you control", pain="previous owners, dog sitters, and contractors all holding copies", mechanism="full rekey plus a written key log — every copy accounted for", mech_short="rekey-with-key-log", proof="8,900 homes rekeyed, 15-minute average lockout response", stat="8,900 homes rekeyed", stat2="15-min lockout response", timeframe="rekeyed in under an hour", offer="free security walkthrough with any rekey", price="$129 whole-home rekey"),
dict(fam="r07-fixright-appliance-repair", brand="FixRight Appliance", industry="appliance repair", product="appliance repair", aud="families with a dead fridge full of groceries", aud_short="families", awareness="problem-aware", voice="craftsman", desire="the fridge cold again before the food spoils", desire_short="cold fridge, same day", pain="a week without a fridge, a $400 part on a $500 machine, techs who don't stock parts", mechanism="van stocked with the 200 most common parts — 8 in 10 fixed on the first visit", mech_short="first-visit fix", proof="12,000 repairs, 82% fixed first visit", stat="12,000 repairs", stat2="82% first-visit fix", timeframe="same-day appointments", offer="free diagnostic with repair", price="$79 diagnostic, waived with repair"),
dict(fam="r07-lumiskin-serum", brand="Lumi Skin", industry="skincare", product="vitamin C serum", aud="women 30-45 seeing first fine lines", aud_short="women 30-45", awareness="solution-aware", voice="dry-wry", desire="brighter skin without a 9-step routine", desire_short="brighter skin, one step", pain="serums that oxidize brown in a month, routines with 9 steps, $80 bottles that do nothing", mechanism="15% stabilized vitamin C in airless packaging — stays potent to the last pump", mech_short="airless stabilized C", proof="38,000 bottles sold, 4.6 stars from 9,200 reviews", stat="38,000 bottles", stat2="4.6 stars", timeframe="visible brightness in 3 weeks", offer="60-day empty-bottle guarantee", price="$48"),
dict(fam="r07-deepsleep-mattress", brand="DeepSleep", industry="mattress", product="hybrid mattress in a box", aud="side sleepers waking with hip pain", aud_short="side sleepers", awareness="solution-aware", voice="dry-wry", desire="waking up without hip or shoulder pain", desire_short="mornings without the ache", pain="a mattress that sags in a year, sleeping hot, the showroom lie-down that tells you nothing", mechanism="zoned coils — firmer under hips, softer under shoulders — plus a cool-touch cover", mech_short="zoned-coil hybrid", proof="52,000 sleepers, 4.7 stars", stat="52,000 sleepers", stat2="4.7 stars", timeframe="100-night trial", offer="100-night trial, free returns", price="$899 queen"),
dict(fam="r07-coppercup-coffee-sub", brand="Copper Cup", industry="coffee subscription", product="fresh-roast coffee subscription", aud="coffee drinkers buying stale grocery beans", aud_short="coffee drinkers", awareness="problem-aware", voice="dry-wry", desire="coffee that was roasted this week", desire_short="roasted-this-week coffee", pain="beans roasted 6 months ago, subscriptions that send too much or too little", mechanism="roasted the day it ships, grind matched to your brewer, pause anytime", mech_short="roast-to-ship", proof="21,000 subscribers, roast date printed on every bag", stat="21,000 subscribers", stat2="roast date on every bag", timeframe="at your door in 3 days", offer="first bag $9", price="$19/bag"),
dict(fam="r07-wildroot-dogfood", brand="Wildroot", industry="pet food", product="gently-cooked dog food", aud="dog owners with itchy, gassy dogs", aud_short="dog owners", awareness="problem-aware", voice="parent-reassuring", desire="a dog with calm skin and solid digestion", desire_short="calm skin, calm stomach", pain="itchy paws, 3am yard trips, kibble with 40 ingredients you can't pronounce", mechanism="gently cooked in small batches, 8 recognizable ingredients, vet nutritionist formulated", mech_short="8-ingredient gentle cook", proof="64,000 dogs fed, 4.8 stars", stat="64,000 dogs", stat2="8 ingredients", timeframe="transition plan over 10 days", offer="first box 50% off", price="$3.20/day"),
dict(fam="r07-sundaytable-mealkit", brand="Sunday Table", industry="meal kit", product="family meal kit", aud="parents doing the 5pm dinner scramble", aud_short="parents", awareness="problem-aware", voice="neighborly", desire="dinner on the table in 25 minutes, no grocery run", desire_short="dinner in 25, no store run", pain="the 5pm scramble, takeout 4 nights a week, kids who reject everything", mechanism="pre-prepped ingredients plus a 25-minute card, kid-approved and tested on 200 families", mech_short="25-minute pre-prepped kits", proof="18,000 families, 4.5 stars", stat="18,000 families", stat2="25 minutes", timeframe="first box this week", offer="first box $29", price="$8.99/serving"),
dict(fam="r07-upright-desk", brand="Upright", industry="standing desk", product="electric standing desk", aud="remote workers with 3pm back ache", aud_short="remote workers", awareness="problem-aware", voice="engineer-plain", desire="a desk that moves at the touch of a button and never wobbles", desire_short="a desk that never wobbles", pain="a $200 desk that shakes when you type, motors that die in a year", mechanism="dual motors with 4 memory presets, 300-lb lift, anti-collision sensor", mech_short="dual-motor lift", proof="44,000 desks, 4.8 stars, 15-year frame warranty", stat="44,000 desks", stat2="15-year warranty", timeframe="assembles in 40 minutes", offer="30-day trial, free return shipping", price="$549"),
]

# Batch 2: DTC continued (14) + B2B SaaS start (11)
BRIEFS += [
dict(fam="r07-sitwell-chair", brand="SitWell", industry="ergonomic chair", product="ergonomic office chair", aud="desk workers with lower-back pain", aud_short="desk workers", awareness="solution-aware", voice="engineer-plain", desire="sitting 8 hours without thinking about your back", desire_short="8 hours, no back thoughts", pain="a $150 chair that broke your posture, lumbar 'support' that's a pillow", mechanism="dynamic lumbar that follows your spine plus seat-depth adjustment", mech_short="dynamic lumbar", proof="31,000 chairs, recommended by 400+ physical therapists", stat="31,000 chairs", stat2="400+ PT recommendations", timeframe="ships in 48 hours", offer="30-day sit test", price="$399"),
dict(fam="r07-purewell-filter", brand="PureWell", industry="water filter", product="under-sink water filter", aud="families worried about tap water taste and lead", aud_short="families", awareness="problem-aware", voice="parent-reassuring", desire="tap water you trust straight from the faucet", desire_short="tap water you trust", pain="chlorine taste, filter pitchers you forget to refill, lead headlines", mechanism="3-stage under-sink filtration, NSF-certified, 6-month cartridges with a change light", mech_short="3-stage NSF filtration", proof="27,000 homes, third-party lab reports published", stat="27,000 homes", stat2="NSF-certified", timeframe="installs in 30 minutes", offer="free water test strip kit", price="$249"),
dict(fam="r07-clearair-purifier", brand="ClearAir", industry="air purifier", product="HEPA air purifier", aud="allergy sufferers waking congested", aud_short="allergy sufferers", awareness="problem-aware", voice="clinical-warm", desire="waking up able to breathe through your nose", desire_short="mornings you can breathe", pain="dust on everything in a day, a purifier louder than the TV, filters that cost $80", mechanism="medical-grade HEPA-13 plus whisper fan at 24dB, filter lasts 12 months", mech_short="HEPA-13 whisper system", proof="39,000 bedrooms, 4.7 stars", stat="39,000 bedrooms", stat2="24 decibels", timeframe="clean air in 20 minutes", offer="60-day breathe-easy trial", price="$229"),
dict(fam="r07-nightcap-sleep-drink", brand="Nightcap", industry="sleep supplement", product="magnesium sleep drink", aud="adults staring at the ceiling at 2am", aud_short="restless sleepers", awareness="problem-aware", voice="clinical-warm", desire="falling asleep without scrolling till 1am", desire_short="asleep before midnight", pain="melatonin grogginess, sleep aids you can't stop taking, 2am ceiling-staring", mechanism="magnesium glycinate plus theanine, non-habit-forming, third-party tested", mech_short="magnesium-theanine blend", proof="85,000 customers, 4.5 stars", stat="85,000 customers", stat2="non-habit-forming", timeframe="30-minute wind-down", offer="first month $19", price="$39/month"),
dict(fam="r07-forge-protein", brand="Forge", industry="protein powder", product="whey isolate protein", aud="lifters tired of chalky, bloating protein", aud_short="lifters", awareness="solution-aware", voice="coach-direct", desire="30g protein that mixes clean and doesn't bloat you", desire_short="30g, no bloat", pain="chalky shakes, stomach cramps, labels hiding the amino spiking", mechanism="cold-filtered isolate, 3 ingredients, third-party tested for label accuracy", mech_short="3-ingredient isolate", proof="120,000 tubs, Informed-Sport certified", stat="120,000 tubs", stat2="3 ingredients", timeframe="mixes in 10 seconds", offer="first tub 20% off", price="$54"),
dict(fam="r07-ember-candle", brand="Ember & Oak", industry="candle", product="soy candles", aud="gift buyers wanting a candle that actually scents a room", aud_short="gift buyers", awareness="solution-aware", voice="minimalist", desire="a candle you can smell from the doorway", desire_short="scent from the doorway", pain="candles that smell like nothing, tunneling after one burn, soot on the walls", mechanism="wooden wick plus 12% fragrance load, 55-hour burn, cotton-free", mech_short="wood-wick 12% load", proof="90,000 candles poured, 4.9 stars", stat="90,000 candles", stat2="55-hour burn", timeframe="ships in 2 days", offer="bundle 3, save 15%", price="$28"),
dict(fam="r07-treadwell-socks", brand="Treadwell", industry="socks", product="merino hiking socks", aud="hikers with blistered heels", aud_short="hikers", awareness="problem-aware", voice="dry-wry", desire="socks that don't blister on mile 9", desire_short="no blisters at mile 9", pain="cotton socks soaked by mile 3, heel holes in a month", mechanism="merino-nylon knit with a blister-free heel tab, lifetime guarantee", mech_short="blister-tab knit", proof="410,000 pairs, lifetime guarantee honored 6,200 times", stat="410,000 pairs", stat2="lifetime guarantee", timeframe="ships in 3 days", offer="3-pack starter $36", price="$14/pair"),
dict(fam="r07-secondskin-underwear", brand="SecondSkin", industry="underwear", product="performance underwear", aud="men tired of bunching and waistbands that roll", aud_short="men", awareness="problem-aware", voice="dry-wry", desire="underwear you forget you're wearing", desire_short="underwear you forget", pain="waistbands that roll, thighs that ride up, pairs that die in 3 months", mechanism="long-staple modal with a no-roll waistband, flatlock seams", mech_short="no-roll modal", proof="280,000 customers, 4.7 stars", stat="280,000 customers", stat2="4.7 stars", timeframe="ships in 2 days", offer="first pair $12", price="$24/pair"),
dict(fam="r07-waypoint-backpack", brand="Waypoint", industry="backpack", product="travel backpack", aud="one-bag travelers fighting overhead-bin roulette", aud_short="one-bag travelers", awareness="solution-aware", voice="minimalist", desire="one bag that fits the sizer and holds 5 days", desire_short="5 days, one bag", pain="a 'carry-on' that never fits, straps that dig, a laptop sleeve you can't reach", mechanism="35L clamshell with a lay-flat laptop bay, fits every major airline sizer", mech_short="35L clamshell", proof="76,000 travelers, 4.8 stars", stat="76,000 travelers", stat2="35 liters", timeframe="ships in 2 days", offer="30-day travel test", price="$189"),
dict(fam="r07-roam-luggage", brand="Roam", industry="luggage", product="carry-on suitcase", aud="frequent flyers with cracked shells and stuck wheels", aud_short="frequent flyers", awareness="solution-aware", voice="minimalist", desire="a carry-on that survives 200 flights", desire_short="200 flights, zero cracks", pain="a cracked shell in year one, wheels that jam, zippers that burst", mechanism="aerospace polycarbonate shell plus replaceable wheels, lifetime warranty", mech_short="replaceable-wheel shell", proof="58,000 flyers, 4.8 stars", stat="58,000 flyers", stat2="lifetime warranty", timeframe="ships in 2 days", offer="free monogram", price="$295"),
dict(fam="r07-ironclad-cookware-pan", brand="Ironclad", industry="cookware", product="carbon steel pan", aud="home cooks fighting flaking nonstick", aud_short="home cooks", awareness="problem-aware", voice="craftsman", desire="a pan that sears like cast iron and weighs half as much", desire_short="cast-iron sear, half the weight", pain="nonstick that flakes in a year, pans that warp, seasoning that strips", mechanism="pre-seasoned carbon steel, oven-safe to 600°F, re-seasonable forever", mech_short="pre-seasoned carbon steel", proof="140,000 pans, 4.9 stars", stat="140,000 pans", stat2="600°F oven-safe", timeframe="ships in 3 days", offer="60-day cook test", price="$129"),
dict(fam="r07-edgewright-knives", brand="Edgewright", industry="knife set", product="Japanese chef knife", aud="home cooks with dull drawer knives", aud_short="home cooks", awareness="problem-aware", voice="craftsman", desire="a knife that falls through an onion", desire_short="falls through an onion", pain="a drawer of dull knives, a 'set' where you use one knife, sharpening that costs $12 a pop", mechanism="VG-10 steel at 61 HRC, hand-finished edge, free lifetime sharpening", mech_short="VG-10 hand-finished edge", proof="62,000 kitchens, 4.9 stars", stat="62,000 kitchens", stat2="61 HRC", timeframe="ships in 2 days", offer="free lifetime sharpening", price="$149"),
dict(fam="r07-loam-bedding", brand="Loam", industry="bedding", product="linen sheet set", aud="hot sleepers waking sweaty", aud_short="hot sleepers", awareness="problem-aware", voice="minimalist", desire="sheets that feel cool at 3am", desire_short="cool at 3am", pain="polyester sheets that trap heat, pilling in a month, 'luxury' that's 200 thread count", mechanism="European flax linen, stonewashed, gets softer every wash", mech_short="stonewashed flax", proof="48,000 beds, 4.8 stars", stat="48,000 beds", stat2="4.8 stars", timeframe="ships in 2 days", offer="60-night sleep trial", price="$189"),
dict(fam="r07-waggle-treats", brand="Waggle", industry="dog treats", product="single-ingredient dog treats", aud="owners reading treat labels in horror", aud_short="dog owners", awareness="problem-aware", voice="parent-reassuring", desire="a treat with one ingredient you can picture", desire_short="one ingredient, pictured", pain="treats with 30 ingredients, 'meat by-products', recalls every other year", mechanism="single-ingredient freeze-dried, sourced from one ranch, batch-tested", mech_short="single-ingredient freeze-dried", proof="95,000 dogs, 4.9 stars", stat="95,000 dogs", stat2="1 ingredient", timeframe="ships in 2 days", offer="first bag 30% off", price="$16/bag"),
dict(fam="r07-taskline-pm", brand="Taskline", industry="project management SaaS", product="project management for agencies", aud="agency owners juggling 14 client projects in spreadsheets", aud_short="agency owners", awareness="problem-aware", voice="engineer-plain", desire="knowing every project's status without a status meeting", desire_short="no more status meetings", pain="14 spreadsheets, Friday status calls, deadlines discovered when they're missed", mechanism="client workspaces with auto status rollups — one dashboard, zero meetings", mech_short="auto status rollups", proof="2,100 agencies, 4.7 on G2", stat="2,100 agencies", stat2="4.7 on G2", timeframe="set up in a day", offer="free migration from your spreadsheets", price="$12/user/mo"),
dict(fam="r07-ledgerly-invoicing", brand="Ledgerly", industry="invoicing SaaS", product="invoicing for freelancers", aud="freelancers chasing late invoices", aud_short="freelancers", awareness="problem-aware", voice="founder-earnest", desire="invoices that get paid in days, not months", desire_short="paid in days", pain="net-60 that means net-never, awkward reminder emails, no idea who owes what", mechanism="smart reminders plus one-click card payments, sent automatically on your schedule", mech_short="automatic smart reminders", proof="38,000 freelancers, average payment in 6.2 days", stat="38,000 freelancers", stat2="paid in 6.2 days avg", timeframe="first invoice in 10 minutes", offer="free for your first 3 invoices", price="$15/mo"),
dict(fam="r07-hourglass-time", brand="Hourglass", industry="time tracking SaaS", product="time tracking for teams", aud="managers guessing where hours went", aud_short="managers", awareness="problem-aware", voice="data-dry", desire="timesheets that fill themselves", desire_short="timesheets that write themselves", pain="Friday timesheet amnesia, estimates that miss by 40%, no data for the next quote", mechanism="passive capture from calendar and tools, one-tap approval Friday", mech_short="passive capture", proof="5,400 teams, 1.1M hours tracked weekly", stat="5,400 teams", stat2="1.1M hours/week", timeframe="live in an afternoon", offer="free for teams under 5", price="$8/user/mo"),
dict(fam="r07-pipeline-crm", brand="Pipeline", industry="CRM SaaS", product="simple CRM for small sales teams", aud="founders running sales from memory and inbox", aud_short="founders", awareness="problem-aware", voice="founder-earnest", desire="every deal, every follow-up, in one place", desire_short="no deal slips", pain="deals in the founder's head, follow-ups in Gmail, pipeline equals vibes", mechanism="pipeline that updates from your email — no manual data entry", mech_short="email-synced pipeline", proof="9,800 teams, 4.6 on Capterra", stat="9,800 teams", stat2="4.6 on Capterra", timeframe="import in an hour", offer="free 30-day trial, no card", price="$29/user/mo"),
dict(fam="r07-broadcast-email", brand="Broadcast", industry="email marketing SaaS", product="email for creators", aud="creators with 10k followers and 200 email subscribers", aud_short="creators", awareness="problem-aware", voice="founder-earnest", desire="an email list that pays the rent", desire_short="a list that pays rent", pain="algorithm rent, 2% reach, no way to reach your own audience", mechanism="import followers in one click, welcome sequence pre-written, send in plain text", mech_short="one-click import and pre-written sequence", proof="24,000 creators, 41% average open rate", stat="24,000 creators", stat2="41% avg open rate", timeframe="first send today", offer="free up to 1,000 subscribers", price="$29/mo after"),
dict(fam="r07-resolve-helpdesk", brand="Resolve", industry="helpdesk SaaS", product="shared inbox for support teams", aud="support teams drowning in a shared Gmail", aud_short="support teams", awareness="problem-aware", voice="engineer-plain", desire="every ticket answered, none assigned twice", desire_short="zero double-replies", pain="two agents replying to one customer, VIPs lost in the pile, no idea what 'good' looks like", mechanism="collision detection plus SLA timers plus one-click macros, built on your Gmail", mech_short="collision detection", proof="3,200 support teams, 31% faster first response", stat="3,200 teams", stat2="31% faster first response", timeframe="live in a day", offer="free migration from Gmail", price="$20/agent/mo"),
dict(fam="r07-vaultkey-password", brand="VaultKey", industry="password manager SaaS", product="password manager for small teams", aud="teams sharing logins in Slack", aud_short="teams", awareness="problem-aware", voice="data-dry", desire="one click to log in, zero passwords in Slack", desire_short="zero passwords in Slack", pain="the shared doc of passwords, ex-employees with access, 'what's the wifi password' for the 40th time", mechanism="SSO plus autofill plus one-click offboarding, SOC 2 Type II", mech_short="one-click offboarding", proof="7,100 teams, SOC 2 Type II", stat="7,100 teams", stat2="SOC 2 Type II", timeframe="rolled out in a day", offer="free security audit of your current setup", price="$4/user/mo"),
dict(fam="r07-backstop-backup", brand="Backstop", industry="cloud backup SaaS", product="backup for small business", aud="businesses one ransomware email from disaster", aud_short="business owners", awareness="unaware", voice="data-dry", desire="every file back in an hour after the worst day", desire_short="back in an hour", pain="the 'backup' nobody tested, ransomware, the external drive from 2019", mechanism="continuous backup with one-click restore, tested automatically every night", mech_short="nightly-tested restore", proof="11,000 businesses, 99.99% restore success", stat="11,000 businesses", stat2="99.99% restore success", timeframe="first backup tonight", offer="free 30-day trial", price="$6/device/mo"),
dict(fam="r07-pulse-survey", brand="Pulse", industry="survey SaaS", product="employee pulse surveys", aud="HR teams running annual surveys nobody reads", aud_short="HR teams", awareness="problem-aware", voice="data-dry", desire="knowing morale monthly, not yearly", desire_short="morale, monthly", pain="the 80-question annual survey, 30% response, results that arrive in March", mechanism="3 questions monthly, anonymous by design, trends in one chart", mech_short="3-question pulse", proof="2,600 companies, 78% average response rate", stat="2,600 companies", stat2="78% response rate", timeframe="first pulse this week", offer="free for under 25 employees", price="$3/employee/mo"),
dict(fam="r07-stage-webinar", brand="Stage", industry="webinar SaaS", product="webinars for course creators", aud="creators whose webinars drop half the audience", aud_short="creators", awareness="problem-aware", voice="founder-earnest", desire="a webinar where 70% stay to the offer", desire_short="70% stay to the offer", pain="Zoom fatigue, 50% dropoff by minute 10, chat chaos", mechanism="interactive polls plus staged Q&A plus replay chapters, built for selling", mech_short="interactive staged format", proof="8,900 creators, 68% average stay-through", stat="8,900 creators", stat2="68% stay-through", timeframe="first webinar this week", offer="free for your first webinar", price="$79/mo"),
dict(fam="r07-calwise-scheduling", brand="CalWise", industry="scheduling SaaS", product="scheduling for consultants", aud="consultants playing email tag for every meeting", aud_short="consultants", awareness="problem-aware", voice="engineer-plain", desire="a calendar that books itself", desire_short="meetings book themselves", pain="7-email scheduling threads, no-shows, double bookings", mechanism="smart link with buffers plus automatic reminders plus one-click reschedule", mech_short="smart-link booking", proof="19,000 consultants, 43% fewer no-shows", stat="19,000 consultants", stat2="43% fewer no-shows", timeframe="live in 20 minutes", offer="free for 1 calendar", price="$12/mo"),
]

# Batch 3: B2B SaaS continued (9) + consumer apps (12) + pro services start (4)
BRIEFS += [
dict(fam="r07-signoff-esign", brand="SignOff", industry="e-signature SaaS", product="e-signatures for real estate teams", aud="agents chasing paper signatures", aud_short="agents", awareness="problem-aware", voice="legal-precise", desire="contracts signed before the showing ends", desire_short="signed before the showing ends", pain="print-scan-email loops, lost initials, deals delayed a weekend", mechanism="mobile-first signing with audit trail, compliant in all 50 states", mech_short="audit-trail mobile signing", proof="14,000 agents, 22-minute average turnaround", stat="14,000 agents", stat2="22-min avg turnaround", timeframe="first document today", offer="free for 3 documents/month", price="$25/mo"),
dict(fam="r07-expenseiq-expense", brand="ExpenseIQ", industry="expense SaaS", product="expense reports for startups", aud="founders reconciling a shoebox monthly", aud_short="founders", awareness="problem-aware", voice="data-dry", desire="expenses filed before the coffee cools", desire_short="filed before the coffee cools", pain="the shoebox, month-end reconciliation hell, receipts in camera rolls", mechanism="snap the receipt, AI codes it, syncs to your books nightly", mech_short="snap-and-sync coding", proof="6,700 startups, 11 minutes average monthly close on expenses", stat="6,700 startups", stat2="11-min monthly close", timeframe="first report today", offer="free for 2 users", price="$10/user/mo"),
dict(fam="r07-payrollpilot-payroll", brand="Payroll Pilot", industry="payroll SaaS", product="payroll for small business", aud="owners running payroll on Sundays", aud_short="owners", awareness="problem-aware", voice="legal-precise", desire="payroll done in 5 minutes, taxes filed for you", desire_short="payroll in 5 minutes", pain="Sunday payroll, tax deadlines, penalties for a missed filing", mechanism="auto-run payroll plus automatic filings in all 50 states, handled", mech_short="auto-run and auto-file", proof="9,300 businesses, zero filing penalties in 2025", stat="9,300 businesses", stat2="zero penalties in 2025", timeframe="first run this Friday", offer="first month free", price="$40/mo + $6/employee"),
dict(fam="r07-hireline-ats", brand="Hireline", industry="hiring SaaS", product="hiring for growing teams", aud="founders losing candidates in email", aud_short="founders", awareness="problem-aware", voice="founder-earnest", desire="every candidate answered within 48 hours", desire_short="answered in 48 hours", pain="resumes in inboxes, great candidates ghosted, no idea where the pipeline stands", mechanism="one pipeline, auto-acknowledge, interview scheduling built in", mech_short="auto-acknowledge pipeline", proof="4,100 teams, 2.1x faster time-to-hire", stat="4,100 teams", stat2="2.1x faster hiring", timeframe="first job posted today", offer="free for your first hire", price="$99/mo"),
dict(fam="r07-queueup-social", brand="QueueUp", industry="social scheduling SaaS", product="social scheduling for agencies", aud="agencies posting manually at 9am daily", aud_short="agencies", awareness="problem-aware", voice="engineer-plain", desire="a month of posts scheduled in an afternoon", desire_short="a month in an afternoon", pain="the 9am manual post, missed days, no approval trail for clients", mechanism="bulk queue plus client approval links plus best-time auto-scheduling", mech_short="approval-link queue", proof="7,800 agencies, 4.6 on G2", stat="7,800 agencies", stat2="4.6 on G2", timeframe="first queue today", offer="free 14-day trial", price="$49/mo"),
dict(fam="r07-rankright-seo", brand="RankRight", industry="SEO SaaS", product="rank tracking for local agencies", aud="agencies screenshotting rankings", aud_short="agencies", awareness="problem-aware", voice="data-dry", desire="rankings, reviews, and competitors in one morning email", desire_short="SEO in one morning email", pain="manual rank checks, review alerts you miss, reports that take Fridays", mechanism="daily local rank tracking plus review monitoring plus one-click white-label reports", mech_short="daily local tracking", proof="3,900 agencies, 120k locations tracked", stat="3,900 agencies", stat2="120k locations", timeframe="first report tomorrow", offer="free for 3 locations", price="$59/mo"),
dict(fam="r07-northstar-analytics", brand="Northstar", industry="analytics SaaS", product="privacy-friendly analytics", aud="site owners drowning in GA4", aud_short="site owners", awareness="problem-aware", voice="data-dry", desire="knowing what works on your site in 30 seconds", desire_short="answers in 30 seconds", pain="GA4's maze, cookie banners, reports nobody opens", mechanism="cookieless tracking, one dashboard, the 8 numbers that matter", mech_short="cookieless 8-number dashboard", proof="28,000 sites, 4.8 on G2", stat="28,000 sites", stat2="cookieless", timeframe="live in 5 minutes", offer="free up to 10k pageviews", price="$19/mo"),
dict(fam="r07-concierge-chatbot", brand="Concierge", industry="chatbot SaaS", product="AI chatbot for ecommerce", aud="stores answering 'where's my order' 200x daily", aud_short="store owners", awareness="problem-aware", voice="engineer-plain", desire="200 'where's my order' questions answered without a human", desire_short="'where's my order,' handled", pain="the same 5 questions, support tickets at midnight, chatbots that hallucinate policies", mechanism="trained on your help center plus order data, escalates with full context", mech_short="help-center-trained answers", proof="1,900 stores, 61% of chats resolved without humans", stat="1,900 stores", stat2="61% auto-resolved", timeframe="live in a week", offer="free 30-day pilot", price="$99/mo"),
dict(fam="r07-handbook-kb", brand="Handbook", industry="knowledge base SaaS", product="internal wiki for remote teams", aud="teams asking the same questions in Slack", aud_short="remote teams", awareness="problem-aware", voice="teacher-patient", desire="the answer found before the question is asked twice", desire_short="asked once, found forever", pain="the same Slack question weekly, onboarding that takes a month, docs nobody trusts", mechanism="Slack import plus AI answers with sources, stale pages flagged automatically", mech_short="source-cited AI answers", proof="2,400 teams, 38% fewer repeat questions", stat="2,400 teams", stat2="38% fewer repeats", timeframe="imported in a day", offer="free for 10 users", price="$8/user/mo"),
dict(fam="r07-stillspace-meditation", brand="Stillspace", industry="meditation app", product="meditation for skeptics", aud="stressed professionals who think meditation isn't for them", aud_short="skeptics", awareness="unaware", voice="dry-wry", desire="10 minutes that actually quiet the noise", desire_short="10 quiet minutes", pain="the 45-minute woo-woo sessions, apps that guilt you into streaks", mechanism="10-minute secular sessions, no streaks, no guru talk", mech_short="10-minute secular sessions", proof="900,000 downloads, 4.8 stars", stat="900,000 downloads", stat2="4.8 stars", timeframe="first session tonight", offer="free for 30 days", price="$70/year"),
dict(fam="r07-parola-language", brand="Parola", industry="language app", product="Spanish for travelers", aud="travelers who want more than phrasebook Spanish", aud_short="travelers", awareness="problem-aware", voice="teacher-patient", desire="ordering dinner in Spanish without pointing", desire_short="dinner, in Spanish", pain="the phrasebook panic, apps that teach 'the apple is red' for 6 months", mechanism="conversation-first lessons built around 40 travel situations", mech_short="40-situation conversation method", proof="1.4M learners, 4.7 stars", stat="1.4M learners", stat2="4.7 stars", timeframe="first conversation in a week", offer="free for 7 days", price="$12/mo"),
dict(fam="r07-streakless-habits", brand="Streakless", industry="habit tracker app", product="habit tracker without streaks", aud="people who have broken 30-day streaks 12 times", aud_short="reformed streak-breakers", awareness="problem-aware", voice="dry-wry", desire="habits that survive a bad week", desire_short="habits that survive Mondays", pain="streak apps that punish rest days, the all-or-nothing spiral", mechanism="weekly rhythm tracking — miss a day, the week still counts", mech_short="weekly-rhythm tracking", proof="340,000 users, 4.6 stars", stat="340,000 users", stat2="4.6 stars", timeframe="set up in 5 minutes", offer="free forever plan", price="$5/mo pro"),
dict(fam="r07-pennywise-budget", brand="Pennywise", industry="budget app", product="budgeting for couples", aud="couples fighting about money monthly", aud_short="couples", awareness="problem-aware", voice="founder-earnest", desire="money talks that don't end in a fight", desire_short="money talks, minus the fight", pain="the monthly money fight, budgets in a spreadsheet nobody opens", mechanism="shared envelopes plus a weekly 10-minute money date prompt", mech_short="shared-envelope dates", proof="210,000 couples, 4.7 stars", stat="210,000 couples", stat2="4.7 stars", timeframe="first money date this Sunday", offer="free for 30 days", price="$9/mo"),
dict(fam="r07-simmer-recipe", brand="Simmer", industry="recipe app", product="weeknight recipes", aud="cooks with 20 minutes and an empty-fridge stare", aud_short="busy cooks", awareness="problem-aware", voice="neighborly", desire="dinner from what's already in the fridge", desire_short="dinner from the fridge", pain="recipes needing 14 ingredients, the 8pm 'what's for dinner' panic", mechanism="type 3 ingredients, get 20-minute recipes ranked by what you have", mech_short="3-ingredient matching", proof="1.1M cooks, 4.8 stars", stat="1.1M cooks", stat2="4.8 stars", timeframe="dinner tonight", offer="free forever", price="$4/mo pro"),
dict(fam="r07-tempo-workout", brand="Tempo", industry="workout app", product="strength for beginners", aud="beginners intimidated by gyms", aud_short="beginners", awareness="problem-aware", voice="coach-direct", desire="your first unassisted pull-up", desire_short="your first pull-up", pain="gym intimidation, programs written for athletes, no idea if form is right", mechanism="video form checks plus progressive plans starting with bodyweight", mech_short="form-check progression", proof="520,000 beginners, 4.7 stars", stat="520,000 beginners", stat2="4.7 stars", timeframe="first workout today", offer="free for 14 days", price="$15/mo"),
dict(fam="r07-drift-sleep", brand="Drift", industry="sleep tracker app", product="sleep tracking without wearables", aud="people who won't wear a watch to bed", aud_short="non-wearable sleepers", awareness="solution-aware", voice="clinical-warm", desire="knowing why Tuesdays wreck you, without wearing anything", desire_short="sleep answers, no wearable", pain="the watch you won't wear to bed, sleep scores with no advice", mechanism="phone-on-nightstand sonar tracking plus a morning 2-line insight", mech_short="nightstand sonar", proof="780,000 sleepers, 4.6 stars", stat="780,000 sleepers", stat2="4.6 stars", timeframe="first insight tomorrow", offer="free for 14 days", price="$8/mo"),
dict(fam="r07-sprout-plant", brand="Sprout", industry="plant care app", product="plant care reminders", aud="serial plant killers", aud_short="plant killers", awareness="problem-aware", voice="playful-clear", desire="plants that live longer than a month", desire_short="plants that survive you", pain="the fiddle-leaf funeral, watering guesses, apps that ID the plant wrong", mechanism="photo ID plus a watering schedule tuned to your light and pot size", mech_short="light-tuned schedules", proof="2.3M plant parents, 4.8 stars", stat="2.3M plant parents", stat2="4.8 stars", timeframe="first schedule today", offer="free for 5 plants", price="$6/mo"),
dict(fam="r07-fretboard-guitar", brand="Fretboard", industry="guitar lessons app", product="guitar for adults", aud="adults who quit guitar at 16", aud_short="adult restarters", awareness="problem-aware", voice="teacher-patient", desire="playing a full song at the campfire", desire_short="a full song, campfire-ready", pain="the 16-year-old quit, YouTube lesson chaos, fingers that give up in week 2", mechanism="one song at a time, 15 minutes a day, slow-downer built in", mech_short="one-song method", proof="410,000 students, 4.8 stars", stat="410,000 students", stat2="4.8 stars", timeframe="first song in 2 weeks", offer="free for 7 days", price="$20/mo"),
dict(fam="r07-lumen-photo", brand="Lumen", industry="photo editor app", product="one-tap photo editing", aud="phone photographers with 4,000 unedited photos", aud_short="phone photographers", awareness="problem-aware", voice="minimalist", desire="4,000 photos edited before Sunday", desire_short="4,000 photos, done Sunday", pain="the editing backlog, presets that look orange, sliders with 40 options", mechanism="one-tap true-tone edits plus batch apply to the whole album", mech_short="true-tone batch", proof="3.1M photographers, 4.7 stars", stat="3.1M photographers", stat2="4.7 stars", timeframe="first edit in seconds", offer="free for 50 edits", price="$7/mo"),
dict(fam="r07-cloak-vpn", brand="Cloak", industry="VPN app", product="VPN for travelers", aud="travelers on hotel wifi", aud_short="travelers", awareness="problem-aware", voice="data-dry", desire="hotel wifi that can't see you", desire_short="invisible on hotel wifi", pain="the captive portal snooping, VPNs that halve your speed, 'free' VPNs selling data", mechanism="WireGuard protocol, audited no-logs, one tap", mech_short="audited WireGuard", proof="1.8M users, independent audit published", stat="1.8M users", stat2="audited no-logs", timeframe="protected in 60 seconds", offer="free for 7 days", price="$5/mo"),
dict(fam="r07-folio-books", brand="Folio", industry="book club app", product="book club app", aud="readers who never finish the pick", aud_short="lapsed readers", awareness="problem-aware", voice="playful-clear", desire="actually finishing the book club pick", desire_short="finish the pick", pain="the unread pick, scheduling 8 people, the meeting where nobody read", mechanism="paced reading plans plus async discussion threads, 20 minutes a day", mech_short="paced async reading", proof="190,000 clubs, 4.6 stars", stat="190,000 clubs", stat2="4.6 stars", timeframe="first pick this week", offer="free for 1 club", price="$6/mo"),
dict(fam="r07-harlan-estate-law", brand="Harlan & Gray", industry="estate planning law", product="wills and trusts", aud="parents who keep postponing the will", aud_short="parents", awareness="problem-aware", voice="legal-precise", desire="a will that's done, signed, and filed — not 'almost done'", desire_short="a will that's actually done", pain="the will that's been 'almost done' for 3 years, online templates with no state review", mechanism="attorney-drafted, state-reviewed, flat fee — signed in two meetings", mech_short="two-meeting flat-fee wills", proof="3,400 families protected, 4.9 stars", stat="3,400 families", stat2="4.9 stars", timeframe="signed in 3 weeks", offer="free 30-minute consult", price="$1,200 flat"),
dict(fam="r07-clearledger-cpa", brand="ClearLedger CPA", industry="tax CPA", product="tax for freelancers", aud="freelancers dreading April", aud_short="freelancers", awareness="problem-aware", voice="legal-precise", desire="April without the panic or the surprise bill", desire_short="April, minus the panic", pain="the April scramble, quarterly estimates guessed, deductions left on the table", mechanism="quarterly check-ins plus a shared dashboard, so April is a non-event", mech_short="quarterly-checkin tax", proof="1,800 freelancers, $2.1M in found deductions last year", stat="1,800 freelancers", stat2="$2.1M found deductions", timeframe="onboarded this week", offer="free prior-year review", price="$250/mo"),
dict(fam="r07-tidybooks-bookkeeping", brand="TidyBooks", industry="bookkeeping", product="monthly bookkeeping", aud="founders doing books at midnight", aud_short="founders", awareness="problem-aware", voice="data-dry", desire="books closed by the 5th, every month", desire_short="closed by the 5th", pain="midnight bookkeeping, the tax-season shoebox, numbers you can't trust", mechanism="dedicated bookkeeper plus monthly close checklist, CPA-reviewed", mech_short="CPA-reviewed monthly close", proof="2,200 businesses, 4.8 stars", stat="2,200 businesses", stat2="4.8 stars", timeframe="caught up in 2 weeks", offer="first month free", price="$349/mo"),
dict(fam="r07-waypoint-wealth", brand="Waypoint Wealth", industry="financial advisor", product="flat-fee financial planning", aud="high earners with no plan", aud_short="high earners", awareness="problem-aware", voice="data-dry", desire="a plan that answers 'are we on track?'", desire_short="'are we on track?' — answered", pain="the 1% AUM fee, advice that means 'buy our funds', no straight answer", mechanism="flat-fee planning, no products sold, plan updated yearly", mech_short="flat-fee no-product planning", proof="640 families, $0 in product commissions", stat="640 families", stat2="$0 commissions", timeframe="plan in 30 days", offer="free intro call", price="$3,500/year flat"),
]

# Batch 4: pro services continued (8) + health/wellness (10) + education (6) + misc (2) = 26
BRIEFS += [
dict(fam="r07-nextchapter-career", brand="NextChapter", industry="career coaching", product="career coaching for mid-career professionals", aud="professionals stuck at the same level for 5 years", aud_short="stalled professionals", awareness="problem-aware", voice="coach-direct", desire="the promotion or the pivot, with a plan", desire_short="promoted or pivoted, planned", pain="5 years at the same level, applications into the void, no idea what executives want", mechanism="6-session sprint: positioning, narrative, target list, interview reps", mech_short="6-session positioning sprint", proof="1,100 clients, 73% landed a new role or promotion in 6 months", stat="1,100 clients", stat2="73% in 6 months", timeframe="sprint takes 6 weeks", offer="free 30-minute strategy call", price="$1,800"),
dict(fam="r07-sharpresume-resume", brand="SharpResume", industry="resume service", product="executive resumes", aud="executives whose resume is from 2016", aud_short="executives", awareness="problem-aware", voice="teacher-patient", desire="a resume that gets the interview", desire_short="resumes that get interviews", pain="the 2016 resume, ATS black holes, templates that all look the same", mechanism="writer interview plus ATS-tested format plus LinkedIn rewrite included", mech_short="interview-based rewrite", proof="4,600 resumes, 3.1x more interview callbacks (client-reported)", stat="4,600 resumes", stat2="3.1x callbacks", timeframe="delivered in 7 days", offer="free resume critique", price="$449"),
dict(fam="r07-compass-college", brand="Compass College Consulting", industry="college consulting", product="college admissions guidance", aud="parents navigating applications", aud_short="parents", awareness="problem-aware", voice="teacher-patient", desire="a list of schools that fit — and essays that sound like your kid", desire_short="the right list, real essays", pain="the 20-school scattershot, essays that sound like a brochure, deadline chaos", mechanism="fit-first list of 8-10 schools plus essay coaching, no ghostwriting", mech_short="fit-first list and coaching", proof="890 students, 91% admitted to a top-3 choice", stat="890 students", stat2="91% top-3 admit", timeframe="starts junior spring", offer="free 45-minute planning session", price="$4,500 package"),
dict(fam="r07-everafter-photo", brand="Everafter Photography", industry="wedding photographer", product="wedding photography", aud="couples who hate stiff posed photos", aud_short="couples", awareness="solution-aware", voice="old-school", desire="photos that feel like the day felt", desire_short="the day, as it felt", pain="the 2-hour posed session, a stranger directing your wedding, 900 identical photos", mechanism="documentary style, two photographers, 48-hour sneak peek", mech_short="documentary two-shooter", proof="340 weddings, 4.9 stars", stat="340 weddings", stat2="48-hour sneak peek", timeframe="booked 9 months out on average", offer="free engagement session with booking", price="$4,200"),
dict(fam="r07-momentum-coach", brand="Momentum", industry="business coaching", product="coaching for agency owners", aud="agency owners stuck at $30k months", aud_short="agency owners", awareness="problem-aware", voice="coach-direct", desire="breaking $30k months without working weekends", desire_short="past $30k, no weekends", pain="the $30k ceiling, feast-or-famine pipeline, doing all the delivery yourself", mechanism="12-week sprint: offer, pipeline, delivery — one metric per week", mech_short="12-week one-metric sprint", proof="320 owners, median +41% revenue in 6 months", stat="320 owners", stat2="+41% median revenue", timeframe="12 weeks", offer="free growth audit", price="$6,000"),
dict(fam="r07-brightline-cmo", brand="Brightline", industry="marketing consultant", product="fractional CMO for SMBs", aud="founders doing marketing between everything else", aud_short="founders", awareness="problem-aware", voice="founder-earnest", desire="marketing with an owner, not a task list", desire_short="marketing, owned", pain="the DIY marketing, agencies that report impressions, no one accountable for pipeline", mechanism="fractional CMO plus one growth experiment per week, pipeline-attributed", mech_short="one-experiment-a-week CMO", proof="45 companies, average 2.3x pipeline in 9 months", stat="45 companies", stat2="2.3x pipeline", timeframe="starts in 2 weeks", offer="free marketing audit", price="$4,000/mo"),
dict(fam="r07-studionorth-interior", brand="Studio North", industry="interior designer", product="full-service interior design", aud="homeowners who have pinned 400 rooms and bought nothing", aud_short="homeowners", awareness="problem-aware", voice="luxury-restraint", desire="a home that looks considered, not decorated", desire_short="considered, not decorated", pain="400 pins and no decisions, the beige rental feeling, contractors without a plan", mechanism="one concept, one procurement list, installed in a single week", mech_short="one-week install", proof="140 homes, featured in 12 publications", stat="140 homes", stat2="12 publications", timeframe="installed in 1 week", offer="free discovery call", price="starts $15,000"),
dict(fam="r07-blueprint-arch", brand="Blueprint Studio", industry="architect", product="residential architecture", aud="families outgrowing their house", aud_short="families", awareness="solution-aware", voice="craftsman", desire="an addition that looks original to the house", desire_short="looks original", pain="the boxy addition, plans that ignore how you live, bids that double", mechanism="3D model before permits, fixed-fee design, builder-ready drawings", mech_short="3D-before-permits", proof="95 homes, 4.9 stars", stat="95 homes", stat2="4.9 stars", timeframe="drawings in 8 weeks", offer="free feasibility call", price="fixed fee quoted upfront"),
dict(fam="r07-restore-pt", brand="Restore PT", industry="physical therapy", product="physical therapy for runners", aud="runners sidelined by knee pain", aud_short="runners", awareness="problem-aware", voice="coach-direct", desire="running 10 miles without thinking about your knee", desire_short="10 miles, no knee thoughts", pain="the knee that ends runs at mile 3, generic exercise printouts, 6 weeks of ultrasound", mechanism="gait analysis plus strength plan, 1-on-1 for the full hour", mech_short="gait-analysis PT", proof="2,700 runners back on the road, 4.9 stars", stat="2,700 runners", stat2="4.9 stars", timeframe="most back in 6 weeks", offer="free injury screening", price="$150/session"),
dict(fam="r07-mindmend-therapy", brand="MindMend", industry="therapy directory", product="therapist matching", aud="adults who have meant to start therapy for a year", aud_short="adults", awareness="problem-aware", voice="parent-reassuring", desire="a therapist you actually click with, booked this week", desire_short="the right therapist, this week", pain="the directory scroll, 3 intake calls that go nowhere, waiting lists", mechanism="15-minute matching call plus vetted network, first session within 7 days", mech_short="matching-call placement", proof="18,000 matched, 87% stay past session 4", stat="18,000 matched", stat2="87% stay past 4", timeframe="first session within 7 days", offer="free 15-minute matching call", price="most insurance accepted"),
dict(fam="r07-ironworks-gym", brand="IronWorks", industry="gym", product="strength gym for adults 40+", aud="adults 40+ intimidated by big-box gyms", aud_short="adults 40+", awareness="problem-aware", voice="coach-direct", desire="stronger at 50 than at 40", desire_short="stronger at 50", pain="the 22-year-old gym bros, machines with no instruction, memberships you never use", mechanism="coach-led small groups, 3x/week, programming done for you", mech_short="coach-led small groups", proof="1,900 members, 81% still training after a year", stat="1,900 members", stat2="81% year-1 retention", timeframe="first session free", offer="free intro session and assessment", price="$229/mo"),
dict(fam="r07-stillwater-yoga", brand="Stillwater Yoga", industry="yoga studio", product="beginner yoga", aud="stiff beginners afraid of the pretzel class", aud_short="beginners", awareness="problem-aware", voice="teacher-patient", desire="touching your toes without embarrassment", desire_short="toes, no embarrassment", pain="the pretzel class, the mirror wall, memberships with 40-page contracts", mechanism="true-beginner series, 6 weeks, max 12 students, no mirrors", mech_short="true-beginner series", proof="3,400 beginners graduated, 4.9 stars", stat="3,400 beginners", stat2="4.9 stars", timeframe="6-week series", offer="first class $15", price="$149/mo"),
dict(fam="r07-nourish-prep", brand="Nourish Prep", industry="meal prep service", product="healthy meal delivery", aud="professionals eating takeout 5 nights a week", aud_short="professionals", awareness="problem-aware", voice="neighborly", desire="a fridge that feeds you well all week", desire_short="fed well all week", pain="the 5-night takeout, wilted meal kits, 'healthy' with 900mg sodium", mechanism="chef-cooked, dietitian macros, delivered Sunday in glass", mech_short="chef-and-dietitian weekly", proof="9,500 subscribers, 4.7 stars", stat="9,500 subscribers", stat2="4.7 stars", timeframe="first delivery Sunday", offer="first week 30% off", price="$11/meal"),
dict(fam="r07-dailyd-vitamin", brand="Daily D", industry="vitamin subscription", product="vitamin D and K2", aud="adults with low winter energy", aud_short="adults", awareness="problem-aware", voice="clinical-warm", desire="winter without the 3pm slump", desire_short="no 3pm slump", pain="the 3pm slump, bottles you forget, doses guessed from the internet", mechanism="D3+K2 in the studied dose, daily packets, third-party tested", mech_short="studied-dose daily packets", proof="120,000 subscribers, 4.6 stars", stat="120,000 subscribers", stat2="third-party tested", timeframe="ships monthly", offer="first month $12", price="$24/mo"),
dict(fam="r07-knead-massage", brand="Knead", industry="massage", product="therapeutic massage", aud="desk workers with concrete shoulders", aud_short="desk workers", awareness="problem-aware", voice="clinical-warm", desire="shoulders that don't live by your ears", desire_short="shoulders back down", pain="the concrete shoulders, spa massages that tickle, no-shows on booking", mechanism="60-minute therapeutic sessions, same therapist each visit, treatment notes kept", mech_short="same-therapist treatment", proof="14,000 sessions a year, 4.9 stars", stat="14,000 sessions/year", stat2="4.9 stars", timeframe="booked this week", offer="first session $79", price="$120/session"),
dict(fam="r07-harbor-acupuncture", brand="Harbor Acupuncture", industry="acupuncture", product="acupuncture for chronic pain", aud="pain patients who have tried everything", aud_short="chronic pain patients", awareness="solution-aware", voice="clinical-warm", desire="a pain-free morning without another prescription", desire_short="mornings without the ache", pain="the prescription merry-go-round, PT that plateaued, being told to live with it", mechanism="assessment-first treatment plans, 8-session protocols, progress measured", mech_short="measured 8-session protocols", proof="5,200 patients, 78% report meaningful relief by session 6", stat="5,200 patients", stat2="78% relief by session 6", timeframe="plan set at visit 1", offer="free 20-minute consultation", price="$95/session"),
dict(fam="r07-steadfast-weight", brand="Steadfast", industry="weight-loss program", product="physician-supervised weight loss", aud="adults who have yo-yo'd for a decade", aud_short="adults", awareness="problem-aware", voice="clinical-warm", desire="losing it once, with a doctor watching the labs", desire_short="lose it once, supervised", pain="the decade of yo-yo, programs that shame, weight that returns with interest", mechanism="physician supervision plus labs quarterly plus habits coaching, no crash diets", mech_short="physician, labs, and coaching", proof="3,800 patients, average 11% body weight at 12 months", stat="3,800 patients", stat2="11% avg at 12 months", timeframe="12-month program", offer="free consultation and labs review", price="$299/mo"),
dict(fam="r07-goldenyears-seniorcare", brand="Golden Years", industry="senior care", product="in-home senior care", aud="families worried about mom living alone", aud_short="families", awareness="problem-aware", voice="parent-reassuring", desire="mom safe at home, and you sleeping at night", desire_short="safe at home, sleep at night", pain="the 2am worry, caregivers who don't show, agencies that send strangers", mechanism="same vetted caregiver every visit, family app with visit notes", mech_short="same-caregiver and family app", proof="1,200 families, 4.9 stars", stat="1,200 families", stat2="4.9 stars", timeframe="care starts this week", offer="free in-home assessment", price="$32/hour"),
dict(fam="r07-summa-tutoring", brand="Summa Tutoring", industry="tutoring", product="math tutoring", aud="parents watching grades slip", aud_short="parents", awareness="problem-aware", voice="teacher-patient", desire="a kid who says math 'clicked'", desire_short="'math clicked'", pain="the slipping grades, homework battles, tutors who just do the homework", mechanism="diagnostic first, then a plan that rebuilds the missing rungs", mech_short="diagnostic-first plans", proof="2,900 students, average +1.4 grade levels in a semester", stat="2,900 students", stat2="+1.4 grade levels", timeframe="plan set week 1", offer="free diagnostic session", price="$85/session"),
dict(fam="r07-apex-testprep", brand="Apex Test Prep", industry="test prep", product="SAT prep", aud="juniors with an 1180 and a dream school", aud_short="juniors", awareness="problem-aware", voice="coach-direct", desire="a score that opens the dream school's door", desire_short="the score that opens doors", pain="the 1180 plateau, $200/hour tutors with no plan, practice tests with no review", mechanism="adaptive drills plus full test review, 8-week program, score guarantee terms in writing", mech_short="adaptive-drill program", proof="6,400 students, average +210 points", stat="6,400 students", stat2="+210 avg points", timeframe="8 weeks", offer="free practice test and review", price="$1,400"),
dict(fam="r07-shipit-bootcamp", brand="ShipIt", industry="coding bootcamp", product="bootcamp for career switchers", aud="adults 30+ switching careers", aud_short="career switchers", awareness="problem-aware", voice="teacher-patient", desire="a junior dev job, not just a certificate", desire_short="the job, not the certificate", pain="the $20k gamble, tutorial hell, 'job-ready' with no portfolio", mechanism="build 4 shipped projects plus interview prep with hiring managers", mech_short="4-shipped-projects method", proof="1,700 grads, 82% hired in 6 months", stat="1,700 grads", stat2="82% hired in 6 months", timeframe="24 weeks", offer="free intro weekend", price="$14,500"),
dict(fam="r07-keys-music", brand="Keys", industry="music lessons", product="piano for kids", aud="parents of kids who quit in 3 months", aud_short="parents", awareness="problem-aware", voice="teacher-patient", desire="a kid who practices without being told", desire_short="practices unprompted", pain="the 3-month quit, scales with no songs, teachers who cancel", mechanism="songs first, theory through the songs, recital every 10 weeks", mech_short="songs-first method", proof="1,300 students, 76% still playing after a year", stat="1,300 students", stat2="76% year-1 retention", timeframe="first song in 3 weeks", offer="free trial lesson", price="$180/mo"),
dict(fam="r07-roadready-driving", brand="RoadReady", industry="driving school", product="teen driving lessons", aud="parents white-knuckling the passenger seat", aud_short="parents", awareness="problem-aware", voice="parent-reassuring", desire="a teen you'd trust with the car", desire_short="trust them with the car", pain="the white-knuckle lessons, 40 hours of arguments, the DMV mystery", mechanism="certified instructors, dual-control cars, DMV test route practice", mech_short="dual-control and test-route practice", proof="9,800 teens licensed, 94% first-try pass", stat="9,800 teens", stat2="94% first-try pass", timeframe="done in 6 weeks", offer="free parent info session", price="$549"),
dict(fam="r07-firstaid-first", brand="FirstAid First", industry="first-aid training", product="workplace first-aid certification", aud="office managers facing compliance deadlines", aud_short="office managers", awareness="problem-aware", voice="teacher-patient", desire="a compliant team that could actually help", desire_short="compliant and capable", pain="the compliance deadline, the 4-hour click-through nobody remembers", mechanism="hands-on manikin practice, groups of 12, cert cards same day", mech_short="hands-on small groups", proof="22,000 certified, 4.9 stars", stat="22,000 certified", stat2="same-day cards", timeframe="half-day course", offer="free quote for on-site", price="$89/person"),
dict(fam="r07-cornerstone-mortgage", brand="Cornerstone", industry="mortgage broker", product="first-time buyer mortgages", aud="renters watching rates", aud_short="renters", awareness="solution-aware", voice="neighborly", desire="a payment you understand before you sign", desire_short="a payment you understand", pain="the rate-quote maze, junk fees at closing, pre-approvals that evaporate", mechanism="one application, 40+ lenders shopped, fee worksheet before you commit", mech_short="40-lender shop", proof="4,100 families housed, 4.9 stars", stat="4,100 families", stat2="40+ lenders", timeframe="pre-approved in 24 hours", offer="free rate review of any quote", price="no broker fee on most loans"),
dict(fam="r07-shelterline-insurance", brand="Shelterline", industry="insurance agency", product="home and auto bundling", aud="homeowners overpaying on separate policies", aud_short="homeowners", awareness="problem-aware", voice="neighborly", desire="one agent, one bill, no gaps", desire_short="one bill, no gaps", pain="the renewal creep, the gap you find after the claim, 1-800 hold music", mechanism="annual coverage review plus 12 carriers shopped, local agent answers", mech_short="annual 12-carrier review", proof="7,600 households, average $612/year saved", stat="7,600 households", stat2="$612 avg saved", timeframe="quoted in a day", offer="free coverage review", price="free review, obviously"),
]

assert len(BRIEFS) == 100, f"expected 100 briefs, got {len(BRIEFS)}"
FAMS = [b["fam"] for b in BRIEFS]
assert len(set(FAMS)) == 100, "duplicate family slugs"
