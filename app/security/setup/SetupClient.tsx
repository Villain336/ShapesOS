"use client";

import { signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { AccountSecurityPanel } from "@/components/security/AccountSecurityPanel";
import { btnQuiet } from "@/components/security/ui";

export function SetupClient() {
  const router = useRouter();
  return (
    <>
      <AccountSecurityPanel
        onSecured={() => {
          // The session cookie was just upgraded; re-render the shell with it.
          router.push("/dashboard");
          router.refresh();
        }}
      />
      <div>
        <button type="button" className={btnQuiet} onClick={() => signOut({ callbackUrl: "/login" })}>
          Sign out
        </button>
      </div>
    </>
  );
}
