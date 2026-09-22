# Hosted usage metering — landscape brief (2026-09-22)

## 1. Pricing models in the wild
- **Seat + usage hybrid (converging norm):** Cursor Pro $20/mo, Teams $40/seat + credits; GitHub Copilot Pro $10–$39/seat with included credits; Claude Code Team $20–25/seat, Premium $100–125/seat. Salesforce Agentforce cycled $2/conversation → $0.10/action Flex Credits → $125/user/mo, now offers all three (per LinkedIn/Marty Kausas). "No one has converged — everyone is experimenting."
- **Pure credit:** Replit Agent ($20/mo in credits), Bolt.new (10M tokens Pro $25/mo), Lovable ($20/100 msgs, $50/500 msgs — message-based credits).
- **BYOK fork:** Aider/Cline/Zed = bring your key, pay provider only; Warp = platform fee even with your key ("the harness costs us money"). Marketr's self-hosted story should mirror this: hosted keys bundled = margin, BYO = base fee.
- **Observed price anchors:** individual Pro $20/mo modal; teams ~$40/seat; whale tiers $100–200.

## 2. What gets metered; overage handling
- **Units:** LLM input/output tokens (per model/provider), agent requests/runs, API calls, seats, storage bytes, compute minutes. Best practice (seen in two OSS roadmaps): record *raw* tokens AND converted credits, tag managed-vs-BYO runs.
- **Overage models:** hard cap (block, Atlas/Copilot-style 402), soft cap + auto-billing (Cursor: overage bills in arrears, no default hard cap — the source of its backlash), credit top-ups/packs, invoice-at-cycle-end with markup.
- **Credit sync:** Stripe's LLM Token Billing (announced Mar 2026, private preview at last report — **couldn't verify GA status**) auto-syncs model prices and applies a % markup; supports base fee + included usage + PAYG combos.

## 3. Tooling — trade-offs for AGPLv3 self-hostable + hosted tier
- **Stripe Billing Meters** (proprietary): event-based meters (sum/max/count, ~1k events/sec), metered prices, Checkout + Customer Portal out of the box. **Fit:** hosted tier only — self-hosted instances can't depend on a proprietary SaaS for entitlement enforcement. Meter events are fire-and-flush (buffer locally, idempotent identifiers; atomic drain, never read-then-delete).
- **Lago** (AGPL-3.0, ~10.5k stars): full billing suite — subscriptions, wallets/credits, invoicing, billing UI. **Fit:** license-compatible with Marketr's AGPLv3 core; self-hostable, so self-hosters get the same metering code path. Risk: it's a *billing* system, not a realtime gating engine; heavier to operate.
- **OpenMeter** (Apache-2.0, ~2.3k stars): high-velocity event ingestion/aggregation, quotas/limits, pushes to Stripe for invoicing. **Fit:** strongest as the *metering* layer (license-compatible); pairs with Stripe for the hosted money layer. Risk: smaller community, metering-only — still need invoicing.
- **Flexprice** (OSS, AI/agentic-focused): couldn't verify maturity — flagged by one guide as AI-optimized billing; needs a real eval before any commitment.
- **Pattern recommendation (from two independent OSS designs):** own the metering ledger in Marketr (workspace_id-scoped, append-only, idempotent); let Lago/Stripe/OpenMeter be pluggable *sinks*, not the source of truth. Self-hosted = BYO keys, metering optional; hosted = Stripe + internal ledger.

## 4. Attribution: per-workspace vs per-project
- **Standard:** meter at workspace (tenant) level, roll up to the invoice; expose per-project/team breakdown for chargeback. OSAC's metering PRD: tenant admin views org usage broken down by project/resource; nested projects aggregate upward.
- **Implementation pattern:** propagate an attribution context (workspace_id + project_id + run_id + featureTag) through every system call — LLM proxy, crawlers, schedulers — so shared resources can be attributed without reorganizing infra (bitatlas write-up).
- **Marketr mapping:** workspace = billing entity (subscription, credits pool); project = attribution/cost-center entity (client work). Enables agency white-label: show clients per-project spend.

## 5. Honest risks
- **Credit opacity kills trust:** Cursor's June 2025 opaque-credit switch → user revolt, refunds; Replit "$1 to change a button color"; Copilot's metered switch → "exodus" threats. If a user can't map action → cost, disputes follow.
- **Cost surprises are systemic:** Zylo 2026 index: 78% of IT leaders hit unexpected AI charges; Uber burned its annual Claude Code budget in 4 months; a $34k/8-day agent bill documented via runaway retries/subagents. Mitigations: default spend caps, pre-action cost estimates, usage dashboards — not just invoices.
- **Billing accuracy disputes:** Anthropic $16.6M billing error (per auditors); Microsoft portals disagreeing → $16k surprise bill. Enterprise buyers now audit AI line items (Vaudit charges contingency fees). Keep immutable usage evidence.
- **Implementation complexity:** idempotent event ingestion, reconciliation with provider invoices, proration, multi-currency, dunning — the ledger is a real engineering project, not a weekend add-on.
- **Margin risk:** reselling tokens with markup works only if model prices are tracked; Stripe's auto-sync helps but is in preview.

## Sources
- Cursor/Copilot/Replit pricing: github.com/vaproh/awesome-coding-plans; github.com/angdingjie/ai-tools-blog (community compilations — verify against official pricing pages)
- Pricing analysis: github.com/devacc8/vegaforge (ai-agent-pricing.mdx); LinkedIn Marty Kausas post (linked)
- Stripe meters: github.com/faqndo97/ai-skills (pay-gem/metered-billing.md), github.com/fil-one/fil-one, github.com/twilson63/zenbin, github.com/kriptoburak/skills-ws
- Stripe LLM Token Billing (Mar 2026, preview): github.com/alittlenerdy/replysequence research doc — GA status unverified
- Lago vs OpenMeter: openalternative.co/compare/lago/vs/openmeter; legalitcost.com usage-metering guides
- Attribution patterns: github.com/bitatlas-group/bitatlas (agent cost attribution); github.com/nb-asr/bdb-os (workspace metering schema)
- Disputes: The Register (2026-09-22, MS portal disagreement), WebProNews (Copilot backlash), Computerworld (Azure AI Foundry "billing trap"), TechTimes (Anthropic billing error), Medium Austin Blake ($34k agent bill)
