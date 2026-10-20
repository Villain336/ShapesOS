// ShapesOS — Phase 17 (A1, WS=model): the prompt-cache probe.
//
// Captures the EXACT request bodies the chat loop sends (through the real
// lib/chat/agent.ts turn + lib/agents/loop.ts + lib/llm/anthropic.ts) for
// two consecutive user turns in one thread, a new thread, and a thread in a
// second workspace — against a scripted FAKE Anthropic server
// (lib/llm/__tests__/fake-anthropic.ts, MOCK: no model is called, no key is
// needed) — and reports:
//   * system bytes, tool-schema bytes (loaded vs deferred), message bytes;
//   * where the cache_control breakpoints sit and their TTL;
//   * which bytes of the tools + system prefix differ between turns, threads
//     and workspaces (the cache breakers) — asserted to be NONE;
//   * input tokens by block: counted with the real token-count endpoint when
//     LIVE_ANTHROPIC_API_KEY is set (one count_tokens call per body, free),
//     else a labelled bytes/4 ESTIMATE.
// Exit 1 when a cache invariant fails. Needs DATABASE_URL (it seeds two
// workspaces + threads and removes them). Runs in CI without a model key.
//
//   DATABASE_URL=… npx tsx scripts/verify/prompt-cache.mts            # fake server, estimates
//   LIVE_ANTHROPIC_API_KEY=… DATABASE_URL=… npx tsx scripts/verify/prompt-cache.mts   # + real token counts
//   … --json out.json                                                  # also write the report
//
// Real cache HITS can only be proven against the live API (UNVERIFIED-LIVE
// from this sandbox): run `LIVE_ANTHROPIC_API_KEY=… npx tsx
// scripts/live/anthropic.mts` style checks, or watch usage_events.
// llm_cache_hit / Settings → Usage → "AI cost & speed" after one real chat.

import { prisma } from "@/lib/prisma";
import { runTrackedAgentTurn } from "@/lib/chat/agent";
import { flushUsageRecording } from "@/lib/llm/usage";
import { settleThreadFacts } from "@/lib/chat/facts";
import { settleBackgroundWork } from "@/lib/runtime/shutdown";
import { startFakeAnthropic, type AnthropicBody, type FakeAnthropic } from "@/lib/llm/__tests__/fake-anthropic";
import { writeFileSync } from "node:fs";

const RUN = `p17probe-${Date.now().toString(36)}`;
const USER = `${RUN}-user`;
const bytes = (v: unknown): number => (v === undefined ? 0 : Buffer.byteLength(JSON.stringify(v), "utf8"));
const jsonArg = (() => {
  const i = process.argv.indexOf("--json");
  return i > 0 ? process.argv[i + 1] : null;
})();

interface Capture {
  label: string;
  body: AnthropicBody;
}

interface BlockReport {
  label: string;
  model: string;
  systemBytes: number;
  toolsBytes: number;
  toolsLoadedBytes: number;
  toolsDeferredBytes: number;
  toolsLoaded: number;
  toolsDeferred: number;
  messagesBytes: number;
  contextBlockBytes: number;
  breakpoints: string[];
  tokens: { system: number; toolsLoaded: number; messages: number; total: number; source: "count_tokens" | "estimate (bytes/4)" };
  betas: string;
  serviceTier: string | null;
}

function breakpointsOf(b: AnthropicBody): string[] {
  const out: string[] = [];
  (b.tools ?? []).forEach((t, i) => {
    const cc = t.cache_control as { ttl?: string } | undefined;
    if (cc) out.push(`tools[${i}]=${t.name} (ttl ${cc.ttl ?? "5m"})`);
  });
  const sys = Array.isArray(b.system) ? b.system : [];
  sys.forEach((s, i) => {
    const cc = s.cache_control as { ttl?: string } | undefined;
    if (cc) out.push(`system[${i}] (ttl ${cc.ttl ?? "5m"})`);
  });
  if (b.cache_control) out.push(`top-level automatic (ttl ${(b.cache_control as { ttl?: string }).ttl ?? "5m"})`);
  return out;
}

