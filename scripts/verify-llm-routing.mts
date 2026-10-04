// Marketr — Direction B LLM routing adversarial battery (Phase D).
//
// Run: npx tsx scripts/verify-llm-routing.mts
// Run 3x green before calling this done. Fully offline — no API calls.
//
// Covers lib/llm/THREAT-MODEL-LLM.md abuse cases:
//   T1 blocked families (deepseek/gemini) can never be selected via config
//   T1 non-ZDR-allow-listed models fail closed to mock (incl. covered models)
//   T1 unknown model strings fail closed to mock (never a guessed provider)
//   T2 env-override isolation (COPY override can't redirect bulk/background)
//   T2 legacy LLM_MODEL honored as bulk-only override, never copy
//   T3 no key material in errors, status payloads, or fallback warnings
//   T7 mock honesty (isLive=false, labeled) and loud fallback warnings
//   T9 failover (Phase 6) only to allow-listed, keyed, non-blocked models
//   T10 single-key mode (Phase 6) only for DEFAULT choices, never env ones
//   Phase 7 agent workloads: lead/subagent/code/code_max defaults,
//       efforts, single-key gpt-5.5, failover pairs, agent-key mapping
//   T12 covered (30-day-retention) models (Phase 7) route only with
//       LLM_ALLOW_RETENTION_MODELS=1; a default is swapped, an env choice mocks
// Plus: routing correctness per workload, self-host Qwen gating,
// back-compat getLlmProvider()/llmStatus() contract shapes.

import {
  getLlmProviderFor,
  llmRoutingStatus,
  resolveWorkload,
  resolveWorkloadModel,
  isRoutableHostedModel,
  ANTHROPIC_ZDR_MODELS,
  FAMILY_WORKLOAD_DEFAULTS,
  OPENAI_ZDR_MODELS,
  WORKLOAD_DEFAULTS,
  WORKLOAD_EFFORT,
  ANTHROPIC_RETENTION_MODELS,
  LLM_WORKLOADS,
  AGENT_WORKLOADS,
  workloadForAgent,
} from "../lib/llm/router.js";
import { getLlmProvider, llmStatus } from "../lib/llm/index.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- env hygiene: snapshot once, restore between tests ---
const ENV_SNAPSHOT = { ...process.env };
function cleanEnv() {
  for (const k of Object.keys(process.env)) {
    if (!(k in ENV_SNAPSHOT)) delete process.env[k];
  }
  for (const k of [
    "LLM_MODEL_COPY",
    "LLM_MODEL_BULK",
    "LLM_MODEL_BACKGROUND",
    "LLM_MODEL_LEAD",
    "LLM_MODEL_SUBAGENT",
    "LLM_MODEL_CODE",
    "LLM_MODEL_CODE_MAX",
    "LLM_ALLOW_RETENTION_MODELS",
    "LLM_MODEL",
    "LLM_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "LLM_BASE_URL",
    "ANTHROPIC_API_KEY",
    "LLM_SELF_HOST",
    "LLM_FAILOVER",
    "LLM_TIMEOUT_MS",
  ]) {
    delete process.env[k];
  }
}
function restoreEnv() {
  for (const k of Object.keys(process.env)) {
    if (!(k in ENV_SNAPSHOT)) delete process.env[k];
  }
  Object.assign(process.env, ENV_SNAPSHOT);
}

// --- capture console.warn to assert loud-but-safe fallbacks ---
let warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(" "));
};

function section(name: string) {
  console.log(`\n# ${name}`);
  warnings = [];
  cleanEnv();
}

// ================= 1. routing correctness =================
section("routing correctness per workload");

ok("no keys → copy is mock", getLlmProviderFor("copy").name === "mock");
ok("no keys → bulk is mock", getLlmProviderFor("bulk").name === "mock");
ok(
  "no keys → background is mock",
  getLlmProviderFor("background").name === "mock",
);
ok(
  "no keys → fallbacks are loud",
  warnings.length >= 3,
  `got ${warnings.length}`,
);

cleanEnv();
process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
process.env.OPENAI_API_KEY = "sk-test-key";
const copyP = getLlmProviderFor("copy");
ok("copy → anthropic provider", copyP.name === "anthropic");
ok("copy isLive", copyP.isLive === true);
const bulkP = getLlmProviderFor("bulk");
ok("bulk → openai-compatible", bulkP.name === "openai-compatible");
const bgP = getLlmProviderFor("background");
ok("background → openai-compatible", bgP.name === "openai-compatible");

