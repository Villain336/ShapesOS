// ShapesOS — Phase 19B (WS=panel): every Dress Rehearsal model call.
// Commercial layer (entitlement dress_rehearsal). See lib/panel/README.md.
//
// Replaces the prototype's src/llm/backend.ts (its own OpenAI / Anthropic
// HTTP clients) and src/llm/cache.ts. Every call now:
//   1. goes through the ShapesOS router — a workspace-bound LlmProvider from
//      getLlmProviderForWorkspace(), so it is checked against the workspace's
//      credit cap before it is sent and metered through meter() after
//      (lib/llm/usage.ts, an `llm_tokens` usage event);
//   2. asks for STRUCTURED output: one tool whose input schema is the zod
//      schema of the answer, with tool_choice forced to it (where a model
//      rejects forced choice the adapter sends "auto" and the prompt names the
//      tool). The prototype set `jsonMode`, which its Anthropic backend
//      silently ignored, then regex-parsed `{…}` out of free text;
//   3. reserves its worst case on the run's PanelLedger first and settles
//      the actual credits after (lib/panel/budget.ts) — the hard per-run cap.
// An answer that fails its schema is retried ONCE with the reason (both
// attempts are reserved and charged); a second failure throws
// PanelModelOutputError, and callers decide how to degrade honestly.

import { z } from "zod";
import type { ChatJsonSchema, ChatMessage, ChatUsage, LlmProvider } from "@/lib/llm/types";
import { PanelLedger, worstCaseCallCredits, type Reservation } from "./budget";

export interface StructuredTool<T> {
  /** Tool name the model must call, e.g. "submit_step". */
  name: string;
  description: string;
  schema: z.ZodType<T>;
}

export interface StructuredRequest<T> {
  /** What the call is for (ledger breakdown): step | judge | verdict | fix | derive | reflect. */
  purpose: string;
  system: string;
  user: string;
  tool: StructuredTool<T>;
  maxTokens: number;
}

export interface StructuredResult<T> {
  value: T;
  credits: number;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  /** True when the answer came from the run's cache (never sent, 0 credits). */
  cached?: boolean;
}

