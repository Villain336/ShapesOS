"use client";

import { signOut } from "next-auth/react";
import { forgetOfflineData } from "@/lib/offline/client";
import { Button } from "@/components/vault/atoms/Button";

export default function SignOutButton() {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => void forgetOfflineData().finally(() => signOut({ callbackUrl: "/login" }))}
    >
      Sign out
    </Button>
  );
}
