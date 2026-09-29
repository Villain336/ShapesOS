// Marketr — Phase 16 slice 9: branded report engine — versioned templates.
//
// Templates are versioned FILES (HTML+CSS pairs) with semver, not DB rows:
//   lib/reports/templates/<name>/<semver>/template.html
//   lib/reports/templates/<name>/<semver>/report.css
//
// Old reports re-render byte-identical: a ReportSendApproval pins
// templateName + templateVersion, and this registry always serves the exact
// pinned files. New versions are added as new directories; old ones are never
// edited in place.

import { promises as fs } from "node:fs";
import path from "node:path";
import { assertTemplateCssValid } from "../template-lint";

export interface ResolvedTemplate {
  /** Template name, e.g. "client-performance". */
  name: string;
  /** Pinned semver, e.g. "1.0.0". */
  version: string;
  html: string;
  css: string;
}

const TEMPLATES_DIR = __dirname;
const SEMVER = /^\d+\.\d+\.\d+$/;

function parseSemver(v: string): [number, number, number] {
  const [a, b, c] = v.split(".").map(Number);
  return [a, b, c];
}

function compareSemver(a: string, b: string): number {
  const [a1, a2, a3] = parseSemver(a);
  const [b1, b2, b3] = parseSemver(b);
  return a1 - b1 || a2 - b2 || a3 - b3;
}

async function listVersions(name: string): Promise<string[]> {
  const dir = path.join(TEMPLATES_DIR, name);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && SEMVER.test(e.name))
    .map((e) => e.name)
    .sort(compareSemver);
}

async function loadVersion(name: string, version: string): Promise<ResolvedTemplate> {
  const dir = path.join(TEMPLATES_DIR, name, version);
  const [html, css] = await Promise.all([
    fs.readFile(path.join(dir, "template.html"), "utf8"),
    fs.readFile(path.join(dir, "report.css"), "utf8"),
  ]);
  assertTemplateCssValid(css, `${name}@${version}`);
  return { name, version, html, css };
}

/**
 * Resolve a template by name + version. `version` may be an exact semver or
 * "latest". Exact pins (what reports store) are served byte-identical.
 */
export async function resolveTemplate(name: string, version: string = "latest"): Promise<ResolvedTemplate> {
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(`Invalid template name "${name}" (expected [a-z0-9-])`);
  }
  const versions = await listVersions(name);
  if (versions.length === 0) throw new Error(`Unknown report template "${name}"`);

  const pinned = version === "latest" ? versions[versions.length - 1] : version;
  if (!versions.includes(pinned)) {
    throw new Error(
      `Template "${name}" has no version "${version}" (available: ${versions.join(", ")})`,
    );
  }
  return loadVersion(name, pinned);
}

/** List available versions of a template (newest last). */
export async function listTemplateVersions(name: string): Promise<string[]> {
  return listVersions(name);
}
