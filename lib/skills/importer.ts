// Marketr — skills library: install paths for registry packs, GitHub/raw
// URLs, and SKILL.md uploads (spec §5 flows 1–2, §7 MVP scope).
// Network access happens ONLY inside previewFromUrl, and only through the
// injectable fetchImpl so tests never touch the network.

import type { PrismaClient } from "@prisma/client";
import { parseSkillMd } from "./frontmatter";
import { getRegistryPack, listRegistryPacks } from "./registry";
import type { UrlSkillPreview } from "./types";

/** Thrown for every skill-install validation or fetch failure. */
export class SkillImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillImportError";
  }
}

/** "SEO Audit" -> "seo-audit". Falls back to "skill" for empty input. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "skill";
}

/** Append -2, -3, ... until the slug is free in this workspace. */
async function uniqueSlug(db: PrismaClient, workspaceId: string, base: string): Promise<string> {
  const root = base || "skill";
  let slug = root;
  let n = 2;
  while (await db.skill.findFirst({ where: { workspaceId, slug } })) {
    slug = `${root}-${n}`;
    n += 1;
  }
  return slug;
}

/**
 * Install a built-in registry pack into a workspace.
 * Throws SkillImportError for unknown pack keys or malformed pack content.
 */
export async function installFromRegistry(
  db: PrismaClient,
  workspaceId: string,
  packKey: string,
  installedBy: string | null,
) {
  const pack = getRegistryPack(packKey);
  if (!pack) {
    const available = listRegistryPacks().map((p) => p.key).join(", ");
    throw new SkillImportError(`unknown registry pack: "${packKey}". Available: ${available}`);
  }
  const parsed = parseSkillMd(pack.skillMd);
  if (!parsed.ok) {
    throw new SkillImportError(
      `registry pack "${packKey}" failed validation: ${parsed.errors.join("; ")}`,
    );
  }
  const slug = await uniqueSlug(db, workspaceId, slugify(pack.key));
  return db.skill.create({
    data: {
      workspaceId,
      name: parsed.value.manifest.name,
      slug,
      description: parsed.value.manifest.description,
      source: "registry",
      sourceRef: pack.key,
      version: parsed.value.manifest.version ?? pack.version,
      shaPin: null,
      skillMd: pack.skillMd,
      declaredTools: parsed.value.manifest.declaredTools ?? pack.declaredTools,
      trustTier: "built_in",
      installedBy,
    },
  });
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

function isGithubRepoUrl(url: URL): boolean {
  return url.hostname.toLowerCase() === "github.com";
}

/**
 * Fetch a SKILL.md from a GitHub repository URL
 * (https://github.com/owner/repo — tries the `main` then `master` branch)
 * or a direct raw URL ending in SKILL.md.
 *
 * Resolves the pinned commit SHA via the GitHub API for github.com URLs.
 * When the SHA cannot be resolved the preview still succeeds with
 * sha: null and a warning — it never fails silently.
 * Throws SkillImportError on fetch or validation failure.
 */
export async function previewFromUrl(
  url: string,
  fetchImpl: FetchImpl = fetch,
): Promise<UrlSkillPreview> {
  const warnings: string[] = [];
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new SkillImportError(`not a valid URL: "${url}"`);
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new SkillImportError(`URL must use http(s): "${url}"`);
  }

  let skillMd: string;
  let sha: string | null = null;
  let rawUrl: string;

  if (isGithubRepoUrl(parsedUrl)) {
    const segments = parsedUrl.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) {
      throw new SkillImportError(
        `only repository-root GitHub URLs are supported (https://github.com/owner/repo); got "${url}"`,
      );
    }
    const [owner, repo] = segments;

    // Try `main`, then `master`, for the repo's SKILL.md.
    let fetchedBranch: string | null = null;
    let lastStatus: number | null = null;
    for (const branch of ["main", "master"]) {
      rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/SKILL.md`;
      let res: Response;
      try {
        res = await fetchImpl(rawUrl);
      } catch (e) {
        throw new SkillImportError(
          `failed to fetch SKILL.md from ${url}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (res.ok) {
        fetchedBranch = branch;
        skillMd = await res.text();
        break;
      }
      lastStatus = res.status;
    }
    if (!fetchedBranch) {
      throw new SkillImportError(
        `could not fetch SKILL.md from ${url} (tried main and master branches; last status ${lastStatus})`,
      );
    }

    // Pin the install to the branch's current commit SHA.
    try {
      const apiRes = await fetchImpl(
        `https://api.github.com/repos/${owner}/${repo}/commits/${fetchedBranch}`,
        { headers: { Accept: "application/vnd.github+json" } },
      );
      if (apiRes.ok) {
        const payload = (await apiRes.json()) as { sha?: unknown };
        if (typeof payload.sha === "string" && payload.sha.length > 0) {
          sha = payload.sha;
        } else {
          warnings.push("could not resolve commit SHA: GitHub API response had no sha");
        }
      } else {
        warnings.push(
          `could not resolve commit SHA: GitHub API returned status ${apiRes.status}`,
        );
      }
    } catch (e) {
      warnings.push(
        `could not resolve commit SHA: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } else if (parsedUrl.pathname.toLowerCase().endsWith("/skill.md")) {
    rawUrl = url;
    let res: Response;
    try {
      res = await fetchImpl(rawUrl);
    } catch (e) {
      throw new SkillImportError(
        `failed to fetch SKILL.md from ${url}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!res.ok) {
      throw new SkillImportError(`could not fetch SKILL.md from ${url} (status ${res.status})`);
    }
    skillMd = await res.text();
    warnings.push("could not resolve commit SHA for non-GitHub URL: install is unpinned");
  } else {
    throw new SkillImportError(
      `URL must be a GitHub repository URL or a direct link to a SKILL.md file: "${url}"`,
    );
  }

  const parsed = parseSkillMd(skillMd!);
  if (!parsed.ok) {
    throw new SkillImportError(
      `fetched SKILL.md failed validation: ${parsed.errors.join("; ")}`,
    );
  }

  return {
    name: parsed.value.manifest.name,
    description: parsed.value.manifest.description,
    version: parsed.value.manifest.version ?? "1.0.0",
    sha,
    skillMd: skillMd!,
    warnings,
  };
}

