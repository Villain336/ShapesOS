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
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-semibold">Citation-brief builder</h2>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Competitor-gap analysis against the top-3 local directories, pre-filled NAP payloads, and a tracked
        manual-submission checklist. Done-for-you or DIY — never automatic.
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="brief-dirs">Directories you&apos;re already on (comma-separated)</Label>
          <Input id="brief-dirs" value={clientDirs} onChange={(e) => setClientDirs(e.target.value)} placeholder="yelp, facebook, bbb" />
        </div>
        <div>
          <Label htmlFor="brief-name">Business name (canonical NAP)</Label>
          <Input id="brief-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Plumbing Co." />
        </div>
        <div>
          <Label htmlFor="brief-address">Address</Label>
          <Input id="brief-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St, Greensboro, NC 27401" />
        </div>
        <div>
          <Label htmlFor="brief-phone">Phone</Label>
          <Input id="brief-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(336) 555-0100" />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="brief-website">Website</Label>
          <Input id="brief-website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://acmeplumbing.example.com" />
        </div>
      </div>
      <div className="mt-4">
        <Button onClick={build} disabled={busy}>{busy ? "Building…" : "Build citation brief"}</Button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {result && <p className="mt-2 text-sm text-emerald-700">{result}</p>}
    </div>
  );
}
