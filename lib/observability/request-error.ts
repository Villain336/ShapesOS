// ShapesOS — errors Next.js caught itself (instrumentation.ts onRequestError):
// render, route handler, server action and proxy errors that no route-level
// errorResponse() handled. Logged as one structured line and reported to
// Sentry when configured. Headers other than the request id are never read.

import { log, sanitizeRequestId, REQUEST_ID_HEADER } from "./log";
import { captureException } from "./sentry";

export interface NextRequestInfo {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface NextErrorContext {
  routerKind?: string;
  routePath?: string;
  routeType?: string;
  renderSource?: string;
}

function header(h: NextRequestInfo["headers"], name: string): string | null {
  const v = h?.[name];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export async function reportRequestError(
  err: unknown,
  request: NextRequestInfo,
  context: NextErrorContext,
): Promise<void> {
  const requestId = sanitizeRequestId(header(request.headers, REQUEST_ID_HEADER));
  const path = (request.path ?? "").split(/[?#]/)[0];
  const digest =
    typeof err === "object" && err !== null && "digest" in err ? String((err as { digest?: unknown }).digest) : undefined;
  log.error("unhandled request error", {
    requestId,
    method: request.method,
    path,
    route: context.routePath,
    routeType: context.routeType,
    digest,
    err,
  });
  await captureException(err, {
    route: context.routePath,
    method: request.method,
    path,
    requestId,
    routeType: context.routeType,
    digest,
  });
}