/** The first differing byte of two JSON serialisations, with a snippet. */
function firstDiff(a: unknown, b: unknown): { at: number; a: string; b: string } | null {
  const sa = JSON.stringify(a) ?? "";
  const sb = JSON.stringify(b) ?? "";
  if (sa === sb) return null;
  let i = 0;
  while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++;
  return { at: i, a: sa.slice(Math.max(0, i - 40), i + 80), b: sb.slice(Math.max(0, i - 40), i + 80) };
}

async function countTokens(key: string, b: AnthropicBody): Promise<{ system: number; toolsLoaded: number; messages: number; total: number } | null> {
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: key, baseURL: "https://api.anthropic.com" });
    const model = String(b.model);
    const strip = (tools: Array<Record<string, unknown>>) => tools.map((t) => ({ ...t, cache_control: undefined, eager_input_streaming: undefined }));
    const loadedTools = strip((b.tools ?? []).filter((t) => t.defer_loading !== true && !String(t.type ?? "").startsWith("tool_search")));
    const sys = (Array.isArray(b.system) ? b.system : []).map((s) => ({ type: "text", text: String(s.text) }));
    const count = async (params: Record<string, unknown>) =>
      (await client.messages.countTokens(params as never)).input_tokens;
    const base = await count({ model, messages: [{ role: "user", content: "." }] });
    const withSystem = await count({ model, system: sys, messages: [{ role: "user", content: "." }] });
    const withTools = await count({ model, system: sys, tools: loadedTools, messages: [{ role: "user", content: "." }] });
    const total = await count({ model, system: sys, tools: loadedTools, messages: b.messages });
    return { system: withSystem - base, toolsLoaded: withTools - withSystem, messages: total - withTools + base, total };
  } catch (err) {
    console.warn(`count_tokens failed (${err instanceof Error ? err.message : String(err)}); falling back to the estimate`);
    return null;
  }
}