const routing = llmRoutingStatus();
ok("routing.copy.model default", routing.copy.model === "claude-haiku-4-5");
ok("routing.bulk.model default", routing.bulk.model === "gpt-5-nano");
ok("routing.background.model default", routing.background.model === "gpt-5-nano:flex");
ok(
  "defaults match WORKLOAD_DEFAULTS",
  routing.copy.model === WORKLOAD_DEFAULTS.copy &&
    routing.bulk.model === WORKLOAD_DEFAULTS.bulk &&
    routing.background.model === WORKLOAD_DEFAULTS.background,
);

// ================= 2. env override + isolation =================
section("env-override isolation (T2)");

cleanEnv();
process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
process.env.OPENAI_API_KEY = "sk-test-key";
process.env.LLM_MODEL_COPY = "claude-opus-5";
ok(
  "COPY override respected",
  llmRoutingStatus().copy.model === "claude-opus-5",
);
ok(
  "COPY override source=env",
  llmRoutingStatus().copy.source === "env",
);
ok(
  "COPY override does not move bulk",
  llmRoutingStatus().bulk.model === "gpt-5-nano",
);
ok(
  "COPY override does not move background",
  llmRoutingStatus().background.model === "gpt-5-nano:flex",
);
ok(
  "resolveWorkloadModel bulk source=default",
  resolveWorkloadModel("bulk").source === "default",
);

// legacy LLM_MODEL: bulk-only, never copy
cleanEnv();
process.env.LLM_API_KEY = "sk-test-key";
process.env.LLM_MODEL = "gpt-4o-mini";
ok(
  "legacy LLM_MODEL honored for bulk (grandfathered)",
  getLlmProvider().name === "openai-compatible",
);
ok(
  "legacy LLM_MODEL does not redirect copy",
  resolveWorkloadModel("copy").model === "claude-haiku-4-5",
);
ok(
  "legacy source labeled",
  resolveWorkloadModel("bulk").source === "legacy",
);

// ================= 3. allow-list enforcement =================
section("ZDR allow-list enforcement (T1)");

cleanEnv();
process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
process.env.LLM_MODEL_COPY = "claude-fable-5"; // covered model: 30-day retention mandated
ok(
  "non-ZDR Anthropic model → mock",
  getLlmProviderFor("copy").name === "mock",
);
ok(
  "non-ZDR fallback is loud",
  warnings.some((w) => /not a ZDR-eligible/i.test(w)),
);

cleanEnv();
process.env.OPENAI_API_KEY = "sk-test-key";
process.env.LLM_MODEL_BULK = "gpt-4o-mini"; // served, but not ZDR-allow-listed
ok(
  "non-allow-listed OpenAI model → mock",
  getLlmProviderFor("bulk").name === "mock",
);

cleanEnv();
process.env.OPENAI_API_KEY = "sk-test-key";
process.env.LLM_MODEL_BULK = "bogus-model-xyz";
ok("unknown model string → mock", getLlmProviderFor("bulk").name === "mock");
ok(
  "unknown model fallback is loud",
  warnings.some((w) => /unknown model/i.test(w)),
);

// ================= 4. blocked families =================
section("blocked families can never be selected (T1)");

for (const killed of [
  "deepseek-flash",
  "deepseek-v4-pro",
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
]) {
  for (const envVar of [
    "LLM_MODEL_COPY",
    "LLM_MODEL_BULK",
    "LLM_MODEL_BACKGROUND",
  ] as const) {
    cleanEnv();
    process.env.OPENAI_API_KEY = "sk-test-key";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    process.env[envVar] = killed;
    const w = (
      envVar === "LLM_MODEL_COPY"
        ? "copy"
        : envVar === "LLM_MODEL_BULK"
          ? "bulk"
          : "background"
    ) as "copy" | "bulk" | "background";
    ok(
      `${killed} via ${envVar} → mock`,
      getLlmProviderFor(w).name === "mock",
    );
  }
}
ok(
  "blocked-family fallback names the policy",
  warnings.some((w) => /blocked/i.test(w)),
);

// ================= 5. self-host Qwen gating =================
section("self-host Qwen gating (T1)");

