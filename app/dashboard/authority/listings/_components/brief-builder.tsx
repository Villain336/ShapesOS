// Marketr — Listings: citation-brief builder (client).
// Competitor-gap → pre-filled NAP payloads → tracked manual-submission checklist.
// Honest long-tail play: done-for-you or DIY — never "automatic."

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/vault/shadcn/button";
import { Input } from "@/components/vault/shadcn/input";
import { Label } from "@/components/vault/shadcn/label";
import { FileText } from "lucide-react";

export default function BriefBuilder() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [clientDirs, setClientDirs] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [website, setWebsite] = useState("");

  async function build() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/authority/listings/briefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDirectories: clientDirs.split(",").map((d) => d.trim()).filter(Boolean),
          canonicalNap: { name, address, phone, website },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Brief build failed");
      const high = (data.gaps as { priority: string }[]).filter((g) => g.priority === "high").length;
      setResult(
        `Brief created: ${data.directories.length} directories in the checklist, ${high} high-priority gaps vs. competitors.`,
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-5">
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 text-stone-500" />
        <h2 className="text-sm font-semibold tracking-tight text-stone-900">Citation-brief builder</h2>
      </div>
      <p className="mt-1 text-[13px] text-stone-500">
        Competitor-gap analysis against the top-3 local directories, pre-filled NAP payloads, and a tracked
        manual-submission checklist. Done-for-you or DIY — never automatic.
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="brief-dirs" className="text-[13px] font-medium text-stone-700">Directories you&apos;re already on (comma-separated)</Label>
          <Input id="brief-dirs" value={clientDirs} onChange={(e) => setClientDirs(e.target.value)} placeholder="yelp, facebook, bbb" className="border-stone-200 bg-white text-[13px] placeholder:text-stone-400 focus-visible:border-violet-400 focus-visible:ring-violet-200/60" />
        </div>
        <div>
          <Label htmlFor="brief-name" className="text-[13px] font-medium text-stone-700">Business name (canonical NAP)</Label>
          <Input id="brief-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Plumbing Co." className="border-stone-200 bg-white text-[13px] placeholder:text-stone-400 focus-visible:border-violet-400 focus-visible:ring-violet-200/60" />
        </div>
        <div>
          <Label htmlFor="brief-address" className="text-[13px] font-medium text-stone-700">Address</Label>
          <Input id="brief-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St, Greensboro, NC 27401" className="border-stone-200 bg-white text-[13px] placeholder:text-stone-400 focus-visible:border-violet-400 focus-visible:ring-violet-200/60" />
        </div>
        <div>
          <Label htmlFor="brief-phone" className="text-[13px] font-medium text-stone-700">Phone</Label>
          <Input id="brief-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(336) 555-0100" className="border-stone-200 bg-white text-[13px] placeholder:text-stone-400 focus-visible:border-violet-400 focus-visible:ring-violet-200/60" />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="brief-website" className="text-[13px] font-medium text-stone-700">Website</Label>
          <Input id="brief-website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://acmeplumbing.example.com" className="border-stone-200 bg-white text-[13px] placeholder:text-stone-400 focus-visible:border-violet-400 focus-visible:ring-violet-200/60" />
        </div>
      </div>
      <div className="mt-4">
        <Button onClick={build} disabled={busy} className="bg-violet-600 text-white hover:bg-violet-700">{busy ? "Building…" : "Build citation brief"}</Button>
      </div>
      {error && <p className="mt-2 text-[13px] text-red-600">{error}</p>}
      {result && <p className="mt-2 text-[13px] text-emerald-700">{result}</p>}
    </div>
  );
}
