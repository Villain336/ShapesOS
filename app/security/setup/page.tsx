// ShapesOS — two-factor setup required (Phase 4a). The dashboard shell sends
// sessions here when the current workspace requires 2FA and this session
// hasn't passed a second factor (lib/auth/mfa/policy.ts). Lives OUTSIDE
// /dashboard so the shell's redirect can't loop. Setting up a factor
// upgrades this session in place (single-use proof), then Continue goes on.

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { FeedbackHost } from "@/components/feedback/FeedbackHost";
import { SetupClient } from "./SetupClient";

export const dynamic = "force-dynamic";

export const metadata = { title: "Set up two-factor authentication — ShapesOS" };

export default async function TwoFactorSetupPage() {
  const user = await requireUser();
  if (!user) redirect("/login?next=/security/setup");
  return (
    <div className="min-h-screen bg-canvas px-4 py-10 md:px-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <div>
          <h1 className="aos-heading">Set up two-factor authentication</h1>
          <p className="mt-1 text-sm text-muted">
            Your workspace requires a second sign-in step. Add an authenticator app or a passkey to continue
            {user.email ? ` as ${user.email}` : ""}.
          </p>
        </div>
        <SetupClient />
      </div>
      <FeedbackHost />
    </div>
  );
}
