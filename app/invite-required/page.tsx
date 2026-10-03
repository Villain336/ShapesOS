// ShapesOS — shown when SIGNUP_MODE=invite turns away a brand-new user
// (lib/auth/signup.ts). Public page: no session needed, nothing leaked.

export const metadata = { title: "Invite required — ShapesOS" };

export default function InviteRequiredPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <div className="w-full max-w-sm rounded-lg bg-paper p-8 shadow-hairline">
        <h1 className="aos-heading">Invite required</h1>
        <p className="mt-2 text-sm text-ink">
          This ShapesOS workspace is invite-only, and your account isn&apos;t a member yet.
        </p>
        <p className="mt-2 text-sm text-muted">
          Ask a workspace admin to invite your email address, then open the invite link they send
          you. If you already have one, open it now to join.
        </p>
        <a
          href="/login"
          className="aos-press mt-6 inline-flex h-control w-full items-center justify-center rounded-full bg-paper text-base font-semibold text-ink shadow-outline"
        >
          Sign in with a different account
        </a>
      </div>
    </div>
  );
}
