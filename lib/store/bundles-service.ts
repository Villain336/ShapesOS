// ShapesOS Phase 24 - install the people-selected members of a Store bundle.
// Every member goes through installStoreItem, so each kind's own role /
// permission check, audit row and conflict handling apply exactly as for a
// single install. A bundle can't install a connector or MCP server (those
// need the person's own credentials), and it never touches a member the
// person didn't select. Not atomic: each member succeeds or fails alone and
// the result says which.

import { BadRequestError, HttpError, NotFoundError } from "@/lib/api/errors";
import { hasPermission } from "@/lib/authz";
import { getBundle, memberId, planBundle, BUNDLES, type BundlePlan } from "./bundles";
import { installStoreItem, loadStoreCatalogue, type StoreActor } from "./service";

export interface BundleMemberResult {
  id: string;
  outcome: "installed" | "skipped" | "failed";
  reason?: string;
}

async function plansFor(actor: StoreActor) {
  const [catalogue, canInstallSkills] = await Promise.all([
    loadStoreCatalogue(actor),
    hasPermission(actor.userId, actor.workspaceId, "skills.install"),
  ]);
  const who = { role: actor.role, canInstallSkills };
  return { catalogue, who };
}

export async function listBundlePlans(actor: StoreActor): Promise<BundlePlan[]> {
  const { catalogue, who } = await plansFor(actor);
  return BUNDLES.map((b) => planBundle(b, catalogue.items, who));
}

export async function installBundle(
  actor: StoreActor,
  bundleKey: string,
  selected: readonly string[],
): Promise<{ bundle: string; results: BundleMemberResult[] }> {
  const bundle = getBundle(bundleKey);
  if (!bundle) throw new NotFoundError(`No bundle "${bundleKey}".`);
  const picked = new Set(selected);
  if (picked.size === 0) throw new BadRequestError("Choose at least one item to install.");
  const known = new Set(bundle.members.map(memberId));
  for (const id of picked) if (!known.has(id)) throw new BadRequestError(`"${id}" is not part of this bundle.`);

  const { catalogue, who } = await plansFor(actor);
  const plan = planBundle(bundle, catalogue.items, who);
  const results: BundleMemberResult[] = [];
  for (const m of plan.members) {
    const id = memberId(m);
    if (!picked.has(id)) continue;
    if (m.action === "connect_separately") {
      results.push({ id, outcome: "skipped", reason: m.reason });
      continue;
    }
    if (m.action === "already_installed") {
      results.push({ id, outcome: "skipped", reason: "Already installed." });
      continue;
    }
    if (m.action === "unavailable") {
      results.push({ id, outcome: "skipped", reason: m.reason });
      continue;
    }
    // "installable" AND "blocked" both go through the member's own install
    // path: a plan is advice, the kind's real check is the gate.
    try {
      await installStoreItem(actor, m.kind, m.key);
      results.push({ id, outcome: "installed" });
    } catch (e) {
      if (e instanceof HttpError) results.push({ id, outcome: "failed", reason: e.message });
      else throw e;
    }
  }
  return { bundle: bundle.key, results };
}