/**
 * Install a skill from a preview produced by previewFromUrl.
 * Records the SHA pin and marks the skill as pinned_url trust.
 */
export async function installFromUrl(
  db: PrismaClient,
  workspaceId: string,
  preview: UrlSkillPreview,
  url: string,
  installedBy: string | null,
) {
  const parsed = parseSkillMd(preview.skillMd);
  if (!parsed.ok) {
    throw new SkillImportError(
      `SKILL.md failed validation at install time: ${parsed.errors.join("; ")}`,
    );
  }
  const slug = await uniqueSlug(db, workspaceId, slugify(preview.name));
  return db.skill.create({
    data: {
      workspaceId,
      name: parsed.value.manifest.name,
      slug,
      description: parsed.value.manifest.description,
      source: "url",
      sourceRef: url,
      version: parsed.value.manifest.version ?? preview.version,
      shaPin: preview.sha,
      skillMd: preview.skillMd,
      declaredTools: parsed.value.manifest.declaredTools ?? [],
      trustTier: "pinned_url",
      installedBy,
    },
  });
}

function basename(filename: string): string {
  const noDirs = filename.split(/[\\/]/).pop() ?? filename;
  return noDirs.replace(/\.md$/i, "");
}

/**
 * Install a skill from an uploaded SKILL.md file's contents.
 * Throws SkillImportError when the content fails validation.
 */
export async function installFromUpload(
  db: PrismaClient,
  workspaceId: string,
  skillMd: string,
  filename: string,
  installedBy: string | null,
) {
  const parsed = parseSkillMd(skillMd);
  if (!parsed.ok) {
    throw new SkillImportError(
      `uploaded SKILL.md failed validation: ${parsed.errors.join("; ")}`,
    );
  }
  const fromFilename = slugify(basename(filename));
  const slug = await uniqueSlug(
    db,
    workspaceId,
    fromFilename === "skill" ? slugify(parsed.value.manifest.name) : fromFilename,
  );
  return db.skill.create({
    data: {
      workspaceId,
      name: parsed.value.manifest.name,
      slug,
      description: parsed.value.manifest.description,
      source: "upload",
      sourceRef: filename,
      version: parsed.value.manifest.version ?? "1.0.0",
      shaPin: null,
      skillMd,
      declaredTools: parsed.value.manifest.declaredTools ?? [],
      trustTier: "pinned_url",
      installedBy,
    },
  });
}
