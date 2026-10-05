// ShapesOS — the single image service (Phase 7, owner decision 2026-10-04:
// image generation everywhere uses OpenAI's image model, the one ChatGPT
// uses; the text-model setup is unchanged).
//
// Every image in the OS goes through here: the Studio AI panel route
// (app/api/studio/designs/generate-image), the `generate_image` chat tool
// (lib/images/tool.ts) and the Batch helper (lib/images/batch.ts).
//
// Checked against the OpenAI API reference and image-generation guide on
// 2026-10-04 (developers.openai.com/api/reference/resources/images/*):
//   - `response_format` is "Deprecated. Legacy response format parameter for
//     retired image models. Unsupported for GPT image models, which always
//     return base64-encoded images." → NEVER sent. We read data[].b64_json.
//   - `quality`: low | medium | high for the GPT image models (2.5 adds
//     xhigh/max; not exposed here). Omitted = the API's `auto`.
//   - `size`: 1024x1024 / 1536x1024 / 1024x1536 / auto for every GPT image
//     model; gpt-image-2 and gpt-image-2.5-* also take WIDTHxHEIGHT with both
//     edges multiples of 16, long:short ≤ 3:1, max edge 3840, and
//     655,360–8,294,400 total pixels.
//   - `background`: transparent | opaque | auto; transparent needs png/webp
//     output (we always ask for png). For gpt-image-2 transparency is
//     "in preview".
//   - `/images/edits` takes multipart `image[]` (up to 16 reference images)
//     plus an optional `mask` (PNG with an alpha channel, same size as the
//     first image; it applies to the first image). `input_fidelity` must be
//     omitted for gpt-image-2, so it is never sent.
//   - `usage` is documented "for gpt-image-1 only"; it is returned to the
//     caller when present and is null otherwise.
//
// Key resolution is the LLM router's (openAiApiKey / openAiBaseUrl), and the
// model must be on the router's separate image allow-list
// (OPENAI_IMAGE_ZDR_MODELS). Errors are LlmProviderError from
// lib/llm/errors.ts, so retryability means the same thing everywhere
// (429 / 5xx / timeout / network retryable; other 4xx not). Messages carry
// the HTTP status and a whitelisted error code only — never the key, never
// the response body, never the prompt.
//
// NOTE: the live calls are exercised offline against a stub fetch only
// (lib/images/__tests__/openai.test.ts). UNVERIFIED-LIVE until run on a host
// with a real key.

import {
  DEFAULT_IMAGE_MODEL,
  OPENAI_IMAGE_ZDR_MODELS,
  isAllowedImageModel,
  openAiApiKey,
  openAiBaseUrl,
} from "@/lib/llm/router";
import { LlmProviderError, kindForStatus, parseRetryAfter } from "@/lib/llm/errors";

export const IMAGE_PROVIDER = "openai-images";
/** High-quality large images can take minutes; this is per attempt. */
export const IMAGE_DEFAULT_TIMEOUT_MS = 240_000;
/** Longest Retry-After we sleep through before giving up. */
const MAX_RETRY_AFTER_MS = 30_000;

export const IMAGE_QUALITIES = ["low", "medium", "high"] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];

export const IMAGE_BACKGROUNDS = ["transparent", "opaque", "auto"] as const;
export type ImageBackground = (typeof IMAGE_BACKGROUNDS)[number];

/** Sizes every GPT image model accepts. */
export const STANDARD_IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536", "auto"] as const;

/** Max reference images on /images/edits (GPT image models). */
export const MAX_EDIT_IMAGES = 16;
/** "The image to edit and mask must be … less than 50MB in size." */
export const MAX_EDIT_IMAGE_BYTES = 50 * 1024 * 1024;

export type EnvLike = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Thrown before any network call when the service can't run. Not retryable. */
export class ImageConfigError extends Error {
  readonly code: "image_not_configured" | "image_model_not_allowed";
  constructor(code: ImageConfigError["code"], message: string) {
    super(message);
    this.name = "ImageConfigError";
    this.code = code;
  }
}

