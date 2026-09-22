"use client";

import { signOut } from "next-auth/react";

export default function SignOutButton() {
  return (
    <button
      onClick={() => signOut({ callbackUrl: "/login" })}
      className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100"
    >
      Sign out
    </button>
  );
}