cleanEnv();
process.env.LLM_API_KEY = "dummy";
process.env.LLM_MODEL_BULK = "qwen3.8-27b";
ok(
  "Qwen without LLM_SELF_HOST → mock (cloud terms unverified)",
  getLlmProviderFor("bulk").name === "mock",
);

cleanEnv();
process.env.LLM_SELF_HOST = "1";
process.env.LLM_API_KEY = "dummy";
process.env.LLM_BASE_URL = "http://localhost:8000/v1";
process.env.LLM_MODEL_BULK = "qwen3.8-27b";
ok(
  "Qwen with LLM_SELF_HOST=1 → openai-compatible",
  getLlmProviderFor("bulk").name === "openai-compatible",
);

// block-list still wins even in self-host
cleanEnv();
process.env.LLM_SELF_HOST = "1";
process.env.LLM_API_KEY = "dummy";
process.env.LLM_MODEL_BULK = "deepseek-flash";
ok(
  "deepseek blocked even with LLM_SELF_HOST=1",
  getLlmProviderFor("bulk").name === "mock",
);

// ================= 6. key-material leakage =================
section("no key material in errors/status/logs (T3)");

cleanEnv();
const ANT_KEY = "sk-ant-secret-test-key-AAA111";
const OAI_KEY = "sk-live-secret-test-key-BBB222";
process.env.ANTHROPIC_API_KEY = ANT_KEY;
process.env.OPENAI_API_KEY = OAI_KEY;
process.env.LLM_MODEL_COPY = "deepseek-flash"; // force a loud fallback
getLlmProviderFor("copy");
getLlmProviderFor("bulk");
const statusJson = JSON.stringify(llmStatus());
const warnBlob = warnings.join("\n");
ok("status payload has no anthropic key", !statusJson.includes(ANT_KEY));
ok("status payload has no openai key", !statusJson.includes(OAI_KEY));
ok("fallback warnings have no anthropic key", !warnBlob.includes(ANT_KEY));
ok("fallback warnings have no openai key", !warnBlob.includes(OAI_KEY));
ok(
  "status exposes configured as boolean",
  typeof JSON.parse(statusJson).configured === "boolean",
);