/** Thrown for arguments the API would reject anyway (caught before spend). */
export class ImageRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRequestError";
  }
}

export const IMAGE_NOT_CONFIGURED_MESSAGE =
  "Image generation needs an OpenAI key. Add OPENAI_API_KEY in Settings → Providers, then try again.";

/** The model in effect: LLM_IMAGE_MODEL when set, else gpt-image-2. */
export function resolveImageModel(env: EnvLike = process.env): { model: string; source: "env" | "default" } {
  const fromEnv = (env.LLM_IMAGE_MODEL ?? "").trim();
  return fromEnv ? { model: fromEnv, source: "env" } : { model: DEFAULT_IMAGE_MODEL, source: "default" };
}

export interface ImageServiceStatus {
  /** A key is set AND the model is allowed — a request would go out. */
  live: boolean;
  configured: boolean;
  model: string;
  modelAllowed: boolean;
  /** Plain-language reason when not live. Never contains key material. */
  reason: string | null;
}

/** Pure status for Settings → Providers and pre-flight checks. */
export function imageServiceStatus(env: EnvLike = process.env): ImageServiceStatus {
  const configured = Boolean(openAiApiKey(env));
  const { model } = resolveImageModel(env);
  const modelAllowed = isAllowedImageModel(model);
  const reason = !configured
    ? "Image generation needs an OpenAI key."
    : !modelAllowed
      ? `LLM_IMAGE_MODEL "${model}" is not on the OpenAI image allow-list (${OPENAI_IMAGE_ZDR_MODELS.join(", ")}).`
      : null;
  return { live: configured && modelAllowed, configured, model, modelAllowed, reason };
}

interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

function resolveConfig(env: EnvLike, modelOverride?: string): ResolvedConfig {
  const apiKey = openAiApiKey(env);
  if (!apiKey) throw new ImageConfigError("image_not_configured", IMAGE_NOT_CONFIGURED_MESSAGE);
  const model = (modelOverride ?? "").trim() || resolveImageModel(env).model;
  if (!isAllowedImageModel(model)) {
    throw new ImageConfigError(
      "image_model_not_allowed",
      `Image model "${model}" is not on the OpenAI image allow-list; refusing to send it.`,
    );
  }
  return { apiKey, baseUrl: openAiBaseUrl(env), model };
}

// ---------------------------------------------------------------------------
// Validation (pure, exported for tests and the tool)
// ---------------------------------------------------------------------------

/** gpt-image-2 and gpt-image-2.5-* accept arbitrary WIDTHxHEIGHT sizes. */
export function supportsCustomSizes(model: string): boolean {
  return /^gpt-image-2($|[.-])/.test(model);
}

/** Validate a size for a model; returns the canonical string or throws. */
export function validateImageSize(size: string, model: string): string {
  const s = size.trim().toLowerCase();
  if ((STANDARD_IMAGE_SIZES as readonly string[]).includes(s)) return s;
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(s);
  if (!m || !supportsCustomSizes(model)) {
    throw new ImageRequestError(
      supportsCustomSizes(model)
        ? `Invalid size "${size}". Use 1024x1024, 1536x1024, 1024x1536, auto, or WIDTHxHEIGHT.`
        : `Invalid size "${size}" for ${model}. Use 1024x1024, 1536x1024, 1024x1536 or auto.`,
    );
  }
  const w = Number(m[1]);
  const h = Number(m[2]);
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  const pixels = w * h;
  if (w % 16 !== 0 || h % 16 !== 0) throw new ImageRequestError("Both image edges must be multiples of 16px.");
  if (long > 3840) throw new ImageRequestError("The longest image edge can be at most 3840px.");
  if (long > short * 3) throw new ImageRequestError("The image aspect ratio can be at most 3:1.");
  if (pixels < 655_360 || pixels > 8_294_400) {
    throw new ImageRequestError("The image must have between 655,360 and 8,294,400 pixels.");
  }
  return `${w}x${h}`;
}

export function isImageQuality(v: unknown): v is ImageQuality {
  return typeof v === "string" && (IMAGE_QUALITIES as readonly string[]).includes(v);
}