async function report(c: Capture, liveKey: string | null): Promise<BlockReport> {
  const b = c.body;
  const tools = b.tools ?? [];
  const loadedTools = tools.filter((t) => t.defer_loading !== true);
  const deferredTools = tools.filter((t) => t.defer_loading === true);
  const first = b.messages[0];
  const ctx = Array.isArray(first?.content) ? (first.content as Array<{ type: string; text?: string }>).find((x) => x.type === "text" && x.text?.startsWith("<workspace-context>")) : null;
  const counted = liveKey ? await countTokens(liveKey, b) : null;
  const est = { system: Math.round(bytes(b.system) / 4), toolsLoaded: Math.round(bytes(loadedTools) / 4), messages: Math.round(bytes(b.messages) / 4) };
  return {
    label: c.label,
    model: String(b.model),
    systemBytes: bytes(b.system),
    toolsBytes: bytes(tools),
    toolsLoadedBytes: bytes(loadedTools),
    toolsDeferredBytes: bytes(deferredTools),
    toolsLoaded: loadedTools.length,
    toolsDeferred: deferredTools.length,
    messagesBytes: bytes(b.messages),
    contextBlockBytes: ctx ? Buffer.byteLength(ctx.text ?? "", "utf8") : 0,
    breakpoints: breakpointsOf(b),
    tokens: counted ? { ...counted, source: "count_tokens" } : { ...est, total: est.system + est.toolsLoaded + est.messages, source: "estimate (bytes/4)" },
    betas: "",
    serviceTier: b.service_tier ?? null,
  };
}

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("prompt-cache probe: DATABASE_URL is required (it seeds two workspaces and removes them).");
    return 2;
  }
  const liveKey = (process.env.LIVE_ANTHROPIC_API_KEY ?? "").trim() || null;
  const fake: FakeAnthropic = await startFakeAnthropic({ agentWorker: "off" });
  const WS_A = `${RUN}-a`;
  const WS_B = `${RUN}-b`;
  const failures: string[] = [];
  const captures: Capture[] = [];
  try {
    await prisma.workspace.create({ data: { id: WS_A, name: `Probe A ${RUN}`, ownerUserId: USER } });
    await prisma.workspace.create({ data: { id: WS_B, name: `Probe B ${RUN}`, ownerUserId: USER } });
    const projA = await prisma.project.create({ data: { workspaceId: WS_A, domain: `${RUN}-a.example` } });
    const projB = await prisma.project.create({ data: { workspaceId: WS_B, domain: `${RUN}-b.example`, locale: "de-DE" } });
    await prisma.keyword.createMany({
      data: [
        { projectId: projA.id, phrase: "espresso machines", volume: 1200, tracked: true },
        { projectId: projA.id, phrase: "coffee grinders", volume: 800, tracked: false },
      ],
    });
    const t1 = await prisma.aiChatThread.create({ data: { projectId: projA.id, userId: USER, title: "New chat" } });
    const t2 = await prisma.aiChatThread.create({ data: { projectId: projA.id, userId: USER, title: "New chat" } });
    const t3 = await prisma.aiChatThread.create({ data: { projectId: projB.id, userId: USER, title: "New chat" } });

    let label = "";
    fake.script = (body) => {
      if (body.stream) captures.push({ label, body });
      return { text: `Reply for ${label}.` };
    };
    const turn = (ws: string, projectId: string, threadId: string, text: string, l: string) => {
      label = l;
      return runTrackedAgentTurn({ projectId, workspaceId: ws, userId: USER, role: "editor", threadId, userContent: text });
    };
    await turn(WS_A, projA.id, t1.id, "What are my tracked keywords?", "thread1.turn1");
    await turn(WS_A, projA.id, t1.id, "And which of them rank best?", "thread1.turn2");
    await turn(WS_A, projA.id, t2.id, "Summarise my open alerts.", "thread2.turn1");
    await turn(WS_B, projB.id, t3.id, "Wie viele Keywords habe ich?", "workspaceB.turn1");

    if (captures.length < 4) failures.push(`expected 4 captured model calls, got ${captures.length}`);
    const reports: BlockReport[] = [];
    for (const c of captures) reports.push(await report(c, liveKey));
    for (let i = 0; i < captures.length; i++) reports[i].betas = fake.requests.filter((r) => r.body === captures[i].body)[0]?.betas ?? "";

    // ── invariants ─────────────────────────────────────────────────────────
    const base = captures[0]?.body;
    const prefixOf = (b: AnthropicBody) => ({
      tools: (b.tools ?? []).map((t) => ({ ...t, cache_control: undefined })),
      system: (Array.isArray(b.system) ? b.system : []).map((s) => ({ ...s, cache_control: undefined })),
    });
    const breakers: Array<{ pair: string; where: string; at: number; a: string; b: string }> = [];
    for (const c of captures.slice(1)) {
      const dt = firstDiff(prefixOf(base).tools, prefixOf(c.body).tools);
      if (dt) breakers.push({ pair: `${captures[0].label} vs ${c.label}`, where: "tools", ...dt });
      const ds = firstDiff(prefixOf(base).system, prefixOf(c.body).system);
      if (ds) breakers.push({ pair: `${captures[0].label} vs ${c.label}`, where: "system", ...ds });
    }
    if (breakers.length) failures.push(`cache breakers in the tools+system prefix: ${JSON.stringify(breakers, null, 2)}`);
    for (const [i, c] of captures.entries()) {
      const b = c.body;
      const tools = b.tools ?? [];
      const loadedIdx = tools.map((t, j) => (t.defer_loading !== true && !t.type ? j : -1)).filter((j) => j >= 0);
      const lastLoaded = loadedIdx.at(-1);
      if (lastLoaded === undefined) failures.push(`${c.label}: no loaded client tool`);
      else if (!tools[lastLoaded].cache_control) failures.push(`${c.label}: no cache_control on the last loaded tool (${tools[lastLoaded].name})`);
      for (const [j, t] of tools.entries()) if (j !== lastLoaded && t.cache_control) failures.push(`${c.label}: stray cache_control on tools[${j}] ${t.name}`);
      for (const t of tools) if (t.defer_loading === true && t.cache_control) failures.push(`${c.label}: cache_control on a deferred tool (${t.name}) — the API 400s`);
      const sys = Array.isArray(b.system) ? b.system : [];
      const lastSys = sys.at(-1) as { cache_control?: { ttl?: string } } | undefined;
      if (!lastSys?.cache_control) failures.push(`${c.label}: no cache_control on the last system block`);
      else if (lastSys.cache_control.ttl !== "1h") failures.push(`${c.label}: chat prefix must use the 1-hour TTL (got ${lastSys.cache_control.ttl ?? "5m"})`);
      if (!b.cache_control) failures.push(`${c.label}: no top-level automatic caching for the conversation tail`);
      const sysText = sys.map((s) => String(s.text)).join("\n");
      for (const dyn of ["PROJECT CONTEXT", "AVAILABLE SKILLS", "Keywords:", "<workspace-context>\n"]) {
        if (sysText.includes(dyn)) failures.push(`${c.label}: dynamic text "${dyn}" inside the cached system prefix`);
      }
      if (reports[i].contextBlockBytes === 0) failures.push(`${c.label}: the first user turn carries no <workspace-context> block`);
      if (!tools.some((t) => t.defer_loading === true)) failures.push(`${c.label}: no deferred tools (tool search not in effect)`);
      if (!tools.some((t) => String(t.type ?? "").startsWith("tool_search_tool_bm25"))) failures.push(`${c.label}: tool_search_tool_bm25 not offered`);
    }

    // ── report ─────────────────────────────────────────────────────────────
    const r0 = reports[0];
    console.log(`\nprompt-cache probe (${liveKey ? "token counts from the real count_tokens endpoint" : "token ESTIMATES bytes/4 — set LIVE_ANTHROPIC_API_KEY for real counts"})\n`);
    console.log("label              | system B | tools loaded B (n) | tools deferred B (n) | messages B | context B | tokens sys/tools/msgs/total");
    for (const r of reports) {
      console.log(
        `${r.label.padEnd(18)} | ${String(r.systemBytes).padStart(8)} | ${String(r.toolsLoadedBytes).padStart(14)} (${r.toolsLoaded}) | ${String(r.toolsDeferredBytes).padStart(16)} (${r.toolsDeferred}) | ${String(r.messagesBytes).padStart(10)} | ${String(r.contextBlockBytes).padStart(9)} | ${r.tokens.system}/${r.tokens.toolsLoaded}/${r.tokens.messages}/${r.tokens.total}`,
      );
    }
    console.log(`\nbreakpoints (${r0?.label}): ${r0?.breakpoints.join("; ")}`);
    console.log(`betas header: ${r0?.betas || "(none)"} · service_tier: ${r0?.serviceTier ?? "(default)"}`);
    console.log(`prefix (tools+system) byte-identical across turn 1 → turn 2 → new thread → other workspace: ${breakers.length === 0 ? "YES" : "NO"}`);
    const cached = r0 ? r0.tokens.system + r0.tokens.toolsLoaded : 0;
    console.log(`cacheable static prefix ≈ ${cached} tokens (${r0?.tokens.source}); per-turn uncached ≈ ${r0?.tokens.messages} tokens (the context block + history)`);
    if (jsonArg) writeFileSync(jsonArg, JSON.stringify({ reports, breakers, failures }, null, 2));
    if (failures.length) {
      console.log("\nFAILURES:");
      for (const f of failures) console.log(`  ✗ ${f}`);
      return 1;
    }
    console.log("\n✓ cache layout invariants hold");
    return 0;
  } finally {
    await fake.close();
    // Usage is recorded in the background (Phase 17 outbox): let it land
    // before the workspaces go, or the delete and the late usage write lock
    // the same workspace and balance rows in opposite orders (a deadlock).
    // The thread-facts summary (a background model call) records its own
    // usage when it finishes, so settle it first, then the usage writes.
    await settleThreadFacts().catch(() => undefined);
    await flushUsageRecording().catch(() => undefined);
    await settleBackgroundWork().catch(() => undefined);
    await prisma.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B] } } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

process.exit(await main());
