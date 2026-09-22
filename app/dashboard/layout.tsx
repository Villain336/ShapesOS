// Marketr — authenticated dashboard shell. Every route under /dashboard
// requires a session; unauthenticated visitors bounce to /login.

import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import SignOutButton from "@/components/SignOutButton";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");

  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900">
      <header className="border-b border-zinc-200">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/dashboard" className="text-lg font-bold tracking-tight">
            Marketr
          </Link>
          <div className="flex items-center gap-4">
            <Link
              href="/dashboard/reports"
              className="text-sm text-zinc-500 hover:text-zinc-800"
            >
              Reports
            </Link>
            <Link
              href="/dashboard/alerts"
              className="text-sm text-zinc-500 hover:text-zinc-800"
            >
              Alerts
            </Link>
            <Link
              href="/dashboard/settings/alerts"
              className="text-sm text-zinc-500 hover:text-zinc-800"
            >
              Alert rules
            </Link>
            <Link
              href="/dashboard/settings/brand-kits"
              className="text-sm text-zinc-500 hover:text-zinc-800"
            >
              Brand kits
            </Link>
            <Link
              href="/dashboard/settings/members"
              className="text-sm text-zinc-500 hover:text-zinc-800"
            >
              Members
            </Link>
            <span className="text-sm text-zinc-500">
              {user.email ?? user.name ?? "Signed in"}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
