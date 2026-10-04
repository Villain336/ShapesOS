// ShapesOS — email + password accounts and magic links (Phase 6).
//
// Sign-in stays Auth.js stateless JWT (no adapter). This module owns the two
// tables behind it (email_accounts, email_auth_tokens) and the flows the
// public routes and the two Credentials providers call:
//
//   signUpWithEmail       POST /api/auth/email/signup
//   requestMagicLink      POST /api/auth/email/magic-link
//   requestPasswordReset  POST /api/auth/email/password/forgot
//   resetPassword         POST /api/auth/email/password/reset
//   consumeSignInLink     "email-link" provider (verify + login links)
//   checkEmailPassword    "email-password" provider
//
// Rules:
//   - No enumeration: signup, magic link and forgot-password answer the same
//     way whether or not the address has an account. Input-shape errors
//     (bad email, weak password), SIGNUP_MODE=invite refusals, CAPTCHA and
//     lockouts don't depend on whether an account exists.
//   - Accounts start UNVERIFIED; a password works only once the address is
//     verified. A verify link activates exactly the password chosen in the
//     signup that sent it (token.password_hash), so a second signup for the
//     same unverified address can't plant its own password. A login link
//     that verifies an account clears any never-proven password.
//   - Every link is single use: one guarded UPDATE (used_at IS NULL AND
//     expires_at > now) — of two concurrent uses exactly one wins.
//   - A password reset invalidates every outstanding link for the address.
//   - At most EMAIL_SEND_LIMIT links per address per 15 minutes (DB-counted,
//     so it holds across replicas); extra requests answer the same way and
//     send nothing.

