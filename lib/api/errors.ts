// ShapesOS — shared route error mapping (Phase 1, workstream D).
//
// errorResponse(err) turns anything a route handler throws into a JSON
// Response with the right status and a message that is safe to show:
//
//   HttpError and subclasses       → its status + its (client-authored) message
//   ZodError                       → 400 + field paths/messages (never values)
//   malformed JSON body            → 400
//   wrong Content-Type / bad form  → 415 / 400 (req.formData() TypeErrors)
//   Prisma P2025 (record missing)  → 404;  P2002/P2003 → 409;  bad input → 400
//   plain Error "… not found"      → 404 "Not found."
//   anything else                  → 500 "Internal server error"
//
// The real error behind a 500 is logged server-side and never echoed:
// library, database and provider messages can carry SQL, hostnames, env-var
// names or upstream response bodies. Library code that wants a client to see
// its message throws one of the HttpError subclasses below.
//
// Dependency-free on purpose (no zod/Prisma/Next imports) so any lib module
// can throw these without pulling route code in. The observability helpers
// it uses are dependency-free too.

import { log, requestIdFrom } from "../observability/log";
import { captureException } from "../observability/sentry";

export interface ErrorDetail {
  path: string;
  message: string;
}

export interface HttpErrorOptions {
  code?: string;
  details?: ErrorDetail[];
  /**
   * Whether the message may be sent to the client. Defaults to true (the
   * thrower wrote it for the client); pass false for a 5xx whose message is
   * diagnostic only — the client then gets the generic 500 text.
   */
  expose?: boolean;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: ErrorDetail[];
  readonly expose: boolean;
  constructor(status: number, message: string, opts?: HttpErrorOptions) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = opts?.code;
    this.details = opts?.details;
    this.expose = opts?.expose ?? true;
  }
}

export class BadRequestError extends HttpError {
  constructor(message = "Bad request.", opts?: HttpErrorOptions) {
    super(400, message, opts);
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "Forbidden") {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not found.") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

/** The request conflicts with the resource's current state (409). */
export class ConflictError extends HttpError {
  constructor(message = "Conflict.", opts?: HttpErrorOptions) {
    super(409, message, opts);
    this.name = "ConflictError";
  }
}

/** A feature that needs host configuration that isn't there (503). */
export class ServiceUnavailableError extends HttpError {
  constructor(message = "Service unavailable.") {
    super(503, message);
    this.name = "ServiceUnavailableError";
  }
}

export const INTERNAL_ERROR_MESSAGE = "Internal server error";

interface ZodLikeIssue {
  path: PropertyKey[];
  message: string;
}

/** ZodError check by shape, so it works across zod copies / v3 / v4 core. */
export function isZodError(err: unknown): err is Error & { issues: ZodLikeIssue[] } {
  return (
    err instanceof Error &&
    (err.name === "ZodError" || err.constructor?.name === "ZodError") &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

export function zodDetails(issues: ZodLikeIssue[]): ErrorDetail[] {
  return issues.slice(0, 10).map((issue) => ({
    path: issue.path.map(String).join(".") || "(root)",
    message: issue.message,
  }));
}

function prismaCode(err: unknown): string | null {
  if (!(err instanceof Error) || err.name !== "PrismaClientKnownRequestError") return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

type Mapped = { status: number; body: Record<string, unknown> };

/** Classify an error without side effects (exported for tests). */
export function classifyError(err: unknown): Mapped {
  if (err instanceof HttpError) {
    if (!err.expose) return { status: err.status, body: { error: INTERNAL_ERROR_MESSAGE } };
    const body: Record<string, unknown> = { error: err.message };
    if (err.code) body.code = err.code;
    if (err.details?.length) body.details = err.details;
    return { status: err.status, body };
  }
  if (isZodError(err)) {
    return { status: 400, body: { error: "Invalid request.", details: zodDetails(err.issues) } };
  }
  // Phase 11: a provider that is not connected in production (lib/env/secrets
  // FakeProviderRefusedError) is a setup state the user can fix, not a crash:
  // 409 with the "not_connected" code and the message naming what to connect.
  if (err instanceof Error && err.name === "FakeProviderRefusedError" && (err as { code?: unknown }).code === "not_connected") {
    return { status: 409, body: { error: err.message, code: "not_connected" } };
  }
  if (err instanceof SyntaxError && /JSON/i.test(err.message)) {
    return { status: 400, body: { error: "Invalid JSON body." } };
  }
  if (err instanceof TypeError) {
    // undici's Request.formData(): wrong or missing Content-Type, or a body
    // that doesn't parse as the declared form encoding.
    if (/^Content-Type was not one of/i.test(err.message)) {
      return {
        status: 415,
        body: { error: "Unsupported content type: send multipart/form-data." },
      };
    }
    if (/Failed to parse body as FormData/i.test(err.message)) {
      return { status: 400, body: { error: "Malformed form data." } };
    }
  }
  const code = prismaCode(err);
  if (code) {
    if (code === "P2025" || code === "P2001" || code === "P2018") {
      return { status: 404, body: { error: "Not found." } };
    }
    if (code === "P2002") return { status: 409, body: { error: "A record with these values already exists." } };
    if (code === "P2003" || code === "P2014") {
      return { status: 409, body: { error: "The request conflicts with related records." } };
    }
    if (["P2000", "P2005", "P2006", "P2007", "P2011", "P2012", "P2019", "P2020", "P2023"].includes(code)) {
      return { status: 400, body: { error: "Invalid value in request." } };
    }
  }
  if (err instanceof Error && err.constructor === Error && /\bnot found\b/i.test(err.message)) {
    return { status: 404, body: { error: "Not found." } };
  }
  return { status: 500, body: { error: INTERNAL_ERROR_MESSAGE } };
}

/**
 * Map a thrown value to a JSON Response. 5xx errors are logged as one
 * structured JSON line (lib/observability/log.ts: secrets and emails
 * scrubbed) with `context` (e.g. "POST /api/eddm/orders") and the request id
 * when `req` is given, and reported to Sentry when SENTRY_DSN is set. The
 * response body never carries the underlying message unless it came from an
 * HttpError; a 500 carries the request id so a user can quote it.
 */
export function errorResponse(err: unknown, context?: string, req?: Request | null): Response {
  const { status, body } = classifyError(err);
  if (status >= 500 && !(err instanceof HttpError && err.expose)) {
    const requestId = requestIdFrom(req);
    let method: string | undefined;
    let path: string | undefined;
    try {
      if (req) {
        method = req.method;
        path = new URL(req.url).pathname;
      }
    } catch {
      /* relative or missing URL: context still says where */
    }
    log.error("unhandled route error", { context, requestId, method, path, err });
    void captureException(err, { route: context, method, path, requestId, routeType: "route" });
    if (requestId) body.requestId = requestId;
  }
  return Response.json(body, { status });
}

/**
 * Wrap a route handler so anything it throws goes through errorResponse.
 *   export const POST = withErrorHandling(async (req: Request) => { ... }, "POST /api/x");
 * The first argument, when it is a Request, supplies the request id for the
 * error log line.
 */
export function withErrorHandling<A extends unknown[]>(
  handler: (...args: A) => Response | Promise<Response>,
  context?: string,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (err) {
      const first = args[0];
      return errorResponse(err, context, first instanceof Request ? first : null);
    }
  };
}
