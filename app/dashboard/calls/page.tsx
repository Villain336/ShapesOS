// Marketr — Calls & booking dashboard (R5).
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { CallsApp } from "@/components/calls/CallsApp";

export const metadata = { title: "Calls & Booking — ShapesOS" };

export default async function CallsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return <CallsApp />;
}