/** The model seam every panel module talks to. */
export interface PanelModel {
  /** The model the run is priced on (estimates use it). */
  readonly model: string;
  /** "live" = a real router provider; "fake" = the labelled deterministic test model. */
  readonly kind: "live" | "fake";
  structured<T>(runId: string, req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export class PanelModelOutputError extends Error {
  constructor(
    readonly purpose: string,
    readonly reason: string,
  ) {
    super(`The model's ${purpose} answer did not match its schema twice: ${reason}`);
    this.name = "PanelModelOutputError";
  }
}

const jsonSchemaCache = new WeakMap<object, ChatJsonSchema>();

/** The tool input schema for a zod schema (object at the top; $schema dropped). */
export function toolInputSchema(schema: z.ZodType): ChatJsonSchema {
  const hit = jsonSchemaCache.get(schema);
  if (hit) return hit;
  const raw = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete raw.$schema;
  if (raw.type !== "object") throw new Error("A structured tool's schema must be an object");
  const out = raw as ChatJsonSchema;
  jsonSchemaCache.set(schema, out);
  return out;
}

function zodReason(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/**
 * Structured output over a router LlmProvider, metered by the provider and
 * capped by the ledger. `provider` should be workspace-bound
 * (getLlmProviderForWorkspace) so the call is gated and metered for the
 * workspace; `model` is the resolved model id the run is priced on.
 */
export class RouterPanelModel implements PanelModel {
  readonly kind: "live" | "fake";

  constructor(
    private readonly provider: LlmProvider,
    readonly model: string,
    private readonly ledger: PanelLedger,
    opts: { kind?: "live" | "fake" } = {},
  ) {
    this.kind = opts.kind ?? (provider.isLive ? "live" : "fake");
  }

  async structured<T>(runId: string, req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const inputSchema = toolInputSchema(req.tool.schema);
    const toolDef = { name: req.tool.name, description: req.tool.description, inputSchema };
    const system = `${req.system}\n\nAnswer ONLY by calling the ${req.tool.name} tool exactly once.`;
    const messages: ChatMessage[] = [{ role: "user", content: req.user }];
    let lastReason = "no tool call";
    let credits = 0;
    let usage = { inputTokens: 0, outputTokens: 0 };
    let model = this.model;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const promptChars = system.length + JSON.stringify(inputSchema).length + messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0);
      const reservation: Reservation = this.ledger.reserve(runId, worstCaseCallCredits(this.model, promptChars, req.maxTokens));
      let res;
      try {
        res = await this.provider.chat({
          system,
          messages,
          tools: [toolDef],
          toolChoice: { name: req.tool.name },
          maxTokens: req.maxTokens,
        });
      } catch (err) {
        this.ledger.release(reservation);
        throw err;
      }
      const u: ChatUsage = res.usage;
      // Price on the model the router actually used (failover can change it).
      model = res.model && res.model !== "mock" ? res.model : this.model;
      credits += this.ledger.settle(reservation, model, u, req.purpose);
      usage = { inputTokens: usage.inputTokens + u.inputTokens, outputTokens: usage.outputTokens + u.outputTokens };
      const block = res.content.find((b) => b.type === "tool_use" && b.name === req.tool.name);
      if (block && block.type === "tool_use") {
        if (block.invalid) {
          lastReason = block.invalid;
        } else {
          const parsed = req.tool.schema.safeParse(block.input);
          if (parsed.success) return { value: parsed.data, credits, model, usage };
          lastReason = zodReason(parsed.error);
        }
        messages.push(
          { role: "assistant", content: [block] },
          { role: "user", content: [{ type: "tool_result", toolUseId: block.id, isError: true, content: `Invalid input: ${lastReason}. Call ${req.tool.name} again with a corrected answer.` }] },
        );
      } else {
        lastReason = res.stopReason === "refusal" ? "the model refused" : `no ${req.tool.name} call (stop: ${res.stopReason})`;
        const text = res.content.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : "")).join("");
        messages.push({ role: "assistant", content: text || "(no answer)" }, { role: "user", content: `You must call the ${req.tool.name} tool. Call it now.` });
      }
    }
    throw new PanelModelOutputError(req.purpose, lastReason);
  }
}

// ---------------------------------------------------------------------------
// Per-run cache (ported from the prototype's CachedBackend)
// ---------------------------------------------------------------------------

/** FNV-1a 64-bit — deterministic cache keys. */
function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of Buffer.from(input, "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export interface CacheStats {
  hits: number;
  misses: number;
  /** Credits the hits would have cost (what the cache saved). */
  savedCredits: number;
}

/**
 * Memoizes identical structured calls within one run (same model, system,
 * prompt, tool and maxTokens — a different model is always a miss). A hit is
 * never sent and costs 0 credits; the prototype ledgered hits at full price.
 */
export class CachedPanelModel implements PanelModel {
  private readonly entries = new Map<string, StructuredResult<unknown>>();
  private hits = 0;
  private misses = 0;
  private savedCredits = 0;

  constructor(private readonly inner: PanelModel) {}

  get model(): string {
    return this.inner.model;
  }

  get kind(): "live" | "fake" {
    return this.inner.kind;
  }

  async structured<T>(runId: string, req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const key = fnv1a64(JSON.stringify({ model: this.inner.model, system: req.system, user: req.user, tool: req.tool.name, maxTokens: req.maxTokens }));
    const hit = this.entries.get(key) as StructuredResult<T> | undefined;
    if (hit) {
      this.hits += 1;
      this.savedCredits += hit.credits;
      return { ...hit, credits: 0, cached: true };
    }
    const out = await this.inner.structured(runId, req);
    this.misses += 1;
    this.entries.set(key, out as StructuredResult<unknown>);
    return out;
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, savedCredits: this.savedCredits };
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    this.savedCredits = 0;
  }
}
