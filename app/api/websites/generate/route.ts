// Marketr — AI landing-page builder API (milestone 7).
// POST /api/websites/generate { projectId, prompt, contentItemId? }
//   → { html, llm: { name, isLive, model }, briefUsed: boolean }
//
// The LLM writes ONE complete, self-contained HTML file (Tailwind via CDN):
// hero, features, testimonials, CTA, FAQ — real copy, never lorem ipsum.
// Optionally grounded in a milestone-4 content brief (keyword → brief →
// landing page tie-in). Without an LLM key, a clearly-labeled mock page is
// returned so the builder → preview → save flow works end-to-end.

import { requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { llmStatus } from "@/lib/llm";
import { getLlmProviderForWorkspace } from "@/lib/llm/workspace";
import { ownedProject, readJsonBody } from "@/lib/sitefiles/api";
import { recordUsage } from "@/lib/usage";
// Phase 21A (WS=agentweb): agent-ready output — WebMCP form annotations (never auto-submit).
import { annotateForms } from "@/lib/agentweb/site/actions";

interface GenerateBody {
  projectId?: string;
  prompt?: string;
  contentItemId?: string;
}

function buildBuilderPrompt(userPrompt: string, brief: string | null): string {
  return [
    "You are an expert landing-page designer and copywriter. Generate ONE complete,",
    "self-contained HTML landing page. Output ONLY the HTML inside a single fenced block:",
    "```html",
    "<!DOCTYPE html> ...",
    "```",
    "Rules:",
    "- Single file. Tailwind CSS via CDN (<script src=\"https://cdn.tailwindcss.com\"></script>).",
    "- Sections: sticky nav, hero with headline + subhead + CTA button, social proof strip,",
    "  features (3-4 with icons), how-it-works (3 steps), testimonials (3, realistic names),",
    "  pricing teaser or guarantee, FAQ (4-5 questions), final CTA, footer.",
    "- Write REAL, specific marketing copy — never lorem ipsum, never placeholder text.",
    "- Responsive, modern, polished. Inline <style> only for what Tailwind can't do.",
    "- No external images (use CSS/SVG/emoji for visuals). Minimal emojis.",
    "- Any form (contact, booking, quote) gets a visible <label for> on EVERY field, a name on every",
    "  input and a real action URL; people and AI agents both rely on those labels.",
    brief ? `Content brief to ground the copy:\n${brief}` : "",
    `The landing page is for: "${userPrompt}"`,
  ]
    .filter(Boolean)
    .join("\n");
}

function extractHtml(raw: string): string | null {
  const m = raw.match(/```html\s*\n([\s\S]*?)```/i);
  if (m) return m[1].trim();
  const t = raw.trim();
  if (/^<!DOCTYPE html/i.test(t) || /^<html/i.test(t)) return t;
  return null;
}

/** Labeled mock page so the flow works without an LLM key. */
function mockLandingPage(topic: string): string {
  const title = topic.length > 60 ? topic.slice(0, 60) : topic || "Your Business";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Landing Page (MOCK)</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-zinc-950 text-zinc-100 antialiased">
<nav class="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
  <span class="text-lg font-bold">${escapeHtml(title)}</span>
  <a href="#cta" class="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950">Get started</a>
</nav>
<header class="mx-auto max-w-5xl px-6 py-20 text-center">
  <p class="mb-4 inline-block rounded-full border border-amber-700 bg-amber-950 px-3 py-1 text-xs text-amber-200">MOCK preview — set LLM_API_KEY for real AI-generated pages</p>
  <h1 class="text-5xl font-extrabold tracking-tight">${escapeHtml(title)}: built to convert</h1>
  <p class="mx-auto mt-5 max-w-2xl text-lg text-zinc-400">This is a demo page generated without an LLM. Connect an LLM key and describe your business to generate real copy, sections, and design.</p>
  <div class="mt-8 flex justify-center gap-4">
    <a href="#cta" class="rounded-lg bg-emerald-500 px-6 py-3 font-semibold text-zinc-950">Start free trial</a>
    <a href="#features" class="rounded-lg border border-zinc-700 px-6 py-3 font-semibold">See how it works</a>
  </div>
</header>
<section id="features" class="mx-auto max-w-5xl px-6 py-16">
  <h2 class="text-3xl font-bold">Everything you need</h2>
  <div class="mt-8 grid gap-6 md:grid-cols-3">
    ${["Fast setup", "Real results", "Human support"].map((f) => `<div class="rounded-xl border border-zinc-800 bg-zinc-900 p-6"><h3 class="font-semibold">${f}</h3><p class="mt-2 text-sm text-zinc-400">Demo copy — regenerate with an LLM key for real content.</p></div>`).join("\n    ")}
  </div>
</section>
<section id="cta" class="mx-auto max-w-5xl px-6 py-20 text-center">
  <h2 class="text-3xl font-bold">Ready when you are</h2>
  <a href="#" class="mt-6 inline-block rounded-lg bg-emerald-500 px-8 py-3 font-semibold text-zinc-950">Get started</a>
</section>
<footer class="border-t border-zinc-800 px-6 py-8 text-center text-sm text-zinc-500">© 2026 ${escapeHtml(title)} (mock)</footer>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await readJsonBody<GenerateBody>(req);
  if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });

  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "editor"))) return forbidden();

  const prompt = (body.prompt ?? "").trim();
  if (!prompt) return Response.json({ error: "Describe the landing page first" }, { status: 400 });
  if (prompt.length > 2000) return Response.json({ error: "Prompt too long" }, { status: 400 });

  // Optional tie-in: ground the page in a milestone-4 content brief.
  let brief: string | null = null;
  let briefUsed = false;
  if (body.contentItemId) {
    const item = await prisma.contentItem.findFirst({
      where: { id: body.contentItemId, projectId: project.id },
      include: { keyword: true },
    });
    if (item) {
      const outline = item.outlineJson as { h1?: string; h2?: string[]; paa?: string[] } | null;
      brief = [
        item.keyword ? `Target keyword: ${item.keyword.phrase}` : "",
        outline?.h1 ? `H1: ${outline.h1}` : "",
        outline?.h2?.length ? `Outline: ${outline.h2.join(" | ")}` : "",
        outline?.paa?.length ? `Answer these: ${outline.paa.join(" | ")}` : "",
        item.bodyMarkdown ? `Draft excerpt: ${item.bodyMarkdown.slice(0, 1500)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      briefUsed = brief.length > 0;
    }
  }

  // Phase D: generated site HTML is client-facing → "copy" workload.
  // Phase 15: the workspace's own model key when it has one; metered by tokens.
  const llm = await getLlmProviderForWorkspace("copy", { workspaceId: project.workspaceId, projectId: project.id, actorId: user.id });
  let html: string;
  if (!llm.isLive) {
    html = mockLandingPage(prompt);
  } else {
    let raw: string;
    try {
      raw = await llm.generate(buildBuilderPrompt(prompt, brief));
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "LLM request failed" },
        { status: 502 },
      );
    }
    const parsed = extractHtml(raw);
    if (!parsed) {
      return Response.json(
        { error: "The AI didn't return a valid HTML page. Try regenerating." },
        { status: 502 },
      );
    }
    html = parsed;
    // Best-effort metering (never breaks the flow).
    try {
      await recordUsage(project.workspaceId, "ai_words", Math.ceil(html.length / 5));
    } catch {
      /* ignore */
    }
  }

  // Phase 21A (WS=agentweb): contact/booking/quote forms become WebMCP tools (toolname,
  // tooldescription, toolparamdescription); idempotent, never toolautosubmit.
  html = annotateForms(html, { siteName: project.domain }).html;

  return Response.json({ html, llm: llmStatus(), briefUsed });
}
