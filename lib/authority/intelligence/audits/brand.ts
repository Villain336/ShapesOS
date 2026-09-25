// Marketr — Phase 6 I1 audit 5: Brand — NEW brand-consistency scorer.
// Messaging consistency across site/ads/social using Creative Studio assets.
//
// Heuristic scorer: it checks structural consistency (kit exists, palette
// locked, tone documented, assets present across channels) — it does NOT
// claim to read images or judge copy quality. Every finding is labeled
// heuristic.

import { prisma } from "@/lib/prisma";
import type { AuditContext, AuditResult } from "../types";
import { clampScore, nowIso } from "./index";

export async function runBrandAudit(ctx: AuditContext): Promise<AuditResult> {
  const findings: AuditResult["findings"] = [];
  let score = 40; // baseline: the business exists; everything else is earned
  let signals = 0;

  const kit = await prisma.brandKit.findFirst({
    where: { workspaceId: ctx.workspaceId, isDefault: true },
  }) ?? await prisma.brandKit.findFirst({ where: { workspaceId: ctx.workspaceId } });

  if (kit) {
    signals += 1;
    score += 15;
    const colors = Object.keys((kit.colors ?? {}) as Record<string, unknown>).length;
    const fonts = Object.keys((kit.fonts ?? {}) as Record<string, unknown>).length;
    findings.push({
      severity: colors >= 3 && fonts >= 1 ? "info" : "warn",
      title: `Brand kit "${kit.name}": ${colors} palette colors, ${fonts} typefaces`,
      detail: colors >= 3 && fonts >= 1
        ? "Palette and type are locked — creatives and PDFs render on-brand."
        : "Lock the palette (3+ colors) and at least one typeface so every surface matches.",
      dataSource: "BrandKit (heuristic)",
    });
    if (kit.tone) {
      signals += 1; score += 10;
      findings.push({
        severity: "info", title: "Brand voice documented",
        detail: `Tone on file: "${kit.tone.slice(0, 120)}${kit.tone.length > 120 ? "…" : ""}" — AI copy and review replies can inherit it.`,
        dataSource: "BrandKit.tone (heuristic)",
      });
    } else {
      findings.push({
        severity: "warn", title: "No brand voice on file",
        detail: "Document tone of voice so AI-generated copy doesn't drift between channels.",
        dataSource: "BrandKit.tone (heuristic)",
      });
    }
  } else {
    findings.push({
      severity: "critical", title: "No brand kit",
      detail: "Without a kit, every surface (site, ads, social, PDFs) is improvising the brand.",
      dataSource: "BrandKit (heuristic)",
    });
  }

  // Creative Studio assets (Phase 4) — presence across asset types.
  const assetCount = ctx.projectId
    ? await prisma.projectAsset.count({ where: { projectId: ctx.projectId } })
    : 0;
  const adCreatives = ctx.projectId
    ? await prisma.adCreative.count({ where: { projectId: ctx.projectId } })
    : 0;
  if (assetCount + adCreatives > 0) {
    signals += 1; score += 10;
    findings.push({
      severity: "info",
      title: `${assetCount} studio assets, ${adCreatives} ad creatives`,
      detail: "Creative inventory exists — the consistency job is keeping future assets inside the kit.",
      dataSource: "ProjectAsset + AdCreative (heuristic)",
    });
  } else {
    findings.push({
      severity: "warn", title: "No creative assets on file",
      detail: "Generate or upload brand assets so ads and social stop running on stock defaults.",
      dataSource: "ProjectAsset + AdCreative (heuristic)",
    });
  }

  // Social surface — do channels exist, and is posting happening?
  const projectWhere = ctx.projectId ? { projectId: ctx.projectId } : { projectId: "__none__" };
  const socialPosts = await prisma.socialPost.count({ where: projectWhere }).catch(() => 0);
  const socialChannels = await prisma.socialChannel.count({ where: projectWhere }).catch(() => 0);
  if (socialChannels > 0) {
    signals += 1; score += 8;
    findings.push({
      severity: "info",
      title: `${socialChannels} social channel${socialChannels > 1 ? "s" : ""} connected, ${socialPosts} posts tracked`,
      detail: socialPosts > 0
        ? "Social surface is active — apply the brand kit to templates so the feed reads as one brand."
        : "Channels connected but no posts tracked yet — schedule the first week of on-brand content.",
      dataSource: "SocialChannel + SocialPost (heuristic)",
    });
  } else {
    findings.push({
      severity: "warn", title: "No social channels connected",
      detail: "Connect social accounts so brand consistency extends to the social surface.",
      dataSource: "SocialChannel (heuristic)",
    });
  }

  // Cross-channel check: tone vs assets vs kit — a structural proxy for drift.
  if (signals >= 2 && !kit?.tone) {
    findings.push({
      severity: "warn", title: "Consistency risk: assets exist without a documented voice",
      detail: "When assets outrun the voice guide, copy drifts between site, ads, and social.",
      dataSource: "I1 brand-consistency scorer (heuristic)",
    });
    score -= 5;
  }

  return {
    id: "brand", name: "Brand",
    score: clampScore(score),
    completeness: signals >= 3 ? "full" : signals >= 1 ? "partial" : "partial",
    findings, dataSource: "BrandKit + ProjectAsset + AdCreative + SocialChannel (heuristic scorer)",
    computedAt: nowIso(),
  };
}