function validateQuality(q: unknown): ImageQuality | undefined {
  if (q === undefined || q === null) return undefined;
  if (!isImageQuality(q)) throw new ImageRequestError(`Invalid quality "${String(q)}". Use low, medium or high.`);
  return q;
}

function validateBackground(b: unknown): ImageBackground | undefined {
  if (b === undefined || b === null) return undefined;
  if (typeof b !== "string" || !(IMAGE_BACKGROUNDS as readonly string[]).includes(b)) {
    throw new ImageRequestError(`Invalid background "${String(b)}". Use transparent, opaque or auto.`);
  }
  return b as ImageBackground;
}

function validateN(n: unknown): number {
  if (n === undefined || n === null) return 1;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 10) {
    throw new ImageRequestError("n must be a whole number from 1 to 10.");
  }
  return n;
}

function validatePrompt(p: unknown): string {
  const prompt = typeof p === "string" ? p.trim() : "";
  if (!prompt) throw new ImageRequestError("A prompt is required.");
  if (prompt.length > 32_000) throw new ImageRequestError("The prompt can be at most 32,000 characters.");
  return prompt;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ImageUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  inputImageTokens: number | null;
  inputTextTokens: number | null;
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: "image/png";
}

export interface ImageResult {
  images: GeneratedImage[];
  model: string;
  /** The size the API reports (or the one requested). */
  size: string | null;
  quality: string | null;
  /** Token usage when the API reports it (documented for gpt-image-1). */
  usage: ImageUsage | null;
}

export interface ImageCallOptions {
  /** Per-attempt timeout (default 240 s). */
  timeoutMs?: number;
  /** The caller's abort (Phase 5 Stop). Surfaces as the abort itself. */
  signal?: AbortSignal;
  /** Retries after the first attempt for 429/5xx/network (default 1, max 1). */
  maxRetries?: number;
  /** Override the model (still allow-listed). Defaults to LLM_IMAGE_MODEL / gpt-image-2. */
  model?: string;
  /** Test seams. */
  env?: EnvLike;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface GenerateImageInput {
  prompt: string;
  /** 1024x1024 | 1536x1024 | 1024x1536 | auto | WIDTHxHEIGHT (gpt-image-2+). Default 1024x1024. */
  size?: string;
  /** Omitted = the API default (auto). */
  quality?: ImageQuality;
  background?: ImageBackground;
  n?: number;
}

export interface ImageFileInput {
  bytes: Buffer | Uint8Array;
  /** Shown to the API as the multipart filename. */
  filename?: string;
  mimeType?: "image/png" | "image/jpeg" | "image/webp";
}

export interface EditImageInput {
  prompt: string;
  /** 1–16 reference images (a brand-kit logo, a product photo …). */
  images: ImageFileInput[];
  /** PNG with an alpha channel; transparent areas are edited (first image). */
  mask?: ImageFileInput;
  size?: string;
  quality?: ImageQuality;
  background?: ImageBackground;
  n?: number;
}

// ---------------------------------------------------------------------------
// Request bodies (exported for tests and the Batch helper)
// ---------------------------------------------------------------------------

/** The JSON body for /images/generations. Never includes response_format. */
export function buildGenerationBody(model: string, input: GenerateImageInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    prompt: validatePrompt(input.prompt),
    size: validateImageSize(input.size ?? "1024x1024", model),
    n: validateN(input.n),
    output_format: "png",
  };
  const quality = validateQuality(input.quality);
  if (quality) body.quality = quality;
  const background = validateBackground(input.background);
  if (background) body.background = background;
  return body;
}