// adapter error paths must not echo keys
{
  const { AnthropicLlmProvider } = await import("../lib/llm/anthropic.js");
  const p = new AnthropicLlmProvider(ANT_KEY, "claude-haiku-4-5");
  let msg = "";
  try {
    // Offline: the SDK call will fail on network — we only inspect the message.
    await p.generate("hi", { maxTokens: 8 });
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  ok("anthropic error path leaks no key", !msg.includes(ANT_KEY), msg.slice(0, 80));
}

// ================= 7. mock honesty + contract shapes =================
section("mock honesty and contract shapes (T7)");

cleanEnv();
const m = getLlmProviderFor("copy");
ok("mock name", m.name === "mock");
ok("mock isLive=false", m.isLive === false);
ok("mock isConfigured()=true", m.isConfigured() === true);
ok("generate is a function", typeof m.generate === "function");

const st = llmStatus();
for (const w of ["copy", "bulk", "background"] as const) {
  const r = st.routing[w];
  ok(`routing.${w} has name`, typeof r.name === "string");
  ok(`routing.${w} has isLive`, typeof r.isLive === "boolean");
  ok(`routing.${w} has configured`, typeof r.configured === "boolean");
  ok(`routing.${w} has model`, typeof r.model === "string");
  ok(`routing.${w} has source`, ["env", "legacy", "default"].includes(r.source));
}
ok("llmStatus keeps top-level name", typeof st.name === "string");
ok("llmStatus keeps top-level isLive", typeof st.isLive === "boolean");
ok("llmStatus keeps top-level model", typeof st.model === "string");

// allow-lists contain exactly the ZDR-eligible models from research
ok(
  "ANTHROPIC_ZDR_MODELS = haiku-4-5/sonnet-5/opus-5 + opus-5-5/sonnet-5-5 (Phase 7)",
  JSON.stringify([...ANTHROPIC_ZDR_MODELS].sort()) ===
    JSON.stringify(["claude-haiku-4-5", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5", "claude-sonnet-5-5"]),
);
ok(
  "covered models are never on the ZDR list",
  !(ANTHROPIC_ZDR_MODELS as readonly string[]).some((m) => /fable|mythos/i.test(m)),
);
ok(
  "ANTHROPIC_RETENTION_MODELS = fable-5-1 only",
  JSON.stringify([...ANTHROPIC_RETENTION_MODELS]) === JSON.stringify(["claude-fable-5-1"]),
);
ok("OPENAI_ZDR_MODELS includes gpt-5.5 (Phase 7)", (OPENAI_ZDR_MODELS as readonly string[]).includes("gpt-5.5"));
ok(
  "OPENAI_ZDR_MODELS includes nano + flex",
  (OPENAI_ZDR_MODELS as readonly string[]).includes("gpt-5-nano") &&
    (OPENAI_ZDR_MODELS as readonly string[]).includes("gpt-5-nano:flex"),
);

// ================= 8. single-key mode (Phase 6, T10) =================
section("single-key mode (T10)");

cleanEnv();
process.env.OPENAI_API_KEY = "sk-test-key";
{
  const st = llmRoutingStatus();
  ok("OpenAI-only: copy is live", st.copy.isLive === true);
  ok("OpenAI-only: copy routed to the OpenAI copy default", st.copy.model === FAMILY_WORKLOAD_DEFAULTS.openai.copy);
  ok("OpenAI-only: copy source stays default", st.copy.source === "default");
  ok("OpenAI-only: swap is explained", typeof st.copy.singleKey === "string" && /ANTHROPIC_API_KEY/.test(st.copy.singleKey));
  ok("OpenAI-only: bulk untouched", st.bulk.model === "gpt-5-nano" && st.bulk.singleKey === null);
}

cleanEnv();
process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
{
  const st = llmRoutingStatus();
  ok("Anthropic-only: bulk live on claude-haiku-4-5", st.bulk.isLive && st.bulk.model === "claude-haiku-4-5");
  ok("Anthropic-only: background live on claude-haiku-4-5", st.background.isLive && st.background.model === "claude-haiku-4-5");
}

cleanEnv();
process.env.OPENAI_API_KEY = "sk-test-key";
process.env.LLM_MODEL_COPY = "claude-haiku-4-5";
ok("explicit env model is never swapped (mock)", getLlmProviderFor("copy").name === "mock");

cleanEnv();
process.env.LLM_API_KEY = "";
process.env.OPENAI_API_KEY = "sk-test-key";
ok("empty LLM_API_KEY does not mask OPENAI_API_KEY", getLlmProviderFor("bulk").name === "openai-compatible");

cleanEnv();
process.env.LLM_SELF_HOST = "1";
process.env.LLM_API_KEY = "dummy";
ok("single-key mode off under self-host", resolveWorkload("copy").singleKey === null);

// ================= 9. failover (Phase 6, T9) =================
section("failover arming (T9)");

for (const fam of ["anthropic", "openai"] as const) {
  for (const w of ["copy", "bulk", "background"] as const) {
    ok(`family default ${fam}/${w} is routable`, isRoutableHostedModel(FAMILY_WORKLOAD_DEFAULTS[fam][w]));
  }
}
for (const killed of ["deepseek-flash", "gemini-3.8-flash", "qwen3.8-27b", "gpt-4o-mini", "claude-fable-5"]) {
  ok(`${killed} can never be a fallback`, !isRoutableHostedModel(killed));
}

cleanEnv();
process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
process.env.OPENAI_API_KEY = "sk-test-key";
{
  const st = llmRoutingStatus();
  ok("both keys: copy fails over to OpenAI", st.copy.failover === FAMILY_WORKLOAD_DEFAULTS.openai.copy);
  ok("both keys: bulk fails over to Anthropic", st.bulk.failover === "claude-haiku-4-5");
  ok("both keys: provider still reports the primary", getLlmProviderFor("copy").name === "anthropic");
}
process.env.LLM_FAILOVER = "0";
ok("LLM_FAILOVER=0 disarms failover", llmRoutingStatus().bulk.failover === null);

cleanEnv();
process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
ok("one key: no failover armed", llmRoutingStatus().copy.failover === null);

cleanEnv();
process.env.LLM_SELF_HOST = "1";
process.env.LLM_API_KEY = "dummy";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
process.env.LLM_MODEL_BULK = "qwen3.8-27b";
ok("self-host: never fails over to a hosted vendor", llmRoutingStatus().bulk.failover === null);

// ================= 10. agent workloads (Phase 7) =================
section("agent workloads (Phase 7)");

ok("LLM_WORKLOADS lists all seven", LLM_WORKLOADS.length === 7);
ok(
  "agent defaults",
  WORKLOAD_DEFAULTS.lead === "claude-opus-5-5" &&
    WORKLOAD_DEFAULTS.subagent === "claude-sonnet-5-5" &&
    WORKLOAD_DEFAULTS.code === "claude-opus-5-5" &&
    WORKLOAD_DEFAULTS.code_max === "claude-fable-5-1",
);
ok("lead effort medium, code effort high", WORKLOAD_EFFORT.lead === "medium" && WORKLOAD_EFFORT.code === "high");
for (const fam of ["anthropic", "openai"] as const) {
  for (const w of ["lead", "subagent", "code", "code_max"] as const) {
    ok(`family default ${fam}/${w} is routable`, isRoutableHostedModel(FAMILY_WORKLOAD_DEFAULTS[fam][w]));
  }
}

cleanEnv();
process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
process.env.OPENAI_API_KEY = "sk-test-key";
{
  const st = llmRoutingStatus();
  ok("both keys: lead live on claude-opus-5-5 at effort medium", st.lead.isLive && st.lead.model === "claude-opus-5-5" && st.lead.effort === "medium");
  ok("both keys: subagent live on claude-sonnet-5-5", st.subagent.isLive && st.subagent.model === "claude-sonnet-5-5");
  ok("both keys: code at effort high", st.code.model === "claude-opus-5-5" && st.code.effort === "high");
  ok("agent workloads fail over to gpt-5.5", ["lead", "subagent", "code", "code_max"].every((w) => st[w as "lead"].failover === "gpt-5.5"));
}
process.env.LLM_MODEL_LEAD = "gpt-5.5";
ok("an OpenAI lead fails over to claude-sonnet-5-5", llmRoutingStatus().lead.failover === "claude-sonnet-5-5");

cleanEnv();
process.env.OPENAI_API_KEY = "sk-test-key";
{
  const st = llmRoutingStatus();
  for (const w of ["lead", "subagent", "code", "code_max"] as const) {
    ok(`OpenAI-only: ${w} runs live on gpt-5.5`, st[w].isLive && st[w].model === "gpt-5.5" && st[w].singleKey !== null);
  }
}

ok("agent map: lead → lead", AGENT_WORKLOADS.lead === "lead");
ok("agent map: planner → lead", AGENT_WORKLOADS.planner === "lead");
ok("agent map: actor → subagent, build mode → code", workloadForAgent("actor") === "subagent" && workloadForAgent("actor", { mode: "build" }) === "code");
ok("agent map: others → subagent", (["researcher", "drafter", "analyst", "scheduler"] as const).every((k) => workloadForAgent(k) === "subagent"));

// ================= 11. covered models (Phase 7, T12) =================
section("covered (30-day-retention) models (T12)");

ok("claude-fable-5-1 is not routable without the opt-in", !isRoutableHostedModel("claude-fable-5-1"));
cleanEnv();
process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
{
  const r = resolveWorkload("code_max");
  ok("default code_max without opt-in → claude-opus-5-5 at effort max", r.requestedModel === "claude-opus-5-5" && r.effort === "max" && r.provider.isLive);
  ok("the swap is explained", r.retention?.from === "claude-fable-5-1" && /30-day data retention/.test(r.retention.reason));
}
process.env.LLM_MODEL_CODE_MAX = "claude-fable-5-1";
ok("explicit env fable without opt-in → mock (loud)", getLlmProviderFor("code_max").name === "mock" && warnings.some((w) => /30-day data retention/.test(w)));
process.env.LLM_ALLOW_RETENTION_MODELS = "1";
ok("opt-in: env fable routes live", getLlmProviderFor("code_max").name === "anthropic");
delete process.env.LLM_MODEL_CODE_MAX;
ok("opt-in: default code_max is fable", resolveWorkload("code_max").requestedModel === "claude-fable-5-1" && resolveWorkload("code_max").retention === null);
process.env.LLM_MODEL_COPY = "claude-fable-5";
ok("opt-in never widens to other covered models (fable-5)", getLlmProviderFor("copy").name === "mock");

// back-compat: getLlmProvider() still resolves bulk
cleanEnv();
ok("getLlmProvider() works with no keys", getLlmProvider().name === "mock");

console.warn = realWarn;
restoreEnv();

console.log(`\nverify-llm-routing: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("failures:\n - " + failures.join("\n - "));
  process.exit(1);
}
