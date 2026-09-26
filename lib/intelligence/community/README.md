# M8 — Community engagement (Okara-style, draft-first)

Finds live conversations where the workspace's expertise is genuinely
relevant, drafts replies worth posting, and queues them in the Phase 9
approval inbox. The human edits and posts **natively**. Marketr never holds
credentials to post on anyone's behalf and never autoposts.

## Architecture

```
sources/hn.ts ──────┐
sources/reddit.ts ──┼─→ scanner.ts ─→ ranking.ts ─→ drafts.ts ─→ mission_approvals
sources/rss.ts ─────┘      (discover)    (score)      (LLM + taste gate)
                                                        │
                                                        ▼ taste fail
                                                   logged, dies here
```

- **Discovery** (`scanner.ts`): Hacker News (Algolia HN Search API —
  free, no key), Reddit (**official API only**, user's own OAuth),
  niche forums via **user-configured RSS**. All adapters degrade
  gracefully: a dead/unconfigured source is skipped, never fatal.
- **Ranking** (`ranking.ts`): pure function over the workspace's
  expertise profile (`expertise.ts`, built from Phase 1 `Keyword`
  tracked rows + `competitors`). Signals: `competitor_mention`,
  `expertise_match`, `launch_moment`.
- **Drafts** (`drafts.ts`): LLM via `lib/llm` router ("copy" workload —
  the text goes out under the user's name), one retry, then
  `tasteCheck()` gates. **The only sink is the Phase 9 approval inbox**
  (`mission_approvals`, action `community_reply_draft`, Tier 2) — the
  exact item schema the inbox reads. No parallel inbox.
- **Closed loop** (`outcomes.ts`): after the human posts natively, they
  record upvotes/replies/traffic → stored on the approval item
  (`binding_json.outcome`) + hash-chained `mission_approval_events`
  (`community.posted`). `getCommunityOutcomes(workspaceId)` is the feed
  M3's branded-mention tracking consumes.

## Invariants (enforced in `__tests__/no-autopost.test.ts`)

1. No code path publishes to any platform — static scan + behavioral
   test (spy fetch over a full scan: every outbound call is a GET read).
2. `tasteCheck()` failures never reach the inbox.
3. No platform scraping, ever.

## Reddit — legal & ops posture (SPEC-PHASE10 §2)

- **Official API only.** Scraping Reddit is a hard 🚫 line: Reddit v.
  Anthropic (Sept 19, 2026) gave platform ToS contract/unfair-competition
  teeth independent of copyright.
- **User's own credentials only.** Reddit's public API access wound down
  Sept 30, 2026; reported commercial pricing is ~$12K/mo [UNVERIFIED].
  Marketr **never proxies Reddit at platform scale** — every call in
  `sources/reddit.ts` carries the workspace owner's own script-app
  OAuth (refresh-token grant, read scope). Unconfigured → skipped.
- **Read-only.** The adapter requests the `read` scope and has no
  post/vote/message code path. Humans post natively — this is Okara's
  ban-safe pattern and the legally safe one.

## RSS + Google Alerts — consumer-tool baseline

- Niche forums (Discourse/NodeBB/Flarum RSS, Substack, community feeds):
  the workspace owner pastes feed URLs; M8 fetches and parses them.
  No forum HTML scraping, no credentialed sessions.
- **Google Alerts** is the documented consumer-tool baseline per
  SPEC-PHASE10 §2: use the free product (alerts → inbox → paste the
  thread URL into a scan), not scraping it. There is no Alerts API and
  M8 does not pretend otherwise.

## State decision (no new tables)

M8 was built with **zero migrations**: the 13 foundation tables cover
it. All M8 state lives on existing rows:

| State | Where |
|---|---|
| Drafts | `mission_approvals` — `action='community_reply_draft'`, Tier 2, `binding_json` (source → thread → reason → draft → threadUrl → …) |
| Outcomes | `binding_json.outcome` (queryable) + `mission_approval_events` action `community.posted` (hash-chained audit) |
| Tracked threads | derived from the approval items themselves |

**Binding-hash note:** `bindingJson` is hashed at creation. For community
drafts the hash is a creation-time integrity record — no executor
re-verifies it at execution time because there is no community executor
(executing would be autoposting, which M8 forbids). Outcomes are written
as an additive `outcome` key and never alter the approved draft keys.

## Taste guardrails (`taste.ts`)

` tasteCheck(draft)` — length 40–900 chars, no emoji, marketing-speak
blocklist (`game-changer`, `delve`, `leverage`, …), no sycophantic
openers (`Great question!…`), ≤2 links, no ALL-CAPS shouting, no `!!`,
no `we at …` brand pitches. Failing drafts are logged via
`onTasteReject` and die before the inbox.

## Running a scan

```ts
import { scanCommunity } from "@/lib/intelligence/community";

const report = await scanCommunity({
  workspaceId,
  createdBy: userId,
  reddit: null, // or { clientId, clientSecret, refreshToken, username }
  rssFeeds: [{ name: "Niche SEO Forum", url: "https://forum.example/rss" }],
  maxDrafts: 5,
  dryRun: false, // true = discover + rank only, no LLM, no inbox writes
});
```