import type { EmailAccount, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { BadRequestError, HttpError } from "@/lib/api/errors";
import { loginLockedOut, recordLoginSuccess } from "@/lib/auth/rate-limit";
import { captchaConfig, captchaRequired, verifyCaptchaToken } from "@/lib/auth/captcha";
import { InviteRequiredError, signInAllowed, signupMode } from "@/lib/auth/signup";
import {
  EMAIL_SEND_LIMIT,
  EMAIL_SEND_WINDOW_MS,
  cleanName,
  emailUserId,
  generateEmailToken,
  hashEmailToken,
  looksLikeEmailToken,
  normalizeEmail,
  tokenExpiry,
  type EmailTokenPurpose,
} from "./tokens";
import { dummyPasswordHash, hashPassword, needsRehash, passwordPolicyError, verifyPassword } from "./password";
import {
  EmailAuthUnavailableError,
  emailAuthBaseUrl,
  emailAuthEnabled,
  sendAuthEmail,
  tokenLink,
  type AuthMailDeps,
  type AuthMailKind,
} from "./mail";

type Db = Prisma.TransactionClient | typeof prisma;

export interface FlowDeps extends AuthMailDeps {
  now?: Date;
  /** Request origin, used for links only outside production (lib/auth/email/mail.ts). */
  requestOrigin?: string | null;
}

export class CaptchaRequiredHttpError extends HttpError {
  constructor() {
    super(400, "Complete the security check, then try again.", { code: "captcha_required" });
    this.name = "CaptchaRequiredHttpError";
  }
}

export class EmailAuthLockedError extends HttpError {
  constructor() {
    super(429, "Too many attempts for this address. Wait a while, then try again.", { code: "locked" });
    this.name = "EmailAuthLockedError";
  }
}

const SIGN_UP_SENT = "If that address can be used, we've sent it a link. Check your email to finish signing up.";

// ── Small helpers ───────────────────────────────────────────────────────────

async function audit(
  action: "auth_account_created" | "auth_email_verified" | "auth_password_reset" | "auth_login_failed" | "auth_login_succeeded",
  summary: string,
  userId: string | null,
): Promise<void> {
  await prisma.fileChangeLog
    .create({
      data: {
        projectId: null,
        workspaceId: null,
        filePath: "(auth)",
        actor: "system",
        action,
        summary: summary.slice(0, 500),
        approvedBy: userId,
      },
    })
    // Fail open, like the other auth audit writes: a database blip must not
    // turn into a sign-in outage. The console line keeps a local trace.
    .catch((err: unknown) => console.error("[auth] audit write failed:", (err as { code?: string })?.code ?? err));
}

function requireEnabled(deps: FlowDeps): void {
  if (!emailAuthEnabled(deps.env)) throw new EmailAuthUnavailableError();
}

function requireEmail(raw: unknown): string {
  const email = normalizeEmail(raw);
  if (!email) throw new BadRequestError("Enter a valid email address.", { code: "invalid_email" });
  return email;
}

/** CAPTCHA: `always` for signup (when a provider is configured), else the login step-up. */
async function checkCaptcha(ip: string | null, email: string, token: unknown, always: boolean, env?: NodeJS.ProcessEnv) {
  const due = always ? captchaConfig(env) !== null : captchaRequired(ip, email, { env });
  if (!due) return;
  if (!(await verifyCaptchaToken(typeof token === "string" ? token : "", ip, { env }))) throw new CaptchaRequiredHttpError();
}

/** Links sent to this address inside the window (all purposes). */
export async function recentLinkCount(email: string, now: Date = new Date(), db: Db = prisma): Promise<number> {
  return db.emailAuthToken.count({ where: { email, createdAt: { gt: new Date(now.getTime() - EMAIL_SEND_WINDOW_MS) } } });
}

/** Store a new single-use link (hash only) and return the raw token. */
export async function issueEmailToken(
  opts: { email: string; purpose: EmailTokenPurpose; passwordHash?: string | null; now?: Date },
  db: Db = prisma,
): Promise<string> {
  const now = opts.now ?? new Date();
  const token = generateEmailToken();
  await db.emailAuthToken.create({
    data: {
      tokenHash: hashEmailToken(token),
      email: opts.email,
      purpose: opts.purpose,
      passwordHash: opts.purpose === "verify" ? (opts.passwordHash ?? null) : null,
      expiresAt: tokenExpiry(opts.purpose, now),
      createdAt: now,
    },
  });
  // Housekeeping: this address's links that expired over a day ago.
  await db.emailAuthToken.deleteMany({ where: { email: opts.email, expiresAt: { lt: new Date(now.getTime() - 86_400_000) } } });
  return token;
}

/** Issue + email one link, unless the address hit its send limit (then silently nothing). */
async function sendLink(
  email: string,
  purpose: EmailTokenPurpose,
  kind: AuthMailKind,
  deps: FlowDeps,
  passwordHash?: string | null,
): Promise<boolean> {
  const now = deps.now ?? new Date();
  if ((await recentLinkCount(email, now)) >= EMAIL_SEND_LIMIT) return false;
  const base = emailAuthBaseUrl(deps.env, deps.requestOrigin);
  if (!base) return false;
  const token = await issueEmailToken({ email, purpose, passwordHash, now });
  const res = await sendAuthEmail({ kind, to: email, url: tokenLink(base, purpose, token) }, deps);
  return res.sent;
}

/** A plain "you already have an account" note (no token), counted against the send limit. */
async function sendAlreadyRegistered(email: string, deps: FlowDeps): Promise<void> {
  const now = deps.now ?? new Date();
  if ((await recentLinkCount(email, now)) >= EMAIL_SEND_LIMIT) return;
  const base = emailAuthBaseUrl(deps.env, deps.requestOrigin);
  if (!base) return;
  // Count it like a link (an expired, never-usable row) so repeated signups
  // for a registered address can't flood its inbox either.
  await prisma.emailAuthToken.create({
    data: { tokenHash: hashEmailToken(generateEmailToken()), email, purpose: "login", expiresAt: now, usedAt: now, createdAt: now },
  });
  await sendAuthEmail({ kind: "already_registered", to: email, url: `${base}/login` }, deps);
}

/** Single-use consumption: exactly one concurrent caller gets the row back. */
async function consumeToken(db: Db, token: string, purposes: EmailTokenPurpose[], now: Date) {
  const tokenHash = hashEmailToken(token);
  const res = await db.emailAuthToken.updateMany({
    where: { tokenHash, usedAt: null, expiresAt: { gt: now }, purpose: { in: purposes } },
    data: { usedAt: now },
  });
  if (res.count !== 1) return null;
  return db.emailAuthToken.findUnique({
    where: { tokenHash },
    select: { email: true, purpose: true, passwordHash: true },
  });
}

/** Insert the account unless one exists (ON CONFLICT DO NOTHING), then read it. */
async function ensureAccount(
  db: Db,
  data: { email: string; name: string | null; passwordHash: string | null; emailVerifiedAt: Date | null },
): Promise<{ account: EmailAccount; created: boolean }> {
  const res = await db.emailAccount.createMany({
    data: [{ userId: emailUserId(data.email), ...data }],
    skipDuplicates: true,
  });
  const account = await db.emailAccount.findUniqueOrThrow({ where: { email: data.email } });
  return { account, created: res.count === 1 };
}

/** New accounts are allowed: open signup, or (invite mode) a membership / pending invite. */
async function mayCreateAccount(email: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  if (signupMode(env) === "open") return true;
  return signInAllowed(emailUserId(email), email, env);
}

// ── Signup ──────────────────────────────────────────────────────────────────

export interface SignUpInput {
  email: unknown;
  password: unknown;
  name: unknown;
  ip: string | null;
  captchaToken?: unknown;
}

export async function signUpWithEmail(input: SignUpInput, deps: FlowDeps = {}): Promise<{ ok: true; message: string }> {
  requireEnabled(deps);
  const email = requireEmail(input.email);
  const name = cleanName(input.name);
  if (!name) throw new BadRequestError("Enter your name.", { code: "invalid_name" });
  const policy = passwordPolicyError(input.password, { email, name });
  if (policy) throw new BadRequestError(policy, { code: "weak_password" });
  if (loginLockedOut(input.ip, email)) throw new EmailAuthLockedError();
  await checkCaptcha(input.ip, email, input.captchaToken, true, deps.env);
  // SIGNUP_MODE=invite: the same check the Auth.js signIn callback runs
  // (membership or a pending, unexpired invite for this address). It never
  // depends on whether an email account exists.
  if (signupMode(deps.env) === "invite" && !(await signInAllowed(emailUserId(email), email, deps.env))) {
    throw new InviteRequiredError();
  }

  // Hash first, on every path, so timing doesn't say which branch ran.
  const passwordHash = await hashPassword(input.password as string);
  const existing = await prisma.emailAccount.findUnique({ where: { email }, select: { emailVerifiedAt: true } });
  if (existing?.emailVerifiedAt) {
    await sendAlreadyRegistered(email, deps);
    return { ok: true, message: SIGN_UP_SENT };
  }
  if (!existing) {
    const { created } = await ensureAccount(prisma, { email, name, passwordHash, emailVerifiedAt: null });
    if (created) await audit("auth_account_created", `email account created for ${email} (unverified)`, emailUserId(email));
  }
  // New or still-unverified account: a verify link that carries THIS signup's password.
  await sendLink(email, "verify", "verify", deps, passwordHash);
  return { ok: true, message: SIGN_UP_SENT };
}

// ── Magic link ──────────────────────────────────────────────────────────────

export const MAGIC_LINK_SENT = "If that address can sign in here, we've sent it a link. It works once and expires in 15 minutes.";

export async function requestMagicLink(
  input: { email: unknown; ip: string | null; captchaToken?: unknown },
  deps: FlowDeps = {},
): Promise<{ ok: true; message: string }> {
  requireEnabled(deps);
  const email = requireEmail(input.email);
  if (loginLockedOut(input.ip, email)) throw new EmailAuthLockedError();
  await checkCaptcha(input.ip, email, input.captchaToken, false, deps.env);
  const account = await prisma.emailAccount.findUnique({ where: { email }, select: { id: true } });
  if (account) {
    await sendLink(email, "login", "login", deps);
  } else if (await mayCreateAccount(email, deps.env)) {
    // No row yet: the account is created (already verified) when the link is
    // used, so typing someone's address here never creates anything.
    await sendLink(email, "login", "login_new", deps);
  }
  return { ok: true, message: MAGIC_LINK_SENT };
}

// ── Password reset ──────────────────────────────────────────────────────────

export const RESET_SENT = "If that address has an account, we've sent it a link to choose a new password.";

export async function requestPasswordReset(
  input: { email: unknown; ip: string | null; captchaToken?: unknown },
  deps: FlowDeps = {},
): Promise<{ ok: true; message: string }> {
  requireEnabled(deps);
  const email = requireEmail(input.email);
  if (loginLockedOut(input.ip, email)) throw new EmailAuthLockedError();
  await checkCaptcha(input.ip, email, input.captchaToken, false, deps.env);
  const account = await prisma.emailAccount.findUnique({ where: { email }, select: { id: true } });
  if (account) await sendLink(email, "reset", "reset", deps);
  return { ok: true, message: RESET_SENT };
}

export async function resetPassword(
  input: { token: unknown; password: unknown; ip: string | null },
  deps: FlowDeps = {},
): Promise<{ ok: true; email: string }> {
  const invalid = () =>
    new BadRequestError("This reset link is invalid or has expired. Ask for a new one.", { code: "invalid_token" });
  if (!looksLikeEmailToken(input.token)) throw invalid();
  // Peek (no consumption) so a weak password doesn't burn the link.
  const peek = await prisma.emailAuthToken.findUnique({
    where: { tokenHash: hashEmailToken(input.token) },
    select: { email: true, purpose: true, usedAt: true, expiresAt: true },
  });
  const now = deps.now ?? new Date();
  if (!peek || peek.purpose !== "reset" || peek.usedAt || peek.expiresAt <= now) throw invalid();
  const policy = passwordPolicyError(input.password, { email: peek.email });
  if (policy) throw new BadRequestError(policy, { code: "weak_password" });
  const passwordHash = await hashPassword(input.password as string);

  const email = await prisma.$transaction(async (tx) => {
    const row = await consumeToken(tx, input.token as string, ["reset"], now);
    if (!row) return null;
    const account = await tx.emailAccount.findUnique({ where: { email: row.email } });
    if (!account) return null;
    await tx.emailAccount.update({
      where: { id: account.id },
      // The link proved the mailbox: a reset also verifies the address.
      data: { passwordHash, emailVerifiedAt: account.emailVerifiedAt ?? now },
    });
    // Every other outstanding link for this address stops working.
    await tx.emailAuthToken.updateMany({ where: { email: row.email, usedAt: null }, data: { usedAt: now } });
    return row.email;
  });
  if (!email) throw invalid();
  recordLoginSuccess(input.ip, email);
  await audit("auth_password_reset", `password reset for ${email} from ${input.ip ?? "unknown ip"}`, emailUserId(email));
  return { ok: true, email };
}

// ── Sign-in (called by the Auth.js providers in auth.ts) ────────────────────

export interface SignedInAccount {
  userId: string;
  email: string;
  name: string | null;
}

function signedIn(a: Pick<EmailAccount, "userId" | "email" | "name">): SignedInAccount {
  return { userId: a.userId, email: a.email, name: a.name };
}

export type PasswordCheck =
  | { status: "ok"; account: SignedInAccount }
  | { status: "invalid" }
  | { status: "unverified" };

/**
 * Check an email + password. Runs one scrypt verification on every path (a
 * dummy hash when there's no account or no password) so timing doesn't reveal
 * which accounts exist. "unverified" is only reported for the right password.
 */
export async function checkEmailPassword(rawEmail: unknown, password: unknown, now: Date = new Date()): Promise<PasswordCheck> {
  const email = normalizeEmail(rawEmail);
  const pw = typeof password === "string" ? password : "";
  const account = email ? await prisma.emailAccount.findUnique({ where: { email } }) : null;
  const stored = account?.passwordHash ?? (await dummyPasswordHash());
  const match = await verifyPassword(pw, stored);
  if (!account || !account.passwordHash || !match) return { status: "invalid" };
  if (!account.emailVerifiedAt) return { status: "unverified" };
  const data: Prisma.EmailAccountUpdateInput = { lastLoginAt: now };
  if (needsRehash(account.passwordHash)) data.passwordHash = await hashPassword(pw);
  await prisma.emailAccount.update({ where: { id: account.id }, data }).catch(() => {});
  return { status: "ok", account: signedIn(account) };
}

export type LinkSignIn =
  | { status: "ok"; account: SignedInAccount; verified: boolean }
  | { status: "invalid" }
  | { status: "refused" };

/**
 * Use a verify or login link. The token is consumed even when sign-in is then
 * refused (invite-only and no invite), so a link never works twice.
 */
export async function consumeSignInLink(token: unknown, opts: { env?: NodeJS.ProcessEnv; now?: Date } = {}): Promise<LinkSignIn> {
  if (!looksLikeEmailToken(token)) return { status: "invalid" };
  const now = opts.now ?? new Date();
  const result = await prisma.$transaction(async (tx): Promise<LinkSignIn> => {
    const row = await consumeToken(tx, token, ["verify", "login"], now);
    if (!row) return { status: "invalid" };
    let account = await tx.emailAccount.findUnique({ where: { email: row.email } });
    if (!account) {
      // Only a login link may create an account (open signup, or an invite).
      if (row.purpose !== "login" || !(await mayCreateAccount(row.email, opts.env))) return { status: "refused" };
      const ensured = await ensureAccount(tx, { email: row.email, name: null, passwordHash: null, emailVerifiedAt: now });
      // Lost a race with a signup for the same address: verify that row below.
      if (ensured.created) return { status: "ok", account: signedIn(ensured.account), verified: true };
      account = ensured.account;
    }
    if (account.emailVerifiedAt) return { status: "ok", account: signedIn(account), verified: false };
    // First proof of the mailbox: verify. A verify link activates the
    // password from its own signup; a login link clears any password that
    // was never proven by the mailbox owner.
    const updated = await tx.emailAccount.update({
      where: { id: account.id },
      data: { emailVerifiedAt: now, passwordHash: row.purpose === "verify" ? row.passwordHash : null },
    });
    // Other pending verify links carry other signups' passwords: void them.
    await tx.emailAuthToken.updateMany({ where: { email: row.email, purpose: "verify", usedAt: null }, data: { usedAt: now } });
    return { status: "ok", account: signedIn(updated), verified: true };
  });
  if (result.status === "ok" && result.verified) {
    await audit("auth_email_verified", `email verified for ${result.account.email}`, result.account.userId);
  }
  return result;
}
