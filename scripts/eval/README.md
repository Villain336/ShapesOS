# Phase 17 evaluation harness

Measures what a model / effort / routing / prompt-layout choice does to **quality, cost and speed** on 30 real ShapesOS requests, before any Phase 17B trade-off is kept.

- `tasks.json`: the frozen task set (chat Q&A, CRM and ops actions, SEO, content, one coding task, one delegation task). Each task has a deterministic check. Subjective tasks also carry a rubric, which the copy workload (`claude-haiku-4-5`) judges on real runs. Don't edit a frozen task; add one with a new id.
- `seed.ts`: the workspace each configuration runs against (a fresh one per configuration).
- `runner.ts`: runs every task through the **real chat loop** (`runTrackedAgentTurn`) and reads cost, cache share and time to first token from the **usage events** the calls recorded. It also measures total latency and writes `results.json` and `results.md` after every task.
- `run.mts`: the CLI.

## Dry run (free; what CI runs)

```
DATABASE_URL=… npx tsx scripts/eval/run.mts --dry-run
```

A scripted **fake** Anthropic server answers instead of a model (MOCK). It proves the harness, the ledger reads and the budget guard, never the model. Exit code 1 means a scripted task failed, which means the harness is broken. `scripts/eval/__tests__/eval-dry-run-db.test.ts` runs a subset in the DB suite.

## Real run (paid, needs the owner's budget approval)

```
ANTHROPIC_API_KEY=… DATABASE_URL=… npx tsx scripts/eval/run.mts --max-usd 30 [--configs baseline,routing] [--out dir]
```

- **The key is read only from the `ANTHROPIC_API_KEY` environment variable.** A `--key`-style flag is refused, and no file is read. OpenAI keys are removed for the run, so failover can't bill a second vendor.
- **The `--max-usd` cap is hard (default $30, owner decision 2026-10-06).** Before each task the runner adds the most expensive task measured so far (or $0.30 before any task has been measured) to the spend so far. A task whose projection would pass the cap never starts: the partial table is written and the run exits with code 3. Spend is the provider cost recorded on the usage events (before the 1.5× credit charge), including the judge and the background facts summaries.
- **Sweep order** (default `--configs`): `baseline`, then `routing`, then `effort-low` and `effort-high`. The effort levels only run while budget remains. `layout-legacy` (the pre-Phase-17 prompt layout, the cache layout's control arm) runs only when named.
- `routing` is **oracle** routing. It routes by the fixtures' complexity labels: simple goes to Sonnet 5.5 at low effort, tools to Sonnet 5.5 at medium, planning to Opus 5.5. It measures the upside of routing with a perfect classifier; the 17B classifier itself isn't built.
- It needs a migrated database (it seeds `eval-<time>-<config>` workspaces and leaves them; usage rows are append-only). The agent worker for delegated sub-agents starts inside the runner.

### Estimated cost (an estimate, not a measurement)

These figures come from the Phase 17 prompt sizes the cache probe measured (static prefix about 4.5k tokens, lead tools about 2.3k) and list prices (Opus 5.5 $4 / $20 per M tokens, cache reads $0.20, 1-hour cache writes $8; Sonnet 5.5 $2 / $10).

| Config | Per task (typical) | 30 tasks |
|---|---|---|
| baseline (Opus 5.5, medium) | $0.02–0.15; the delegation task $0.2–0.4 | ≈ $1.5–3 |
| routing (oracle) | $0.01–0.10 | ≈ $0.8–2 |
| effort-low / effort-high | ± 30–60% of baseline (thinking tokens) | ≈ $1–4 each |
| layout-legacy | + the prefix rewritten every turn | ≈ $2–4 |

The full default sweep should land around **$5–12**, well inside the $30 cap. The cap is the guarantee, not this estimate.

Run the cache probe once with a key as well (the counts are free; the endpoint is `count_tokens`):

```
LIVE_ANTHROPIC_API_KEY=… DATABASE_URL=… npx tsx scripts/verify/prompt-cache.mts
```
