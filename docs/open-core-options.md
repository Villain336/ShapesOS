# Open-core options — decision brief

**Status: DECISION DEFERRED (undecided).** This document is a neutral map of the
options from `docs/phase7-research.md` Track 5. It presents tradeoffs with
**no recommendation**. Phase 7 (F6) ships this brief and launch readiness only —
no public repo flip happens before the split is decided (SPEC-PHASE7 §12.5).

## The four options

### A — Open Everything (Ghost/Mautic pole)

All code under AGPLv3. Commercial revenue comes from the white-label license,
hosted service, and support — the license carries the business alone.

- **Upside:** maximum trust and contributor goodwill; simplest legal story; no
  boundary policing; forks compete on execution, not on locked features.
- **Downside:** weakest fork defense — a well-funded competitor can run the whole
  product; the commercial tier must win on operations and brand, not on features.
- **Needs:** CLA-or-DCO still required for the white-label re-licensing path;
  trademark protection (see below) becomes the main moat.

### B — AGPL Core + Closed Enterprise Pack (GitLab/n8n pole)

Open = the core marketing OS. Commercial = SSO/RBAC/audit, white-label
sub-accounts, premium integrations, compliance artifacts.

- **Upside:** proven model; clear upsell ladder for agencies (white-label is the
  most commonly gated marketing-OSS feature); contributors know exactly where the
  line is.
- **Downside:** requires a CLA (or DCO + company-authored-commercial-code policy)
  **before** going public; the boundary doc in CONTRIBUTING.md must be maintained
  honestly or it reads as a trap; community friction if the line creeps.
- **Needs:** CLA-vs-DCO settled pre-public; published open-vs-commercial table
  (Plausible-style); the open tier must stay a complete product, not a demo.

### C — Three-Layer GPL/AGPL/Closed (SeasAGI pattern)

Finest-grained IP protection: the GrowthOS orchestrator (Phase 8/9) stays closed
while the marketing OS core is open.

- **Upside:** strongest protection for the highest-stakes line — the GrowthOS
  orchestrator is where the compounding agentic value lives.
- **Downside:** highest complexity (three license regimes, three contribution
  stories); hardest to explain; most contributor suspicion; CLA effectively
  mandatory.
- **Needs:** precise layer definitions in the spec before any code moves;
  legal review of the GPL/AGPL/closed interfaces.

### D — AGPL Everything + Lagged/Cloud Premium (Plausible pole)

No closed code at all. Cloud wins on cadence (features land there first),
managed keys, and operations.

- **Upside:** simplest legally — one license, no boundary to police, no CLA
  pressure beyond re-licensing; maximum community trust.
- **Downside:** weakest fork defense of all; relies on the hosted operation being
  genuinely better than a self-host; "lagged" releases can feel punitive if
  overdone.
- **Needs:** the hosted tier must be excellent on day one; clear communication
  about what "cloud premium" means (cadence + managed keys, not locked features).

## Cross-cutting points for the later call

1. **CLA-vs-DCO must be settled before going public** under B/C (and is needed
   for the white-label re-license under A/D too). Staged in CONTRIBUTING.md as
   must-decide-before-public.
2. **Where AI marginal spend sits:** AI features with per-call cost (LLM
   inference, enrichment) are the natural commercial meter under any option —
   but metering must never degrade the open tier into a demo.
3. **The highest-stakes line:** is the GrowthOS orchestrator (Phase 8/9) open
   (A/D) or commercial (B/C)? This single call dominates the economics of the
   split.
4. **White-label via §7 + trademark vs. license terms:** see the trademark note
   below — the brand boundary and the code boundary are separate decisions.

## Decision brief item: trademark / AGPLv3 §7 branding protection

**Question:** should the "Marketr" name, logo, and brand assets be protected via
AGPLv3 §7 "additional permissions" (used as additional *terms*/restrictions on
trademark use) plus a trademark filing?

**Precedent:** the OnlyOffice "Logo Trap" opinion (April 2026) tested exactly this
mechanism — AGPLv3 §7 additional permissions combined with trademark rights to
protect the brand/white-label boundary without touching the license grant.

**What it would do:** anyone may fork and run the code (the AGPLv3 freedoms are
untouched), but they may not ship it *as "Marketr"* — white-labeling the brand
away becomes the thing you pay for, cleanly separated from the code license.

**Tradeoffs:**
- Upside: the brand becomes the commercial moat under every option (A–D); forks
  can't free-ride on brand trust; the open tier stays fully open.
- Downside: needs a real trademark filing to have teeth; §7 notices must be
  drafted carefully (they must not restrict the AGPLv3 freedoms themselves);
  community perception risk if it reads as brand-lock-in.

**Decision needed:** adopt §7 + trademark, or rely on license terms alone. Defer
with the split — but decide *with* the split, not after, because the commercial
terms page (F6) must reflect it.

## What happens next (when the call is made)

1. Pick A/B/C/D (this document stays as the record of what was considered).
2. Settle CLA-vs-DCO the same day.
3. Publish the open-vs-commercial table in README + CONTRIBUTING.
4. Draft the commercial terms page to match.
5. Then — and only then — schedule the public flip.