function sniffMime(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** A filesystem-safe stem from a caller-supplied name (never a path). */
export function imageFileStem(name: string | undefined | null, fallback = "image"): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const stem = base
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return stem || fallback;
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

function toBlobPart(f: ImageFileInput, label: string): { blob: Blob; filename: string } {
  // Copy into a plain ArrayBuffer-backed view (Blob wants one; a Buffer may
  // be a slice of Node's shared pool).
  const bytes = new Uint8Array(f.bytes.length);
  bytes.set(f.bytes);
  if (bytes.length === 0) throw new ImageRequestError(`${label} is empty.`);
  if (bytes.length > MAX_EDIT_IMAGE_BYTES) throw new ImageRequestError(`${label} is larger than 50 MB.`);
  // The bytes decide the type, never the caller's label.
  const mime = sniffMime(bytes);
  if (!mime) throw new ImageRequestError(`${label} must be a PNG, JPEG or WebP image.`);
  return { blob: new Blob([bytes], { type: mime }), filename: `${imageFileStem(f.filename)}.${EXT[mime]}` };
}

/** The multipart body for /images/edits (image[] + optional mask). */
export function buildEditForm(model: string, input: EditImageInput): FormData {
  const prompt = validatePrompt(input.prompt);
  const images = Array.isArray(input.images) ? input.images : [];
  if (images.length === 0) throw new ImageRequestError("At least one reference image is required.");
  if (images.length > MAX_EDIT_IMAGES) throw new ImageRequestError(`At most ${MAX_EDIT_IMAGES} reference images.`);
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  images.forEach((img, i) => {
    const part = toBlobPart(img, `Reference image ${i + 1}`);
    form.append("image[]", part.blob, part.filename);
  });
  if (input.mask) {
    const part = toBlobPart(input.mask, "The mask");
    if (part.blob.type !== "image/png") throw new ImageRequestError("The mask must be a PNG with an alpha channel.");
    form.append("mask", part.blob, part.filename);
  }
  form.append("size", validateImageSize(input.size ?? "auto", model));
  form.append("n", String(validateN(input.n)));
  form.append("output_format", "png");
  const quality = validateQuality(input.quality);
  if (quality) form.append("quality", quality);
  const background = validateBackground(input.background);
  if (background) form.append("background", background);
  return form;
}

// ---------------------------------------------------------------------------
// Transport (shared with lib/images/batch.ts)
// ---------------------------------------------------------------------------

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Only short machine codes from an error body are echoed (never text). */
function safeErrorCode(json: unknown): string | null {
  const e = (json as { error?: { code?: unknown; type?: unknown } } | null)?.error;
  for (const v of [e?.code, e?.type]) {
    if (typeof v === "string" && /^[a-z0-9_.]{1,64}$/i.test(v)) return v;
  }
  return null;
}

export interface OpenAiRequest {
  method: "GET" | "POST";
  path: string;
  json?: unknown;
  form?: FormData;
  /** Read the body as text (JSONL file content) instead of JSON. */
  asText?: boolean;
}

/**
 * One authenticated OpenAI call with a timeout, the caller's abort, one
 * bounded retry on 429/5xx/network (honouring Retry-After), and classified
 * LlmProviderError failures. A timeout is NOT retried here: the request may
 * still be generating (and billing) server-side.
 */
export async function openAiImageRequest(
  cfg: { apiKey: string; baseUrl: string },
  req: OpenAiRequest,
  opts: ImageCallOptions = {},
): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = opts.sleep ?? abortableSleep;
  const maxRetries = Math.max(0, Math.min(opts.maxRetries ?? 1, 1));
  let lastErr: LlmProviderError | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0 && lastErr) {
      const wait = lastErr.retryAfterMs ?? Math.round(1_000 * (0.5 + Math.random() / 2));
      if (wait > MAX_RETRY_AFTER_MS) break;
      await sleep(wait, opts.signal);
    }
    try {
      return await requestOnce(cfg, req, opts, fetchImpl);
    } catch (err) {
      if (!(err instanceof LlmProviderError) || !err.retryable || err.kind === "timeout") throw err;
      lastErr = err;
    }
  }
  throw lastErr!;
}

