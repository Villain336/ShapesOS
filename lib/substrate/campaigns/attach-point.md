# "Attach to campaign" — hook point for per-channel builders

Phase 8 G2 (SPEC-PHASE8.md §2 G2, flow B5). The per-channel builders (mail,
outreach, media buying, CTV, newsletter, social, Test Lab, recycling) are
**not rebuilt** — each gains one hook point: offer "Attach to campaign" at
creation/launch time, and call the engine below.

## Interface

```ts
import { attachLink } from "@/lib/substrate/campaigns/store";
import type { AttachLinkInput } from "@/lib/substrate/campaigns/store";

// After the channel builder persists its fragment (e.g. an OutreachCampaign
// row), the user picks a growth campaign (or creates one) and the builder
// calls:
const { link, budgetRollupCents } = await attachLink(workspaceId, growthCampaignId, {
  linkedType: "outreach_campaign",   // one of the 8 CampaignLinkedType values
  linkedId: fragmentId,              // the fragment row's id
  role: "primary",                   // "primary" | "supporting"
  linkSource: "human",               // human-confirmed attach
  stageKey: "email_sms",             // optional; defaults per fragment type
  platformRef: {                     // optional; opaque, never re-modeled
    platform: "instantly",
    platform_campaign_ref: "cmp_123",
    hierarchy_snapshot: { /* platform's own structure, as-is */ },
    budget_semantics_note: "daily budget at the campaign level",
  },
  linkedBy: userId,
});
```

`AttachLinkInput` fields:

| field | type | notes |
|---|---|---|
| `linkedType` | `CampaignLinkedType` | `mail_campaign` \| `outreach_campaign` \| `media_buy` \| `ctv_campaign` \| `newsletter_broadcast` \| `social_post` \| `experiment` \| `recycling_brief` |
| `linkedId` | string | fragment row id (validated to exist in this workspace) |
| `role` | `"primary"` \| `"supporting"` | default `"primary"` |
| `linkSource` | `"human"` \| `"naming_convention"` \| `"utm"` \| `"api"` | attach-time attaches use `"human"` (or `"api"` for orchestrator calls) |
| `stageKey` | `CampaignStageKey` | optional; one of the 12 stages; defaults via `DEFAULT_STAGE_FOR_FRAGMENT` |
| `platformRef` | object \| null | opaque platform ref — stored as-is, never re-modeled |
| `linkedBy` | string | actor id for the audit trail |

## Guarantees the engine gives the builder

- **Idempotent-ish**: attaching the same fragment twice throws
  `CampaignError("duplicate_link")` — the builder can catch and no-op.
- **Workspace-scoped**: the fragment must exist in the same workspace, or
  attach throws `fragment_missing`. Cross-workspace links are impossible.
- **Stage pipeline updates**: the target stage gains the ref and flips
  `not_started → in_progress` automatically.
- **Budget rollup refreshes**: `budgetRollupCents` on the campaign is
  recomputed from linked fragments' declared budgets/spend. This is
  reporting only — it creates no spending authority (§3.1).
- **Fragment rows untouched**: attach writes only to `campaign_links` (+ the
  campaign's `stages` JSONB). Unlink via `detachLink()` is surgical.

## What the builder must NOT do

- Do not write `campaign_links` rows directly — always go through
  `attachLink()` so stage refs, rollup, and provenance stay consistent.
- Do not invent new spending paths: the campaign object orchestrates through
  the channel's **existing** approval objects. (§3.1 structural invariant.)
- Do not auto-attach on the user's behalf without their choice: new campaigns
  are created through the object, but the *link* is always an explicit act
  (or a human-resolved backfill proposal).

## Backfill (existing fragments)

Historical fragments are linked via the proposer, not by builders:

```ts
import { proposeBackfillLinks, resolveProposal } from "@/lib/substrate/campaigns/store";

const { proposalsCreated } = await proposeBackfillLinks(workspaceId); // queue only
await resolveProposal(workspaceId, proposalId, "approved", userId);   // human confirms
```

The proposer emits `campaign_link_proposals` (status `pending`) with match
signals + confidence. **Zero auto-links** — proposals never materialize
without a human decision. Precision over recall, permanently in v1.
