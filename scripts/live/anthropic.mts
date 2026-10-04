// ShapesOS — Phase 9 live smoke: Anthropic (lib/llm/anthropic.ts generate()).
// One short request; costs a few hundred tokens.
// Run: LIVE_ANTHROPIC_API_KEY=… [LIVE_ANTHROPIC_MODEL=claude-opus-5-5] npx tsx scripts/live/anthropic.mts
import { AnthropicLlmProvider } from "@/lib/llm/anthropic";
import { finish, needEnv, optEnv, step } from "./_lib";

const env = needEnv("anthropic", ["LIVE_ANTHROPIC_API_KEY"]);
if (!env) process.exit(0);
const model = optEnv("LIVE_ANTHROPIC_MODEL", "claude-opus-5-5");
console.log(`anthropic: ${model}`);
const llm = new AnthropicLlmProvider(env.LIVE_ANTHROPIC_API_KEY, model);
await step(
  "generate",
  async () => {
    const text = await llm.generate("Reply with exactly the word: pong", { maxTokens: 2048 });
    if (!/pong/i.test(text)) throw new Error(`unexpected reply: ${text.slice(0, 80)}`);
    return text;
  },
  (t) => `replied "${t.trim().slice(0, 40)}"`,
);
finish("anthropic");