async function requestOnce(
  cfg: { apiKey: string; baseUrl: string },
  req: OpenAiRequest,
  opts: ImageCallOptions,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? IMAGE_DEFAULT_TIMEOUT_MS;
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException("image request timed out", "TimeoutError")),
    timeoutMs,
  );
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal;
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${cfg.apiKey}` };
    let body: BodyInit | undefined;
    if (req.form) body = req.form; // fetch sets the multipart boundary
    else if (req.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.json);
    }
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.baseUrl}${req.path}`, { method: req.method, headers, body, signal });
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      if (timeout.signal.aborted) {
        throw new LlmProviderError({
          provider: IMAGE_PROVIDER,
          kind: "timeout",
          detail: `no response within ${Math.round(timeoutMs / 1000)}s`,
        });
      }
      throw new LlmProviderError({
        provider: IMAGE_PROVIDER,
        kind: "network",
        detail: `network error (${err instanceof Error ? err.name : "unknown"})`,
      });
    }

    if (!res.ok) {
      let code: string | null = null;
      try {
        code = safeErrorCode(await res.json());
      } catch {
        /* non-JSON error body — the status is enough */
      }
      throw new LlmProviderError({
        provider: IMAGE_PROVIDER,
        kind: kindForStatus(res.status),
        status: res.status,
        detail: `HTTP ${res.status}${code ? ` (${code})` : ""}`,
        retryAfterMs: parseRetryAfter(res.headers),
      });
    }

    try {
      return req.asText ? await res.text() : await res.json();
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      throw new LlmProviderError({
        provider: IMAGE_PROVIDER,
        kind: timeout.signal.aborted ? "timeout" : "server",
        status: res.status,
        detail: timeout.signal.aborted ? "timed out reading the response" : "unreadable response body",
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Parse an ImagesResponse body (sync call or one Batch output line). */
export function parseImagesResponse(json: unknown, model: string, requestedSize: string | null): ImageResult {
  const r = (json ?? {}) as {
    data?: Array<{ b64_json?: unknown }>;
    size?: unknown;
    quality?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      total_tokens?: unknown;
      input_tokens_details?: { image_tokens?: unknown; text_tokens?: unknown };
    };
  };
  const images: GeneratedImage[] = [];
  for (const d of Array.isArray(r.data) ? r.data : []) {
    if (typeof d?.b64_json !== "string" || !d.b64_json) continue;
    const bytes = Buffer.from(d.b64_json, "base64");
    if (bytes.length > 0) images.push({ bytes, mimeType: "image/png" });
  }
  if (images.length === 0) {
    throw new LlmProviderError({ provider: IMAGE_PROVIDER, kind: "empty", detail: "the image service returned no image" });
  }
  const u = r.usage;
  return {
    images,
    model,
    size: typeof r.size === "string" ? r.size : requestedSize,
    quality: typeof r.quality === "string" ? r.quality : null,
    usage: u
      ? {
          inputTokens: numOrNull(u.input_tokens),
          outputTokens: numOrNull(u.output_tokens),
          totalTokens: numOrNull(u.total_tokens),
          inputImageTokens: numOrNull(u.input_tokens_details?.image_tokens),
          inputTextTokens: numOrNull(u.input_tokens_details?.text_tokens),
        }
      : null,
  };
}

/** Resolve key, base URL and the allow-listed model (throws ImageConfigError). */
export function imageRequestConfig(opts: Pick<ImageCallOptions, "env" | "model"> = {}): ResolvedConfig {
  return resolveConfig(opts.env ?? process.env, opts.model);
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** Text → image(s) through /images/generations. */
export async function generateImage(input: GenerateImageInput, opts: ImageCallOptions = {}): Promise<ImageResult> {
  const cfg = imageRequestConfig(opts);
  const body = buildGenerationBody(cfg.model, input);
  const json = await openAiImageRequest(cfg, { method: "POST", path: "/images/generations", json: body }, opts);
  return parseImagesResponse(json, cfg.model, body.size as string);
}

/** Edit / inpaint from reference images through /images/edits (multipart). */
export async function editImage(input: EditImageInput, opts: ImageCallOptions = {}): Promise<ImageResult> {
  const cfg = imageRequestConfig(opts);
  const form = buildEditForm(cfg.model, input);
  const json = await openAiImageRequest(cfg, { method: "POST", path: "/images/edits", form }, opts);
  return parseImagesResponse(json, cfg.model, String(form.get("size") ?? "") || null);
}
