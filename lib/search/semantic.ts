// ShapesOS — Phase 18.1 (WS=find): the query side of meaning-search.
//
// Reuses the local MiniLM embedder Growth Memory already runs
// (lib/substrate/memory/embed.ts — no external API). ⌘K must stay fast, so:
//   * the model loads once per process; until it has, Spotlight answers with
//     name + text matches and reports `semantic: "warming"` (the load is
//     started in the background, never awaited by a keystroke);
//   * a loaded model still gets a budget (SEMANTIC_BUDGET_MS); a slow embed
//     is dropped for that query ("skipped");
//   * a model that can't load is reported honestly ("unavailable"), never
//     faked;
//   * SPOTLIGHT_SEMANTIC=off disables it (e.g. a tiny box without the model).

import { embedText, toVectorLiteral, getEmbedder } from "@/lib/substrate/memory/embed";

export type SemanticStatus = "used" | "warming" | "skipped" | "unavailable" | "off";

export const SEMANTIC_BUDGET_MS = 350;
const MIN_SEMANTIC_CHARS = 3;

type Embed = (text: string) => Promise<number[]>;

let embedImpl: Embed = embedText;
let loaded = false;
let loading: Promise<void> | null = null;
let failed = false;

/** Tests inject a deterministic embedder (and reset the load state). */
export function setSpotlightEmbedder(fn: Embed | null): void {
  embedImpl = fn ?? embedText;
  loaded = fn !== null;
  loading = null;
  failed = false;
}

/** Start loading the model in the background (idempotent). */
export function warmSpotlightEmbedder(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) {
    loading = (embedImpl === embedText ? getEmbedder().then(() => undefined) : Promise.resolve())
      .then(() => {
        loaded = true;
      })
      .catch(() => {
        failed = true;
        loading = null;
      });
  }
  return loading;
}

/** True once the embedder is loaded in this process (uploads embed right away then). */
export function spotlightEmbedderLoaded(): boolean {
  return loaded;
}

export function semanticEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SPOTLIGHT_SEMANTIC ?? "on").toLowerCase() !== "off";
}

/** Embed the query for meaning-search, within the budget. */
export async function queryVector(
  text: string,
  opts: { budgetMs?: number; wait?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<{ vector: string | null; status: SemanticStatus }> {
  if (!semanticEnabled(opts.env)) return { vector: null, status: "off" };
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length < MIN_SEMANTIC_CHARS) return { vector: null, status: "skipped" };
  if (failed && !loading) {
    // Try again in the background next time; report honestly now.
    failed = false;
    void warmSpotlightEmbedder();
    return { vector: null, status: "unavailable" };
  }
  if (!loaded) {
    const warm = warmSpotlightEmbedder();
    if (!opts.wait) return { vector: null, status: "warming" };
    await warm;
    if (!loaded) return { vector: null, status: "unavailable" };
  }
  const budget = opts.budgetMs ?? SEMANTIC_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const vec = await Promise.race([
      embedImpl(clean),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budget);
      }),
    ]);
    if (!vec) return { vector: null, status: "skipped" };
    return { vector: toVectorLiteral(vec), status: "used" };
  } catch {
    return { vector: null, status: "unavailable" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
