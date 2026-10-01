// Marketr — Listings: citation-brief builder (client).
// Competitor-gap → pre-filled NAP payloads → tracked manual-submission checklist.
// Honest long-tail play: done-for-you or DIY — never "automatic."

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
    <div className="rounded-lg border border-line bg-paper p-5">
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 text-muted" />
        <h2 className="text-sm font-semibold tracking-tight text-ink">Citation-brief builder</h2>
      </div>
      <p className="mt-1 text-[13px] text-muted">
        Competitor-gap analysis against the top-3 local directories, pre-filled NAP payloads, and a tracked
        manual-submission checklist. Done-for-you or DIY — never automatic.
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="brief-dirs" className="text-[13px] font-medium text-muted">Directories you&apos;re already on (comma-separated)</Label>
          <Input id="brief-dirs" value={clientDirs} onChange={(e) => setClientDirs(e.target.value)} placeholder="yelp, facebook, bbb" className="border-line bg-paper text-[13px] placeholder:text-subtle focus-visible:border-focus focus-visible:ring-[var(--aos-focus-halo)]" />
        </div>
        <div>
          <Label htmlFor="brief-name" className="text-[13px] font-medium text-muted">Business name (canonical NAP)</Label>
          <Input id="brief-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Plumbing Co." className="border-line bg-paper text-[13px] placeholder:text-subtle focus-visible:border-focus focus-visible:ring-[var(--aos-focus-halo)]" />
        </div>
        <div>
          <Label htmlFor="brief-address" className="text-[13px] font-medium text-muted">Address</Label>
          <Input id="brief-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St, Greensboro, NC 27401" className="border-line bg-paper text-[13px] placeholder:text-subtle focus-visible:border-focus focus-visible:ring-[var(--aos-focus-halo)]" />
        </div>
        <div>
          <Label htmlFor="brief-phone" className="text-[13px] font-medium text-muted">Phone</Label>
          <Input id="brief-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(336) 555-0100" className="border-line bg-paper text-[13px] placeholder:text-subtle focus-visible:border-focus focus-visible:ring-[var(--aos-focus-halo)]" />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="brief-website" className="text-[13px] font-medium text-muted">Website</Label>
          <Input id="brief-website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://acmeplumbing.example.com" className="border-line bg-paper text-[13px] placeholder:text-subtle focus-visible:border-focus focus-visible:ring-[var(--aos-focus-halo)]" />
        </div>
      </div>
      <div className="mt-4">
        <button onClick={build} disabled={busy} className="inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40">{busy ? "Building…" : "Build citation brief"}</button>
      </div>
      {error && <p className="mt-2 text-[13px] text-failed-text">{error}</p>}
      {result && <p className="mt-2 text-[13px] text-muted">{result}</p>}
    </div>
  );
}
