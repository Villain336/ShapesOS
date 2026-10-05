// ShapesOS — Settings → Your security (Phase 4a). Every signed-in member
// manages their own second factor here: authenticator app (TOTP) with
// recovery codes, and passkeys. All writes go through the self-service
// /api/account/security routes, which only ever touch the caller's account.

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import SettingsNav from "@/components/settings/SettingsNav";
import { AccountSecurityPanel } from "@/components/security/AccountSecurityPanel";

export const dynamic = "force-dynamic";

export const metadata = { title: "Your security — ShapesOS" };

export default async function AccountSecurityPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-3xl flex-col gap-6">
        <div>
          <h1 className="aos-heading">Your security</h1>
          <p className="mt-0.5 text-sm text-muted">
            Two-factor sign-in and passkeys for {user.email ?? "your account"}. These apply in every workspace you belong to.
          </p>
        </div>
        <SettingsNav />
        <AccountSecurityPanel />
      </div>
    </div>
  );
}
