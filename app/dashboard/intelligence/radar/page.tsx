// Marketr — Platform-change radar (Phase 10 M2, flagship).
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { RadarClient } from "./RadarClient";

export const metadata = { title: "Platform-change radar — Marketr" };

export default async function PlatformRadarPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return <RadarClient />;
}
