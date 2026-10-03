// ShapesOS — first-run setup for a brand-new workspace (Phase 3, I).
// Four steps: name the workspace, describe the business, connect the first
// tools, run the intelligence report. Every step saves as you go (resumable);
// "Skip setup" ends it for good. Server side: /api/workspace/onboarding.

"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, ExternalLink, FileSearch } from "lucide-react";
import { FormError } from "./FormError";
import {
  btnPrimary,
  btnQuiet,
  btnSecondary,
  cardCls,
  chipCls,
  helperCls,
  inputCls,
  labelCls,
  textareaCls,
} from "./aos";

type Step = "name" | "business" | "connect" | "report";
const STEPS: { id: Step; label: string }[] = [
  { id: "name", label: "Name" },
  { id: "business", label: "Your business" },
  { id: "connect", label: "Connect" },
  { id: "report", label: "First report" },
];

interface Profile {
  businessType: string | null;
  website: string | null;
  goals: string[];
  notes: string | null;
}
interface Suggestion {
  key: string;
  label: string;
  why: string;
  href: string;
}

export interface OnboardingWizardProps {
  initial: { step: Step; workspaceName: string; profile: Profile; hasProject: boolean };
  suggestions: Suggestion[];
  businessTypes: readonly { id: string; label: string }[];
  goals: readonly { id: string; label: string }[];
}

