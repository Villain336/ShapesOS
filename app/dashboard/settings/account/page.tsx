// ShapesOS — Settings → Your account (Phase 4a, GDPR): who you're signed in
// as, download your data, delete your account. Rules live in
// lib/gdpr/account-delete.ts; the API re-checks everything.

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import SettingsNav from "@/components/settings/SettingsNav";
import AccountSettings from "@/components/account/AccountSettings";
import { accountConfirmationText, blockerMessage, previewAccountDeletion } from "@/lib/gdpr/account-delete";

export const dynamic = "force-dynamic";

export const metadata = { title: "Your account — ShapesOS" };

export default async function AccountSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const plan = await previewAccountDeletion(user.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">Your account</h1>
        <p className="mt-0.5 text-sm text-muted">Your sign-in, a copy of your data, and deleting your account.</p>
      </div>
      <SettingsNav />
      <AccountSettings
        account={{ id: user.id, email: user.email ?? null, name: user.name ?? null }}
        confirmText={accountConfirmationText(user.email)}
        deleteWorkspaces={plan.deleteWorkspaces}
        leaveWorkspaces={plan.leaveWorkspaces.map((w) => ({ id: w.id, name: w.name }))}
        blockedMessage={blockerMessage(plan)}
      />
    </div>
  );
}
