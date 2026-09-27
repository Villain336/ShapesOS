import configPromise from "@payload-config";
import {
  REST_DELETE,
  REST_GET,
  REST_OPTIONS,
  REST_PATCH,
  REST_POST,
  REST_PUT,
} from "@payloadcms/next/routes";

/**
 * Payload REST API at /cms-api/* (Phase 12).
 *
 * Deliberately NOT /api/*: Marketr's own API lives there (e.g. /api/media
 * would collide with Payload's media endpoint) and proxy.ts rate-limits
 * /api/:path*. Each handler is route-scoped, so Payload server code only
 * loads for /cms-api requests.
 */
export const GET = REST_GET(configPromise);
export const POST = REST_POST(configPromise);
export const DELETE = REST_DELETE(configPromise);
export const PATCH = REST_PATCH(configPromise);
export const PUT = REST_PUT(configPromise);
export const OPTIONS = REST_OPTIONS(configPromise);
