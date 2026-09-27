// Marketr — Phase 11 "Canvas": Cloudinary upload pipeline (integration #7).
//
// The upload pipeline, not a stock tab: when Cloudinary is configured,
// browser uploads go direct-to-Cloudinary with a server-minted signature
// and design elements store Cloudinary DELIVERY URLs — never base64-in-JSON.
// When not configured, UploadsPanel keeps its local data-URL behavior with
// an honest empty state pointing at Settings → Providers.
//
// BYO-key pattern (same as Unsplash/LLM/DataForSEO): CLOUDINARY_CLOUD_NAME,
// CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET live on the host
// environment, are read server-side only, and the SECRET is never exposed
// to the browser — /api/studio/cloudinary/sign mints a time-scoped
// signature for the browser's direct upload instead.
//
// Delivery URLs always carry f_auto,q_auto (auto format/quality); the
// thumb/full variants below also unlock responsive variants later — noted,
// not built.
//
// SERVER ONLY — never import this from a "use client" module (it reads the
// API secret and node:crypto). Client-safe values (URLs, quota note) travel
// to the browser only inside API route responses.

import { createHash } from "node:crypto";

export const CLOUDINARY_UPLOAD_HOST = "https://api.cloudinary.com";
export const CLOUDINARY_RES_HOST = "https://res.cloudinary.com";

/** Server rejects sign requests for files bigger than this (10 MiB). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Cloudinary free tier on the user's own account (survey §8, Sept 2026). */
export const CLOUDINARY_FREE_TIER_CREDITS = 25;

/**
 * Honest quota note: uploads/transformation quota belongs to the user's own
 * Cloudinary account and is enforced by Cloudinary — Marketr never blocks
 * uploads on it. The meter event recorded at sign time gives per-tenant
 * upload counts for awareness only.
 */
export const CLOUDINARY_QUOTA_NOTE =
  "Uploads go to your own Cloudinary account (free tier: 25 credits/month). " +
  "Quota is metered by Cloudinary on your dashboard; Marketr records per-workspace upload counts for awareness only.";

/** Honest unconfigured-key message. Names the env vars; never their values. */
export const NOT_CONFIGURED_MESSAGE =
  "Image uploads need a free Cloudinary account. Add CLOUDINARY_CLOUD_NAME, " +
  "CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in Settings → Providers, then try again.";

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  /** NEVER leaves the server. */
  apiSecret: string;
}

/** Server-side only: reads env; the secret never leaves the server. */
export function getCloudinaryConfig(): CloudinaryConfig | null {
  const cloudName = (process.env.CLOUDINARY_CLOUD_NAME ?? "").trim();
  const apiKey = (process.env.CLOUDINARY_API_KEY ?? "").trim();
  const apiSecret = (process.env.CLOUDINARY_API_SECRET ?? "").trim();
  if (!cloudName || !apiKey || !apiSecret) return null;
  return { cloudName, apiKey, apiSecret };
}

/** Status shape mirrors lib/providers providerStatus() for the Settings UI. */
export function cloudinaryStatus() {
  const configured = getCloudinaryConfig() !== null;
  return { name: "cloudinary", isLive: configured, configured };
}

/**
 * Build the signature for a signed direct-from-browser upload, per
 * Cloudinary docs ("Generating authentication signatures"): the request
 * params (excluding file, cloud_name, resource_type, api_key and signature
 * itself) are sorted alphabetically as key=value pairs joined by &, the API
 * secret is appended, and the result is SHA-1 hex-digested.
 */
export function buildSignature(params: Record<string, string>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha1").update(toSign + apiSecret).digest("hex");
}

export type CloudinaryVariant = "full" | "thumb";

/**
 * Delivery-URL builder. Full-res carries f_auto,q_auto (Cloudinary picks the
 * best format — WebP/AVIF — and quality per client); the thumb variant caps
 * width at 400px for shelf previews. Same builder shape unlocks responsive
 * variants (w_800, w_1200…) later — noted, not built.
 */
export function buildDeliveryUrl(
  cloudName: string,
  publicId: string,
  variant: CloudinaryVariant = "full",
): string {
  const transforms = variant === "thumb" ? "w_400,f_auto,q_auto" : "f_auto,q_auto";
  return `${CLOUDINARY_RES_HOST}/${encodeURIComponent(cloudName)}/image/upload/${transforms}/${publicId}`;
}

/** Direct-from-browser upload endpoint for a signed POST. */
export function buildUploadUrl(cloudName: string): string {
  return `${CLOUDINARY_UPLOAD_HOST}/v1_1/${encodeURIComponent(cloudName)}/image/upload`;
}

/** Cloudinary-safe public id for a fresh upload (lowercase + digits + dash). */
export function newPublicId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `up-${Date.now().toString(36)}-${rand}`;
}

/** 400-class sign-request failure; the route maps it straight to JSON. */
export class SignParamError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "SignParamError";
  }
}

export interface SignRequest {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** Validate/normalize the /sign POST body. Throws SignParamError (400). */
export function parseSignRequest(body: unknown): SignRequest {
  if (typeof body !== "object" || body === null) {
    throw new SignParamError("Request body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;
  const filename = typeof b.filename === "string" ? b.filename.trim() : "";
  if (!filename) throw new SignParamError("filename is required.");
  if (filename.length > 120) {
    throw new SignParamError("filename is too long (max 120 characters).");
  }
  const mimeType = typeof b.mimeType === "string" ? b.mimeType.trim().toLowerCase() : "";
  if (!mimeType.startsWith("image/")) {
    throw new SignParamError("Only image uploads are supported.");
  }
  const sizeBytes = b.sizeBytes;
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw new SignParamError("sizeBytes must be a positive integer.");
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    throw new SignParamError(
      `File is too large (max ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB).`,
    );
  }
  return { filename, mimeType, sizeBytes };
}

export interface CloudinarySignPayload {
  /** POST the file + these fields straight to this URL from the browser. */
  uploadUrl: string;
  cloudName: string;
  /** Public identifier — safe in the browser per Cloudinary's own upload pattern. */
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  publicId: string;
  /** Full-res delivery URL (f_auto,q_auto) — stored in the design element. */
  deliveryUrl: string;
  /** w_400 delivery URL — shelf preview. */
  thumbUrl: string;
}

/**
 * Mint the client-safe signed-upload envelope. `now` is injectable for
 * tests; production uses the current time. Uploads are folder-scoped per
 * workspace (marketr/<workspaceId>) so a shared account stays organized.
 * The returned object is safe to send to the browser — it never contains
 * the API secret.
 */
export function buildSignPayload(
  config: CloudinaryConfig,
  workspaceId: string,
  now: number = Date.now(),
): CloudinarySignPayload {
  const timestamp = Math.floor(now / 1000);
  const folder = `marketr/${workspaceId}`;
  const publicId = newPublicId();
  const signature = buildSignature(
    { folder, public_id: publicId, timestamp: String(timestamp) },
    config.apiSecret,
  );
  return {
    uploadUrl: buildUploadUrl(config.cloudName),
    cloudName: config.cloudName,
    apiKey: config.apiKey,
    timestamp,
    signature,
    folder,
    publicId,
    deliveryUrl: buildDeliveryUrl(config.cloudName, publicId, "full"),
    thumbUrl: buildDeliveryUrl(config.cloudName, publicId, "thumb"),
  };
}
