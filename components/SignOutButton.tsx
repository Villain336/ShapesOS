"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/vault/atoms/Button";

export default function SignOutButton() {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => signOut({ callbackUrl: "/login" })}
    >
      Sign out
    </Button>
  );
}