export default function OnboardingWizard(props: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>(props.initial.step);
  const [name, setName] = useState(props.initial.workspaceName);
  const [businessType, setBusinessType] = useState<string | null>(props.initial.profile.businessType);
  const [website, setWebsite] = useState(props.initial.profile.website ?? "");
  const [goals, setGoals] = useState<string[]>(props.initial.profile.goals);
  const [notes, setNotes] = useState(props.initial.profile.notes ?? "");
  const [suggestions, setSuggestions] = useState<Suggestion[]>(props.suggestions);
  const [hasProject, setHasProject] = useState(props.initial.hasProject);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const index = STEPS.findIndex((s) => s.id === step);

  async function patch(body: Record<string, unknown>, label: string): Promise<boolean> {
    setBusy(label);
    setError(null);
    try {
      const r = await fetch("/api/workspace/onboarding", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error ?? "Couldn't save that. Try again.");
        return false;
      }
      if (Array.isArray(j.suggestions)) setSuggestions(j.suggestions);
      if (j.state) setHasProject(!!j.state.hasProject);
      return true;
    } catch {
      setError("Couldn't reach ShapesOS. Check your connection and try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function go(next: Step, extra: Record<string, unknown> = {}) {
    if (await patch({ ...extra, step: next }, "next")) setStep(next);
  }

  async function finish(href: string, action: "complete" | "skip") {
    if (await patch({ action }, action)) window.location.href = href;
  }

  const toggleGoal = (id: string) =>
    setGoals((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="aos-display">Set up your workspace</h1>
          <p className="mt-1 text-base text-muted">
            A few answers so agents start with the right context. Takes about two minutes, and you can change all of it later.
          </p>
        </div>
        <button type="button" className={btnQuiet} disabled={busy !== null} onClick={() => void finish("/dashboard", "skip")}>
          {busy === "skip" ? "Skipping" : "Skip setup"}
        </button>
      </div>

      <ol className="flex flex-wrap gap-2" aria-label="Setup steps">
        {STEPS.map((s, i) => (
          <li key={s.id}>
            <span
              aria-current={s.id === step ? "step" : undefined}
              className={`inline-flex h-chip items-center gap-1.5 rounded-full px-3 text-sm font-semibold ${
                s.id === step ? "bg-ink text-paper" : i < index ? "bg-paper text-ink shadow-control" : "bg-paper text-muted shadow-control"
              }`}
            >
              <span className="aos-mono text-xs">{i + 1}</span>
              {s.label}
            </span>
          </li>
        ))}
      </ol>

      <section className={cardCls} aria-labelledby="step-title">
        {step === "name" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void go("business", { name });
            }}
          >
            <h2 id="step-title" className="aos-subheading">What should we call this workspace?</h2>
            <p className={helperCls}>Usually your business or brand name. Teammates and clients see it.</p>
            <label htmlFor="ob-name" className="sr-only">Workspace name</label>
            <input
              id="ob-name"
              className={`${inputCls} mt-3`}
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "ob-error" : undefined}
              autoFocus
            />
            <FormError id="ob-error" message={error} />
            <div className="mt-5 flex justify-end">
              <button type="submit" className={btnPrimary} disabled={busy !== null || !name.trim()}>
                {busy === "next" ? "Saving" : "Continue"}
                <ArrowRight size={16} aria-hidden />
              </button>
            </div>
          </form>
        )}

        {step === "business" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void go("connect", { business: { businessType, website, goals, notes } });
            }}
          >
            <h2 id="step-title" className="aos-subheading">Tell us about the business</h2>
            <p className={helperCls}>Saved to your company knowledge, where every agent reads it.</p>

            <fieldset className="mt-4">
              <legend className={labelCls}>What kind of business is it?</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {props.businessTypes.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={businessType === t.id}
                    className={chipCls(businessType === t.id)}
                    onClick={() => setBusinessType(businessType === t.id ? null : t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="mt-5">
              <label htmlFor="ob-website" className={labelCls}>Website</label>
              <input
                id="ob-website"
                className={`${inputCls} mt-1`}
                value={website}
                placeholder="example.com"
                inputMode="url"
                onChange={(e) => setWebsite(e.target.value)}
              />
              <p className={helperCls}>
                {hasProject
                  ? "Used for your company profile."
                  : "We'll set it up as your first project, so audits and rankings have a site to work on."}
              </p>
            </div>

            <fieldset className="mt-5">
              <legend className={labelCls}>What do you want to get done first?</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {props.goals.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    aria-pressed={goals.includes(g.id)}
                    className={chipCls(goals.includes(g.id))}
                    onClick={() => toggleGoal(g.id)}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="mt-5">
              <label htmlFor="ob-notes" className={labelCls}>Anything else agents should know? (optional)</label>
              <textarea
                id="ob-notes"
                className={`${textareaCls} mt-1`}
                rows={3}
                maxLength={1000}
                value={notes}
                placeholder="Who you sell to, what makes you different, what's worked before."
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            <FormError message={error} />
            <div className="mt-5 flex justify-between gap-2">
              <button type="button" className={btnQuiet} onClick={() => void go("name")} disabled={busy !== null}>
                <ArrowLeft size={16} aria-hidden />
                Back
              </button>
              <button type="submit" className={btnPrimary} disabled={busy !== null}>
                {busy === "next" ? "Saving" : "Continue"}
                <ArrowRight size={16} aria-hidden />
              </button>
            </div>
          </form>
        )}

        {step === "connect" && (
          <div>
            <h2 id="step-title" className="aos-subheading">Connect your first tools</h2>
            <p className={helperCls}>
              Picked for your business. Connect what you use now; the rest can wait. Your place here is saved.
            </p>
            <ul className="mt-4 flex flex-col gap-2">
              {suggestions.map((s) => (
                <li key={s.key} className="flex flex-wrap items-center justify-between gap-3 rounded-sm px-3 py-3 shadow-hairline">
                  <div className="min-w-0">
                    <div className="text-base font-semibold text-ink">{s.label}</div>
                    <div className="text-sm text-muted">{s.why}</div>
                  </div>
                  <Link href={s.href} className={btnSecondary}>
                    Connect
                    <ExternalLink size={14} aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
            <FormError message={error} />
            <div className="mt-5 flex justify-between gap-2">
              <button type="button" className={btnQuiet} onClick={() => void go("business")} disabled={busy !== null}>
                <ArrowLeft size={16} aria-hidden />
                Back
              </button>
              <button type="button" className={btnPrimary} onClick={() => void go("report")} disabled={busy !== null}>
                {busy === "next" ? "Saving" : "Continue"}
                <ArrowRight size={16} aria-hidden />
              </button>
            </div>
          </div>
        )}

        {step === "report" && (
          <div>
            <h2 id="step-title" className="aos-subheading">Get your intelligence report</h2>
            <p className="mt-2 text-base text-muted">
              Twelve audits of your company, market, competitors, website, search, ads, reviews, and more, with the
              biggest opportunities ranked and a 90-day plan. Anything we can&rsquo;t see yet is labeled as missing, never
              guessed. The more you&rsquo;ve connected, the sharper it gets.
            </p>
            <FormError message={error} />
            <div className="mt-5 flex flex-wrap justify-between gap-2">
              <button type="button" className={btnQuiet} onClick={() => void go("connect")} disabled={busy !== null}>
                <ArrowLeft size={16} aria-hidden />
                Back
              </button>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={btnSecondary}
                  disabled={busy !== null}
                  onClick={() => void finish("/dashboard", "complete")}
                >
                  Go to the dashboard
                </button>
                <button
                  type="button"
                  className={btnPrimary}
                  disabled={busy !== null}
                  onClick={() => void finish("/dashboard/authority/intelligence", "complete")}
                >
                  <FileSearch size={16} aria-hidden />
                  {busy === "complete" ? "Opening" : "Open the intelligence report"}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
