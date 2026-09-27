// Marketr — Phase 11 "Canvas": curated template pack copy banks.
// REAL marketing copy per use case. Never lorem ipsum. Written for actual
// marketers to ship with light edits (swap brand, tune the offer).

import type {
  CopyBeforeAfter, CopyChecklist, CopyQuote, CopyStat, CopyStd, CopyTestimonial,
} from "./layouts";

export interface TypeBanks {
  standard?: CopyStd[];
  quote?: CopyQuote[];
  testimonial?: CopyTestimonial[];
  stat?: CopyStat[];
  checklist?: CopyChecklist[];
  beforeafter?: CopyBeforeAfter[];
}

export const COPY: Record<string, TypeBanks> = {
  "instagram-post": {
    standard: [
      { eyebrow: "MARKETR PLAYBOOK", headline: "Turn followers into customers", sub: "Content that compounds — a growth engine that runs while you sleep.", cta: "Start growing" },
      { eyebrow: "GROWTH TIP #12", headline: "Post less. Convert more.", sub: "One sharp idea beats ten forgettable posts. Make every pixel earn its place.", cta: "Get the playbook" },
      { eyebrow: "NEW ON THE BLOG", headline: "The 5-minute content audit", sub: "Find the leaks in your funnel before they cost you another month.", cta: "Read the guide" },
      { eyebrow: "CLIENT WIN", headline: "3.2x ROAS in 30 days", sub: "No hacks. Just sharper creative, tighter targeting, and relentless testing.", cta: "See how" },
      { eyebrow: "COMING SOON", headline: "Something big is brewing", sub: "We're putting the finishing touches on our biggest launch yet.", cta: "Join the waitlist" },
      { eyebrow: "DID YOU KNOW?", headline: "80% of ad spend is wasted", sub: "Most brands can't tell which half works. We fixed that.", cta: "Fix my funnel" },
      { eyebrow: "MEET THE TEAM", headline: "Built by operators, not gurus", sub: "We've spent $40M of our own money learning what actually converts.", cta: "Work with us" },
      { eyebrow: "FREE RESOURCE", headline: "The launch checklist", sub: "47 steps we run before every launch. Steal it.", cta: "Download free" },
      { eyebrow: "WEBINAR REPLAY", headline: "We broke down a $1M funnel", sub: "Watch the exact teardown — every page, every email, every number.", cta: "Watch now" },
      { eyebrow: "QUICK WIN", headline: "Double your email list", sub: "The popup playbook that added 12,000 subscribers in 90 days.", cta: "Steal the playbook" },
      { eyebrow: "BEHIND THE SCENES", headline: "How we plan a quarter", sub: "Our exact planning ritual: 90 days, 3 bets, 1 scoreboard.", cta: "Copy the system" },
      { eyebrow: "LAST CHANCE", headline: "Doors close Friday", sub: "Founding pricing disappears this week. Lock it in or pay full price later.", cta: "Claim my spot" },
    ],
  },
  "instagram-story": {
    standard: [
      { eyebrow: "SWIPE UP", headline: "Your marketing, on autopilot", sub: "One workspace for SEO, content, and campaigns.", cta: "Learn more" },
      { eyebrow: "NEW DROP", headline: "Templates that sell", sub: "200+ designs built for one job: conversions.", cta: "Browse the pack" },
      { eyebrow: "FLASH SALE", headline: "40% off ends tonight", sub: "Annual plans only. No code needed.", cta: "Shop the sale" },
      { eyebrow: "TODAY ONLY", headline: "Free audit Friday", sub: "We review 5 funnels live. First come, first served.", cta: "Grab a slot" },
      { eyebrow: "PRO TIP", headline: "Hook in 3 seconds", sub: "If your first line doesn't stop the scroll, nothing else matters.", cta: "Get more tips" },
      { eyebrow: "ANNOUNCEMENT", headline: "We're hiring", sub: "Join the team building the marketing OS.", cta: "See open roles" },
      { eyebrow: "COUNTDOWN", headline: "3 days to launch", sub: "The biggest thing we've ever shipped drops Monday.", cta: "Notify me" },
      { eyebrow: "TESTIMONIAL", headline: "\u201CIt paid for itself in a week\u201D", sub: "Dana, founder @ Brightline — read her story.", cta: "Read the story" },
      { eyebrow: "REMINDER", headline: "Webinar starts in 1 hour", sub: "Bring questions. Leave with a plan.", cta: "Save my seat" },
      { eyebrow: "NEW VIDEO", headline: "I tested 100 ads", sub: "So you don't have to. The winners shocked me.", cta: "Watch now" },
    ],
  },
  "x-post": {
    standard: [
      { eyebrow: "THE GROWTHOS LOOP", headline: "Ship it. Measure it. Scale it.", sub: "Every launch becomes a learning loop that compounds.", cta: "Get Marketr" },
      { eyebrow: "UNPOPULAR OPINION", headline: "Impressions are vanity", sub: "Pipeline is sanity. Optimize for revenue, not reach.", cta: "Read the thread" },
      { eyebrow: "SHIPPED", headline: "v2.4 is live", sub: "Faster exports, smarter templates, zero new seats to buy.", cta: "See what's new" },
      { eyebrow: "HOT TAKE", headline: "Your funnel isn't broken", sub: "Your offer is. Fix the promise before the pixels.", cta: "Steal the framework" },
      { eyebrow: "DATA DROP", headline: "We analyzed 1,000 ads", sub: "The winners all share 3 traits. Here's the breakdown.", cta: "Read the study" },
      { eyebrow: "PSA", headline: "Stop boosting posts", sub: "Boosted posts are a tax on laziness. Run real campaigns instead.", cta: "Learn the right way" },
      { eyebrow: "MILESTONE", headline: "10,000 makers and counting", sub: "You built the marketing OS with us. Thank you.", cta: "Join them" },
      { eyebrow: "QUESTION", headline: "What's your CAC?", sub: "If you can't answer in 5 seconds, that's the problem.", cta: "Fix it free" },
    ],
  },
  "facebook-post": {
    standard: [
      { eyebrow: "KNOW YOUR NUMBERS", headline: "Marketing that pays for itself", sub: "Know which dollar drove which customer — then double down.", cta: "See how it works" },
      { eyebrow: "LOCAL LOVE", headline: "Greensboro, we're here", sub: "Free marketing audits for Triad small businesses this month.", cta: "Book yours" },
      { eyebrow: "CASE STUDY", headline: "From $8k to $41k/mo", sub: "How one clinic fixed their funnel in 60 days.", cta: "Read the story" },
      { eyebrow: "FREE WORKSHOP", headline: "SEO basics, live", sub: "Bring your laptop. Leave with a 90-day plan.", cta: "Reserve a seat" },
      { eyebrow: "NEW SERVICE", headline: "Done-for-you content", sub: "We write, design, and publish. You approve.", cta: "Get a quote" },
      { eyebrow: "COMMUNITY", headline: "500 members strong", sub: "Our free group for founders doing their own marketing.", cta: "Join free" },
      { eyebrow: "LIMITED OFFER", headline: "First month 50% off", sub: "Full-service management at half price. This month only.", cta: "Claim the offer" },
      { eyebrow: "TIP TUESDAY", headline: "Answer one question", sub: "\u201CWhat problem do you solve?\u201D — put it above the fold.", cta: "More tips" },
    ],
  },
  "linkedin-post": {
    standard: [
      { eyebrow: "PIPELINE, NOT IMPRESSIONS", headline: "Pipeline, not just impressions", sub: "The growth system serious operators use to hit their number.", cta: "Book a demo" },
      { eyebrow: "LESSONS LEARNED", headline: "I wasted $200k on ads", sub: "Here's the 5-slide postmortem so you don't have to.", cta: "Read the breakdown" },
      { eyebrow: "WE'RE HIRING", headline: "Growth lead, remote-first", sub: "Outcomes over hours. Know someone great?", cta: "See the role" },
      { eyebrow: "FRAMEWORK", headline: "The 3-bucket budget", sub: "70% proven, 20% promising, 10% experimental. Never guess again.", cta: "Get the template" },
      { eyebrow: "HOT TAKE", headline: "Brand is a lagging indicator", sub: "Revenue is the leading one. Build the engine first.", cta: "Debate me" },
      { eyebrow: "PLAYBOOK", headline: "How we 4x'd demo bookings", sub: "Landing page, offer, and follow-up — the exact sequence.", cta: "Steal the playbook" },
      { eyebrow: "MILESTONE", headline: "$10M in client revenue driven", sub: "Grateful for the operators who trusted the process.", cta: "Work with us" },
      { eyebrow: "PREDICTION", headline: "2027: the generalist dies", sub: "T-shaped operators with AI leverage win. Here's the skill stack.", cta: "Read more" },
    ],
  },
  "youtube-thumbnail": {
    standard: [
      { eyebrow: "NEW VIDEO", headline: "I Tested 100 Ads", sub: "The winners shocked me.", cta: "Watch now" },
      { eyebrow: "EXPOSED", headline: "$0 Marketing Strategy", sub: "No budget. 10k subscribers.", cta: "Watch now" },
      { eyebrow: "TUTORIAL", headline: "SEO in 12 Minutes", sub: "Rank #1 with this workflow.", cta: "Watch now" },
      { eyebrow: "CASE STUDY", headline: "$0 to $50k/mo", sub: "The funnel, step by step.", cta: "Watch now" },
      { eyebrow: "MISTAKES", headline: "7 Ad Fails", sub: "Don't make mistake #4.", cta: "Watch now" },
      { eyebrow: "LIVE FRIDAY", headline: "Growth Q&A", sub: "Ask me anything.", cta: "Set reminder" },
      { eyebrow: "REVIEW", headline: "I Tried Every AI Tool", sub: "Only 3 are worth it.", cta: "Watch now" },
      { eyebrow: "CHALLENGE", headline: "30 Days, 30 Posts", sub: "Here's what happened.", cta: "Watch now" },
      { eyebrow: "BREAKDOWN", headline: "Why This Ad Works", sub: "Frame-by-frame teardown.", cta: "Watch now" },
      { eyebrow: "START HERE", headline: "Marketing from Zero", sub: "The beginner's guide.", cta: "Watch now" },
    ],
  },
  "x-header": {
    standard: [
      { eyebrow: "MARKETR", headline: "The marketing OS for growth", sub: "SEO, content, and campaigns in one agentic workspace." },
      { eyebrow: "LAUNCHABL", headline: "We build growth engines", sub: "Marketing agency + SaaS studio for ambitious founders." },
      { eyebrow: "YOUR TAGLINE", headline: "Say what you do in 8 words", sub: "Replace this with your sharpest one-liner." },
      { eyebrow: "GROWTH, ON AUTOPILOT", headline: "Systems that compound", sub: "Content, SEO, and campaigns running while you sleep." },
      { eyebrow: "BUILT FOR OPERATORS", headline: "Not gurus. Not theorists.", sub: "Tools forged on real ad spend." },
      { eyebrow: "FROM SCROLL TO SALE", headline: "Full-funnel creative", sub: "We design every touchpoint of the customer journey." },
    ],
  },
  "facebook-cover": {
    standard: [
      { eyebrow: "WELCOME", headline: "Marketing that pays for itself", sub: "Join 10,000+ founders growing with Marketr." },
      { eyebrow: "NEW HERE?", headline: "Start with the free playbook", sub: "The 90-day growth system, free forever." },
      { eyebrow: "COMMUNITY FIRST", headline: "500+ founders inside", sub: "Daily tactics, weekly teardowns, zero fluff." },
      { eyebrow: "THIS MONTH", headline: "Free funnel audits", sub: "We're reviewing 20 funnels live. Claim your slot." },
      { eyebrow: "OUR PROMISE", headline: "Pipeline, not impressions", sub: "If it doesn't drive revenue, we don't ship it." },
      { eyebrow: "EST. 2026", headline: "Built in the open", sub: "Follow the journey — wins, losses, and numbers." },
    ],
  },
  "linkedin-banner": {
    standard: [
      { eyebrow: "OPERATOR · BUILDER · FOUNDER", headline: "Your Name", sub: "Building the marketing OS at Marketr." },
      { eyebrow: "OPEN TO WORK", headline: "Growth leadership", sub: "I turn ad spend into pipeline. Let's talk." },
      { eyebrow: "FOUNDER", headline: "Launchabl — Growth Agency", sub: "We build growth engines for ambitious companies." },
      { eyebrow: "AUTHOR", headline: "The GrowthOS Playbook", sub: "Systems over hacks. Compounding over campaigns." },
      { eyebrow: "ADVISOR", headline: "I help SaaS founders scale", sub: "3 exits. $40M managed. Zero fluff." },
      { eyebrow: "SPEAKER", headline: "I talk about growth", sub: "Book me for your stage or podcast." },
    ],
  },
  "pinterest-pin": {
    standard: [
      { eyebrow: "SAVE THIS", headline: "The 10-minute SEO checklist", sub: "Pin it. Run it monthly. Watch traffic climb.", cta: "Get the PDF" },
      { eyebrow: "INFOGRAPHIC", headline: "Funnel math, visualized", sub: "Know your numbers before you spend a dollar.", cta: "Learn more" },
      { eyebrow: "RECIPE", headline: "The perfect landing page", sub: "7 ingredients, one conversion goal.", cta: "Steal the recipe" },
      { eyebrow: "GUIDE", headline: "Content pillars 101", sub: "Never stare at a blank calendar again.", cta: "Read the guide" },
      { eyebrow: "CHECKLIST", headline: "Launch day essentials", sub: "23 things to check before you hit publish.", cta: "Download free" },
      { eyebrow: "BEFORE & AFTER", headline: "Website redesign", sub: "Same traffic, 3x conversions. Here's what changed.", cta: "See the teardown" },
      { eyebrow: "TUTORIAL", headline: "Design basics, no talent needed", sub: "Good design is a system, not a gift.", cta: "Learn the system" },
      { eyebrow: "ROUNDUP", headline: "50 free marketing tools", sub: "The only list you'll ever need. Save it.", cta: "Browse the list" },
    ],
  },
  "tiktok-cover": {
    standard: [
      { eyebrow: "PART 3", headline: "The $0 strategy", sub: "Watch the series from the start.", cta: "Follow for more" },
      { eyebrow: "POV", headline: "Your ads finally work", sub: "When the ROAS hits 4x.", cta: "Follow for more" },
      { eyebrow: "STORYTIME", headline: "How I lost $10k", sub: "So you don't have to.", cta: "Follow for more" },
      { eyebrow: "TUTORIAL", headline: "Do this, not that", sub: "Landing pages edition.", cta: "Follow for more" },
      { eyebrow: "DAY 12", headline: "Building in public", sub: "The marketing OS, live.", cta: "Follow the journey" },
      { eyebrow: "REPLYING", headline: "To your comments", sub: "Your questions, answered.", cta: "Follow for more" },
    ],
  },
  "blog-hero": {
    standard: [
      { eyebrow: "THE GROWTHOS PLAYBOOK", headline: "Build marketing that compounds", sub: "Field notes on turning campaigns into a growth system.", cta: "Read the guide" },
      { eyebrow: "DEEP DIVE", headline: "Anatomy of a $1M launch", sub: "Every email, ad, and landing page — annotated.", cta: "Read the teardown" },
      { eyebrow: "RESEARCH", headline: "We studied 1,000 homepages", sub: "6 patterns separate converters from bouncers.", cta: "See the data" },
      { eyebrow: "OPINION", headline: "The agency model is broken", sub: "Retainers reward hours, not outcomes. There's a better way.", cta: "Read the take" },
      { eyebrow: "HOW-TO", headline: "Ship your first campaign", sub: "From brief to launch in one focused weekend.", cta: "Start the guide" },
      { eyebrow: "INTERVIEW", headline: "\u201CWe 10x'd with boring basics\u201D", sub: "A founder on doing less, better.", cta: "Read the interview" },
    ],
  },
  "og-image": {
    standard: [
      { eyebrow: "MARKETR", headline: "The marketing OS for growth", sub: "SEO, content, and campaigns in one agentic workspace.", cta: "Get started free" },
      { eyebrow: "GROWTHOS", headline: "Turn marketing into a system", sub: "The operating system for compounding growth.", cta: "Learn more" },
      { eyebrow: "FREEMIUM", headline: "Start free, scale when ready", sub: "No credit card. No sales call.", cta: "Start free" },
      { eyebrow: "PLAYBOOK", headline: "The 90-day growth plan", sub: "Free forever. Yours in one click.", cta: "Get the playbook" },
      { eyebrow: "MANIFESTO", headline: "Marketing is just the bait", sub: "People want money and customers. We build the engine.", cta: "Read the manifesto" },
      { eyebrow: "WEBINAR", headline: "The funnel teardown, live", sub: "Real numbers. Real mistakes. Real fixes.", cta: "Save my seat" },
    ],
  },
  "email-header": {
    standard: [
      { eyebrow: "THE GROWTH BRIEF", headline: "This week's growth wins", sub: "Your weekly marketing intelligence, distilled.", cta: "Read now" },
      { eyebrow: "MONTHLY METRICS", headline: "September by the numbers", sub: "Opens, clicks, and what we're testing next." },
      { eyebrow: "PRODUCT UPDATE", headline: "What's new in Marketr", sub: "Faster exports, 200+ templates, zero new seats.", cta: "See what's new" },
      { eyebrow: "LAUNCH WEEK", headline: "Day 3: the offer", sub: "Today's the day we open the doors.", cta: "Get access" },
      { eyebrow: "FOUNDER'S NOTE", headline: "A quick word from Tico", sub: "Where we're headed — and why it matters for you." },
      { eyebrow: "SALE ENDS", headline: "Tonight at midnight", sub: "Last call for 40% off annual plans.", cta: "Shop now" },
      { eyebrow: "WELCOME", headline: "You're in. Here's what's next.", sub: "Three steps to your first win this week.", cta: "Start here" },
      { eyebrow: "WE MISS YOU", headline: "Here's 20% off to return", sub: "Come back and finish what you started.", cta: "Claim 20% off" },
    ],
  },
  "newsletter-header": {
    standard: [
      { eyebrow: "EVERY SUNDAY", headline: "The Sunday Systems", sub: "One idea for founders. Five-minute read." },
      { eyebrow: "WEEKLY", headline: "Compound", sub: "One tactic, one teardown, one number that matters." },
      { eyebrow: "FOR OPERATORS", headline: "The Operator", sub: "No fluff. Just what worked this week." },
      { eyebrow: "EVERY TUESDAY", headline: "First Principles", sub: "Marketing, deconstructed. The why behind the what." },
      { eyebrow: "3 LINKS", headline: "Signal / Noise", sub: "Three links worth your time. Nothing else." },
      { eyebrow: "THE LONG GAME", headline: "Play it well", sub: "Compounding lessons for patient builders." },
    ],
  },
  "podcast-cover": {
    standard: [
      { eyebrow: "WEEKLY", headline: "Growth Operators", sub: "Real tactics, no gurus." },
      { eyebrow: "EVERY TUESDAY", headline: "The Compound Effect", sub: "Marketing that stacks." },
      { eyebrow: "FOUNDERS TALK", headline: "Ship It", sub: "Conversations with people who launch." },
      { eyebrow: "TEARDOWNS", headline: "Funnel Vision", sub: "See what converts." },
      { eyebrow: "BOOTSTRAPPED", headline: "Zero to Revenue", sub: "Honest stories from self-funded founders." },
      { eyebrow: "THE LONG GAME", headline: "Patience as Strategy", sub: "Think in decades, ship in weeks." },
    ],
  },
  "ebook-cover": {
    standard: [
      { eyebrow: "FREE EBOOK", headline: "The GrowthOS Playbook", sub: "The 90-day system for compounding growth.", cta: "Download free" },
      { eyebrow: "THE GUIDE", headline: "1,000 Ads Analyzed", sub: "What the winners have in common.", cta: "Get the report" },
      { eyebrow: "MANIFESTO", headline: "Marketing Is the Bait", sub: "A field manual for revenue-obsessed founders.", cta: "Read free" },
      { eyebrow: "PLAYBOOK", headline: "The Launch Checklist", sub: "47 steps before you ship anything.", cta: "Download free" },
      { eyebrow: "RESEARCH", headline: "State of SMB Marketing 2026", sub: "2,400 founders surveyed. The data surprised us.", cta: "Get the data" },
      { eyebrow: "HANDBOOK", headline: "The AI Operator's Manual", sub: "Doing 10x the work with AI leverage.", cta: "Download free" },
    ],
  },
  "ad-square": {
    standard: [
      { eyebrow: "STOP GUESSING", headline: "Stop guessing. Start growing.", sub: "AI-powered marketing that shows its work.", cta: "Start free trial" },
      { eyebrow: "SALE", headline: "40% off everything", sub: "Annual plans. Ends Sunday. No code needed.", cta: "Shop the sale" },
      { eyebrow: "NEW", headline: "Meet Marketr 2.0", sub: "200+ templates. Batch variants. Brand-aware AI.", cta: "See what's new" },
      { eyebrow: "FREE TRIAL", headline: "14 days, no card", sub: "Full power from minute one. Cancel anytime.", cta: "Start free" },
      { eyebrow: "WEBINAR", headline: "Free: the funnel teardown", sub: "Live Thursday. Bring your numbers.", cta: "Save my seat" },
      { eyebrow: "EBOOK", headline: "Free: 1,000 ads analyzed", sub: "Steal what works. Skip what doesn't.", cta: "Download free" },
      { eyebrow: "DEMO", headline: "See it in action", sub: "20 minutes. Your questions, answered live.", cta: "Book a demo" },
      { eyebrow: "QUIZ", headline: "What's your growth stage?", sub: "2 minutes. Get your custom roadmap.", cta: "Take the quiz" },
      { eyebrow: "BUNDLE", headline: "The starter stack", sub: "Templates + playbook + audit. One price.", cta: "Get the bundle" },
      { eyebrow: "GUARANTEE", headline: "Pipeline in 90 days", sub: "Or we work free until it does.", cta: "See the terms" },
    ],
  },
  "ad-story": {
    standard: [
      { eyebrow: "YOUR UNFAIR ADVANTAGE", headline: "Your unfair advantage", sub: "One workspace for SEO, content, and campaigns.", cta: "Try it free" },
      { eyebrow: "FLASH SALE", headline: "50% off ends midnight", sub: "The biggest discount we ever offer.", cta: "Shop now" },
      { eyebrow: "LAST CHANCE", headline: "Cart closes tonight", sub: "Doors shut at midnight. No extensions.", cta: "Enroll now" },
      { eyebrow: "NEW DROP", headline: "Just landed", sub: "Fresh templates, built to convert.", cta: "Browse new" },
      { eyebrow: "FREE GUIDE", headline: "The ad creative bible", sub: "120 pages. Zero fluff.", cta: "Download free" },
      { eyebrow: "CHALLENGE", headline: "30 days to 10k followers", sub: "Join 2,000 founders doing it with us.", cta: "Join free" },
      { eyebrow: "LIVE NOW", headline: "We're breaking down a funnel", sub: "Real numbers, right now.", cta: "Watch live" },
      { eyebrow: "WAITLIST", headline: "Founding members only", sub: "Lock lifetime pricing before we launch.", cta: "Join the waitlist" },
    ],
  },
  "sale-promo": {
    standard: [
      { eyebrow: "LIMITED TIME", headline: "50% OFF", sub: "Annual plans only. Ends Sunday at midnight.", cta: "Shop the sale", smallPrint: "New customers · Annual billing" },
      { eyebrow: "FLASH SALE", headline: "40% OFF", sub: "Everything. Today only. When it's gone, it's gone.", cta: "Shop now", smallPrint: "Excludes gift cards" },
      { eyebrow: "CLEARANCE", headline: "UP TO 70% OFF", sub: "Last pieces at their lowest prices ever.", cta: "Shop clearance", smallPrint: "Final sale · No returns" },
      { eyebrow: "HOLIDAY SALE", headline: "30% OFF SITEWIDE", sub: "Our gift to you — no code needed.", cta: "Start shopping", smallPrint: "Ends Dec 26" },
      { eyebrow: "BUNDLE & SAVE", headline: "BUY 2, GET 1 FREE", sub: "Stock up and save on all bestsellers.", cta: "Build my bundle", smallPrint: "Mix & match" },
      { eyebrow: "VIP EARLY ACCESS", headline: "25% OFF", sub: "Members shop first. Public sale starts Friday.", cta: "Shop early", smallPrint: "Members only" },
      { eyebrow: "STUDENT DISCOUNT", headline: "20% OFF", sub: "Verify once, save all year.", cta: "Verify status", smallPrint: "With valid student ID" },
      { eyebrow: "REFERRAL REWARD", headline: "GIVE 20%, GET 20%", sub: "Share your link. You both save.", cta: "Get my link", smallPrint: "Unlimited referrals" },
      { eyebrow: "PRICE DROP", headline: "NOW $49", sub: "Our best plan, at its best price ever.", cta: "Lock it in", smallPrint: "Limited quantities" },
      { eyebrow: "FREE SHIPPING", headline: "ORDERS OVER $50", sub: "No code. Applied automatically at checkout.", cta: "Start shopping", smallPrint: "US orders" },
    ],
  },
  "webinar-promo": {
    standard: [
      { eyebrow: "FREE WEBINAR", headline: "The $1M Funnel Teardown", sub: "Live Thursday 2pm ET. Real numbers, real fixes.", cta: "Save my seat" },
      { eyebrow: "LIVE WORKSHOP", headline: "SEO in 90 Minutes", sub: "Bring your laptop. Leave with a plan.", cta: "Reserve my spot" },
      { eyebrow: "MASTERCLASS", headline: "Ads That Convert", sub: "The creative framework behind 3.2x ROAS.", cta: "Register free" },
      { eyebrow: "PANEL", headline: "Founders on Fundraising", sub: "3 founders, 0 slides, all honesty.", cta: "Join the panel" },
      { eyebrow: "BOOTCAMP", headline: "Email List in a Weekend", sub: "From 0 to 1,000 subscribers, live.", cta: "Claim my seat" },
      { eyebrow: "SUMMIT", headline: "The Growth Summit 2026", sub: "20 speakers. 2 days. All killer.", cta: "Get my ticket" },
      { eyebrow: "DEMO DAY", headline: "See Marketr Live", sub: "30 minutes. Your questions answered.", cta: "Register now" },
      { eyebrow: "AMA", headline: "Ask Me Anything: Growth", sub: "No pitch. Just answers.", cta: "Submit questions" },
    ],
  },
  "product-launch": {
    standard: [
      { eyebrow: "INTRODUCING", headline: "Marketr 2.0 is here", sub: "200+ templates. Batch AI variants. Brand-aware everything.", cta: "See what's new" },
      { eyebrow: "NEW", headline: "The Template Pack drops today", sub: "200+ designs built for one job: conversions.", cta: "Browse the pack" },
      { eyebrow: "LAUNCH DAY", headline: "Compound is live", sub: "Growth, weekly. Issue #1 hits inboxes Sunday.", cta: "Subscribe free" },
      { eyebrow: "JUST SHIPPED", headline: "Batch variants are here", sub: "One brief \u2192 100 on-brand designs.", cta: "Try it now" },
      { eyebrow: "ANNOUNCING", headline: "The GrowthOS Playbook", sub: "Free forever. Yours in one click.", cta: "Get the playbook" },
      { eyebrow: "BIG NEWS", headline: "We're open source", sub: "AGPLv3. Self-host it. Extend it. It's yours.", cta: "Star on GitHub" },
      { eyebrow: "DROPPING SOON", headline: "Something's coming", sub: "Tuesday. 9am ET. Set your alarm.", cta: "Notify me" },
      { eyebrow: "NOW LIVE", headline: "The client portal", sub: "Approvals without the email thread.", cta: "Take the tour" },
    ],
  },
  "holiday-sale": {
    standard: [
      { eyebrow: "HOLIDAY SALE", headline: "30% off sitewide", sub: "Our gift to you. No code needed.", cta: "Start shopping" },
      { eyebrow: "BLACK FRIDAY", headline: "Up to 60% off", sub: "The lowest prices of the year. Today only.", cta: "Shop the deals" },
      { eyebrow: "CYBER MONDAY", headline: "Extra 20% off sale", sub: "Stack it on clearance. Ends midnight.", cta: "Shop now" },
      { eyebrow: "12 DAYS OF DEALS", headline: "Day 7: 40% off", sub: "A new deal drops daily until Christmas.", cta: "Reveal today's deal" },
      { eyebrow: "NEW YEAR", headline: "50% off annual", sub: "Start January with systems, not resolutions.", cta: "Claim the deal" },
      { eyebrow: "VALENTINE'S", headline: "Gifts they'll love", sub: "25% off everything romantic. Order by Feb 10.", cta: "Shop gifts" },
      { eyebrow: "BACK TO SCHOOL", headline: "20% off essentials", sub: "Students verify once, save all year.", cta: "Shop the sale" },
      { eyebrow: "SUMMER SALE", headline: "Up to 50% off", sub: "Sunshine prices on everything. While it lasts.", cta: "Dive in" },
    ],
  },
  "hiring-post": {
    standard: [
      { eyebrow: "WE'RE HIRING", headline: "Growth Lead", sub: "Remote-first · Outcomes over hours · $120–160k", cta: "Apply now" },
      { eyebrow: "JOIN US", headline: "Senior Designer", sub: "Build the marketing OS with us. Portfolio > pedigree.", cta: "See the role" },
      { eyebrow: "NOW HIRING", headline: "Content Strategist", sub: "You write. We distribute. Audiences grow.", cta: "Apply today" },
      { eyebrow: "WE'RE HIRING", headline: "Customer Success Rep", sub: "Help founders win. Work from anywhere.", cta: "Join the team" },
      { eyebrow: "OPEN ROLE", headline: "Founding Engineer", sub: "AGPLv3. Real ownership. Ship weekly.", cta: "Let's talk" },
      { eyebrow: "SUMMER '27", headline: "Growth Intern", sub: "Learn by shipping real campaigns.", cta: "Apply now" },
    ],
  },
  "event-invite": {
    standard: [
      { eyebrow: "YOU'RE INVITED", headline: "The Growth Summit 2026", sub: "Oct 14–15 · Raleigh, NC · 20 speakers", cta: "Get tickets" },
      { eyebrow: "SAVE THE DATE", headline: "Launch Party: Marketr 2.0", sub: "Nov 7 · 6pm · Raleigh Founded", cta: "RSVP free" },
      { eyebrow: "JOIN US", headline: "Founder Breakfast", sub: "First Fridays · 8am · Free coffee, real talk", cta: "Reserve a seat" },
      { eyebrow: "EXCLUSIVE", headline: "Client Appreciation Night", sub: "Dec 12 · Dinner's on us", cta: "RSVP now" },
      { eyebrow: "WORKSHOP", headline: "SEO Basics, Live", sub: "Sep 30 · 2pm ET · Bring your laptop", cta: "Save my spot" },
      { eyebrow: "MEETUP", headline: "Triangle Marketers", sub: "Monthly · Third Thursday · Free to attend", cta: "Join us" },
    ],
  },
  "testimonial-card": {
    testimonial: [
      { quote: "Marketr paid for itself in the first week. Our ROAS went from 1.4 to 3.2.", author: "Dana Whitfield", role: "Founder, Brightline Dental" },
      { quote: "It's like hiring a growth team that never sleeps. Pipeline is up 4x.", author: "Marcus Chen", role: "CEO, NorthPeak SaaS" },
      { quote: "We replaced three tools and two freelancers. The math was embarrassing.", author: "Priya Nair", role: "CMO, Bloom & Co" },
      { quote: "The batch variants feature alone is worth 10x the price. 100 ads in an afternoon.", author: "Jordan Ellis", role: "Growth Lead, Atlas Legal" },
      { quote: "Finally, software that speaks revenue instead of vanity metrics.", author: "Sofia Ramirez", role: "Founder, Fern Floral" },
      { quote: "Our approval cycle went from two weeks to two hours. Clients noticed.", author: "Tom Becker", role: "Owner, Copperline BBQ Group" },
      { quote: "I did in a weekend what used to take my agency a month.", author: "Aisha Bello", role: "Solo Founder, Loopwork" },
      { quote: "The only tool my whole team actually opened every day.", author: "David Okafor", role: "VP Marketing, Hexadigm" },
    ],
  },
  "quote-card": {
    quote: [
      { quote: "Marketing is just the bait — people want money and customers.", author: "The Marketr Playbook", role: "Chapter 1" },
      { quote: "Speed to distribution is the moat.", author: "The Marketr Playbook", role: "Chapter 2" },
      { quote: "Don't rush the build. Rush the learning.", author: "The Marketr Playbook", role: "Chapter 3" },
      { quote: "A confused mind never buys. Clarity converts.", author: "The Marketr Playbook", role: "Chapter 4" },
      { quote: "Content compounds. Campaigns expire. Build accordingly.", author: "The Marketr Playbook", role: "Chapter 5" },
      { quote: "Your funnel isn't broken — your offer is.", author: "The Marketr Playbook", role: "Chapter 6" },
      { quote: "Measure what matters, ignore what flatters.", author: "The Marketr Playbook", role: "Chapter 7" },
      { quote: "The best ad is a promise you can keep.", author: "The Marketr Playbook", role: "Chapter 8" },
    ],
  },
  "stat-card": {
    stat: [
      { eyebrow: "BY THE NUMBERS", headline: "Our year in review", stats: [{ value: "10,247", label: "customers" }, { value: "$12.4M", label: "revenue driven" }, { value: "4.1x", label: "avg ROAS" }], cta: "See the report" },
      { eyebrow: "THE RESULTS", headline: "Q3 growth report", stats: [{ value: "+212%", label: "pipeline" }, { value: "-38%", label: "CAC" }, { value: "96%", label: "retention" }], cta: "Read more" },
      { eyebrow: "PROOF", headline: "What compounding looks like", stats: [{ value: "50k", label: "subscribers" }, { value: "18 mo", label: "timeline" }, { value: "$0", label: "ad spend" }], cta: "Steal the system" },
      { eyebrow: "IMPACT", headline: "Client wins this quarter", stats: [{ value: "32", label: "launches" }, { value: "$2.1M", label: "attributed" }, { value: "4.6/5", label: "rating" }], cta: "Become next" },
      { eyebrow: "MILESTONE", headline: "10,000 makers", stats: [{ value: "40+", label: "countries" }, { value: "1.2M", label: "designs shipped" }, { value: "99.9%", label: "uptime" }], cta: "Join them" },
      { eyebrow: "BENCHMARKS", headline: "2026 ad report", stats: [{ value: "2.8%", label: "avg CTR" }, { value: "$1.12", label: "avg CPC" }, { value: "3.4x", label: "avg ROAS" }], cta: "Get the data" },
      { eyebrow: "GROWTH", headline: "From launch to scale", stats: [{ value: "6 mo", label: "timeline" }, { value: "10x", label: "traffic" }, { value: "1", label: "playbook" }], cta: "Copy the playbook" },
      { eyebrow: "EFFICIENCY", headline: "Do more with less", stats: [{ value: "-60%", label: "tool spend" }, { value: "+3x", label: "output" }, { value: "1", label: "workspace" }], cta: "See how" },
    ],
  },
  "case-study-card": {
    standard: [
      { eyebrow: "CASE STUDY", headline: "How Brightline 3.2x'd ROAS", sub: "Sharper creative, tighter targeting, relentless testing — in 90 days.", cta: "Read the story" },
      { eyebrow: "CASE STUDY", headline: "NorthPeak cut churn 28%", sub: "Onboarding emails and expansion plays that compounded for 6 months.", cta: "See the playbook" },
      { eyebrow: "CASE STUDY", headline: "Bloom & Co doubled AOV", sub: "Bundles, post-purchase upsells, and 120 days of iteration.", cta: "Steal the tactics" },
      { eyebrow: "CASE STUDY", headline: "Atlas Legal 5x'd consults", sub: "One landing page, one offer, one quarter of focused ad spend.", cta: "Get the teardown" },
      { eyebrow: "CASE STUDY", headline: "Fern Floral sold out twice", sub: "12,000 new subscribers from a waitlist funnel built in a weekend.", cta: "Copy the funnel" },
      { eyebrow: "CASE STUDY", headline: "Copperline BBQ franchised", sub: "14 new locations from catering-lead ads at 3.8x return.", cta: "See how" },
    ],
    stat: [
      { eyebrow: "CASE STUDY", headline: "Brightline Dental 3.2x'd ROAS", stats: [{ value: "3.2x", label: "ROAS" }, { value: "-41%", label: "CAC" }, { value: "90 days", label: "timeline" }], cta: "Read the story" },
      { eyebrow: "CASE STUDY", headline: "NorthPeak SaaS cut churn 28%", stats: [{ value: "-28%", label: "churn" }, { value: "+19%", label: "expansion" }, { value: "6 mo", label: "timeline" }], cta: "Read the story" },
      { eyebrow: "CASE STUDY", headline: "Bloom & Co doubled AOV", stats: [{ value: "2.1x", label: "AOV" }, { value: "+64%", label: "repeat rate" }, { value: "120 days", label: "timeline" }], cta: "Read the story" },
      { eyebrow: "CASE STUDY", headline: "Atlas Legal 5x'd consults", stats: [{ value: "5x", label: "consultations" }, { value: "-33%", label: "cost per lead" }, { value: "1 quarter", label: "timeline" }], cta: "Read the story" },
      { eyebrow: "CASE STUDY", headline: "Fern Floral sold out twice", stats: [{ value: "2", label: "sellouts" }, { value: "12k", label: "new subscribers" }, { value: "8 weeks", label: "timeline" }], cta: "Read the story" },
      { eyebrow: "CASE STUDY", headline: "Copperline BBQ franchised", stats: [{ value: "14", label: "new locations" }, { value: "3.8x", label: "catering leads" }, { value: "1 year", label: "timeline" }], cta: "Read the story" },
    ],
  },
  "before-after": {
    beforeafter: [
      { eyebrow: "THE REDESIGN", headline: "Same traffic. 3x conversions.", beforeLabel: "Before", afterLabel: "After", before: ["Cluttered homepage", "5 competing CTAs", "1.1% conversion"], after: ["One clear promise", "Single focused CTA", "3.4% conversion"], cta: "See the teardown" },
      { eyebrow: "THE REBRAND", headline: "From forgettable to funded", beforeLabel: "Before", afterLabel: "After", before: ["Generic template site", "Stock-photo smile", "$0 pipeline"], after: ["Distinctive identity", "Real customer proof", "$280k pipeline"], cta: "See the work" },
      { eyebrow: "THE FUNNEL FIX", headline: "60 days, one focus", beforeLabel: "Before", afterLabel: "After", before: ["7-step checkout", "68% abandon rate", "Guessing at copy"], after: ["3-step checkout", "31% abandon rate", "Tested headlines"], cta: "Steal the checklist" },
      { eyebrow: "THE CONTENT ENGINE", headline: "From random to rhythmic", beforeLabel: "Before", afterLabel: "After", before: ["Posting when inspired", "200 followers", "No system"], after: ["3x weekly cadence", "12k followers", "One playbook"], cta: "Copy the system" },
      { eyebrow: "THE AD ACCOUNT", headline: "From waste to ROAS", beforeLabel: "Before", afterLabel: "After", before: ["Boosted posts", "0.8x ROAS", "No creative testing"], after: ["Structured campaigns", "3.2x ROAS", "100 variants tested"], cta: "Get the framework" },
      { eyebrow: "THE EMAIL LIST", headline: "From crickets to clicks", beforeLabel: "Before", afterLabel: "After", before: ["Monthly newsletter", "12% open rate", "No segments"], after: ["Weekly value emails", "41% open rate", "5 smart segments"], cta: "Steal the sequences" },
    ],
  },
  "checklist": {
    checklist: [
      { eyebrow: "LAUNCH CHECKLIST", headline: "6 steps before you ship", items: ["Offer is one sentence", "Page loads in under 2s", "Analytics firing", "Email sequence ready"], cta: "Get the full 47" },
      { eyebrow: "SEO BASICS", headline: "The 10-minute audit", items: ["Title tags unique", "One H1 per page", "Images compressed", "Internal links added"], cta: "Get the PDF" },
      { eyebrow: "AD CREATIVE", headline: "Before you spend $1", items: ["Hook in first 3 seconds", "One idea per ad", "CTA above the fold", "Tracking verified"], cta: "Steal the bible" },
      { eyebrow: "CONTENT WEEK", headline: "Your 5-post plan", items: ["Teach one thing", "Share one win", "Ask one question", "Sell once"], cta: "Copy the calendar" },
      { eyebrow: "EMAIL WELCOME", headline: "First 4 emails", items: ["Deliver the promise", "Tell your story", "Show proof", "Make the offer"], cta: "Get the templates" },
      { eyebrow: "HIRING", headline: "Interview scorecard", items: ["Can they show past wins?", "Do they write clearly?", "Will they own outcomes?", "Culture add, not fit"], cta: "Get the scorecard" },
    ],
  },
};
