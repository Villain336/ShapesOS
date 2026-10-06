// Marketr — Connector Agent slice 6 UI: the OS user directory tab.
// Settings card: opt-in discoverability (reversible), profile fields,
// per-facet publish toggles (name+role vs fuller profile). Matches card:
// criteria search across MUTUALLY-discoverable users only — the private
// graph is never exposed, and non-discoverable users never match.
// Agentic OS design system: canvas page, white surfaces, black primary
// pills, Lucide only, tokens only.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Search, Send } from "lucide-react";
import type { DirectoryMatch, DirectoryProfileView } from "@/lib/connector/directory";
import {
  btnPrimary,
  btnSecondary,
  inputCls,
  SwitchRow,
  textareaCls,
} from "./IntroShared";

const LOOKING_FOR_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "", label: "No preference" },
  { id: "leads", label: "Leads" },
  { id: "funding", label: "Funding" },
  { id: "partners", label: "Partners" },
];

function MatchCard({
  match,
  onAskBoardy,
}: {
  match: DirectoryMatch;
  onAskBoardy: (seed: { targetName: string; targetRole?: string }) => void;
}) {
  const p = match.profile;
  return (
    <div className="flex flex-col gap-2.5 rounded-lg bg-paper p-5 shadow-hairline">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[1rem] font-semibold text-ink">{p.name ?? "Unnamed"}</p>
          {p.role && <p className="mt-0.5 text-[0.875rem] text-muted">{p.role}</p>}
          {p.company && (
            <p className="text-[0.8125rem] text-muted">{p.company}</p>
          )}
        </div>
        <span className="flex items-center gap-2" title={`Match score ${match.score}/100`}>
          <span className="h-2 w-20 overflow-hidden rounded-full bg-canvas">
            <span
              className="block h-full rounded-full bg-ink"
              style={{ width: `${match.score}%` }}
            />
          </span>
          <span className="text-[0.8125rem] font-semibold text-ink">{match.score}</span>
        </span>
      </div>
      {p.bio && <p className="text-[0.875rem] leading-relaxed text-ink">{p.bio}</p>}
      {p.industries.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {p.industries.map((i) => (
            <span
              key={i}
              className="inline-flex h-7 items-center rounded-full bg-canvas px-3 text-[0.75rem] font-semibold text-ink"
            >
              {i}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.75rem] text-muted">
        {match.reasons.map((r) => (
          <span key={r}>{r}</span>
        ))}
        {p.lookingFor && (
          <span>
            Looking for: <span className="font-semibold text-ink">{p.lookingFor}</span>
          </span>
        )}
        <span title="Which profile facets this user publishes">
          Shares:{" "}
          <span className="font-semibold text-ink">
            {p.facets.includes("full") ? "full profile" : "name + role"}
          </span>
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() =>
            onAskBoardy({
              targetName: p.name ?? "Directory match",
              targetRole: p.role ?? undefined,
            })
          }
          className={btnSecondary}
        >
          <Send size={14} /> Ask Boardy for an intro
        </button>
      </div>
    </div>
  );
}

export function DirectoryTab({
  onAskBoardy,
}: {
  onAskBoardy: (seed: { targetName: string; targetRole?: string }) => void;
}) {
  const [profile, setProfile] = useState<DirectoryProfileView | null>(null);
  const [loading, setLoading] = useState(true);
  // Settings form.
  const [discoverable, setDiscoverable] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [company, setCompany] = useState("");
  const [bio, setBio] = useState("");
  const [industries, setIndustries] = useState("");
  const [lookingFor, setLookingFor] = useState("");
  const [shareNameRole, setShareNameRole] = useState(true);
  const [shareFull, setShareFull] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Matches search.
  const [critRole, setCritRole] = useState("");
  const [critIndustries, setCritIndustries] = useState("");
  const [critLookingFor, setCritLookingFor] = useState("");
  const [matches, setMatches] = useState<DirectoryMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);

  const loadProfile = useCallback(async () => {
    try {
      const res = await fetch("/api/connector/directory");
      if (res.ok) {
        const json = await res.json();
        const p = json.profile as DirectoryProfileView | null;
        setProfile(p);
        if (p) {
          setDiscoverable(p.discoverable);
          setName(p.name ?? "");
          setRole(p.role ?? "");
          setCompany(p.company ?? "");
          setBio(p.bio ?? "");
          setIndustries(p.industries.join(", "));
          setLookingFor(p.lookingFor ?? "");
          setShareNameRole(p.shareNameRole);
          setShareFull(p.shareFull);
        }
      }
    } catch {
      // Profile stays null — the settings form still works (PUT upserts).
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/connector/directory", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          discoverable,
          name: name.trim() || null,
          role: role.trim() || null,
          company: company.trim() || null,
          bio: bio.trim() || null,
          industries: industries
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          lookingFor: lookingFor || null,
          shareNameRole,
          shareFull,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save directory settings.");
      setProfile(json.profile as DirectoryProfileView);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save directory settings.");
    } finally {
      setSaving(false);
    }
  }, [discoverable, name, role, company, bio, industries, lookingFor, shareNameRole, shareFull]);

  const search = useCallback(async () => {
    setSearching(true);
    setMatchError(null);
    try {
      const params = new URLSearchParams();
      if (critRole.trim()) params.set("roleKeywords", critRole.trim());
      if (critIndustries.trim()) params.set("industries", critIndustries.trim());
      if (critLookingFor) params.set("lookingFor", critLookingFor);
      const res = await fetch(`/api/connector/directory/matches?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Search failed.");
      setMatches(json.matches as DirectoryMatch[]);
    } catch (e) {
      setMatches(null);
      setMatchError(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setSearching(false);
    }
  }, [critRole, critIndustries, critLookingFor]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" /> Loading directory settings
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Settings: opt-in, facets, reversible. */}
      <div className="flex flex-col gap-4 rounded-lg bg-paper p-5 shadow-hairline">
        <div>
          <h2 className="aos-subheading">Directory settings</h2>
          <p className="mt-1 text-[0.8125rem] text-muted">
            Opt in to be discoverable by other OS users. Only mutually-discoverable
            users can match — your private network is never exposed. Unpublish any
            time; your profile disappears from the directory instantly.
          </p>
        </div>

        <SwitchRow
          on={discoverable}
          onChange={setDiscoverable}
          label="Publish me to the OS directory"
          hint="Opt-in only. Off by default — nothing is shared until you flip this on."
        />

        <div className="grid gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.75rem] font-semibold text-muted">Name (required to publish)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tico Hamphill" className={inputCls} />
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-[0.75rem] font-semibold text-muted">Role</span>
              <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Founder" className={inputCls} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[0.75rem] font-semibold text-muted">Company</span>
              <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Launchabl" className={inputCls} />
            </label>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.75rem] font-semibold text-muted">Bio</span>
            <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} placeholder="What you do, in a line or two." className={textareaCls} />
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-[0.75rem] font-semibold text-muted">Industries (comma-separated)</span>
              <input value={industries} onChange={(e) => setIndustries(e.target.value)} placeholder="SaaS, Marketing" className={inputCls} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[0.75rem] font-semibold text-muted">Looking for</span>
              <select
                value={lookingFor}
                onChange={(e) => setLookingFor(e.target.value)}
                className={inputCls}
              >
                {LOOKING_FOR_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-md border border-line bg-canvas p-4">
          <p className="text-[0.75rem] font-semibold text-muted">Profile facets — what matches can see</p>
          <SwitchRow
            on={shareNameRole}
            onChange={setShareNameRole}
            label="Name + role"
            hint="The minimum identity facet. Required for matching."
          />
          <SwitchRow
            on={shareFull}
            onChange={setShareFull}
            label="Fuller profile"
            hint="Company, bio, industries, and what you're looking for."
          />
        </div>

        {saveError && <p className="text-[0.8125rem] font-semibold text-failed-text">{saveError}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={saving} onClick={save} className={btnPrimary}>
            {saving && <Loader2 size={15} className="animate-spin" />}
            {saving ? "Saving" : "Save directory settings"}
          </button>
          {profile && (
            <span className="text-[0.8125rem] text-muted">
              {profile.discoverable ? "Published — discoverable by other users." : "Not published — invisible to the directory."}
            </span>
          )}
        </div>
      </div>

      {/* Matches: mutual discoverability only. */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 rounded-lg bg-paper p-5 shadow-hairline">
          <div>
            <h2 className="aos-subheading">Find people</h2>
            <p className="mt-1 text-[0.8125rem] text-muted">
              Matching works only between mutually-discoverable users. Publish your
              own profile first, then search.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[0.75rem] font-semibold text-muted">Role keywords</span>
              <input value={critRole} onChange={(e) => setCritRole(e.target.value)} placeholder="CFO, VP Sales" className={inputCls} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[0.75rem] font-semibold text-muted">Industries</span>
              <input value={critIndustries} onChange={(e) => setCritIndustries(e.target.value)} placeholder="SaaS, HVAC" className={inputCls} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[0.75rem] font-semibold text-muted">Looking for</span>
              <select value={critLookingFor} onChange={(e) => setCritLookingFor(e.target.value)} className={inputCls}>
                {LOOKING_FOR_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div>
            <button type="button" disabled={searching} onClick={search} className={btnSecondary}>
              {searching ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
              {searching ? "Searching" : "Search the directory"}
            </button>
          </div>
          {matchError && (
            <div className="rounded-md border border-line bg-canvas p-3">
              <p className="text-[0.8125rem] font-semibold text-failed-text">{matchError}</p>
              {matchError.toLowerCase().includes("discoverability") && (
                <p className="mt-1 text-[0.8125rem] text-muted">
                  Flip “Publish me to the OS directory” on and save, then search again.
                </p>
              )}
            </div>
          )}
        </div>

        {matches !== null && (
          <div className="flex flex-col gap-3">
            {matches.length === 0 ? (
              <div className="rounded-lg bg-paper p-6 text-[0.875rem] text-muted shadow-hairline">
                No mutually-discoverable matches. Try broader criteria — or publish
                more of your profile so others can find you.
              </div>
            ) : (
              matches.map((m) => (
                <MatchCard key={m.profile.id} match={m} onAskBoardy={onAskBoardy} />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
