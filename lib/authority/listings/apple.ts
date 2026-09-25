// Marketr — Phase 6 L1: Apple Business Connect guided claim walkthrough.
//
// Honest labeling (§9.10): the Business Connect API is partner-only — no
// self-serve path exists. Marketr does NOT automate Apple claims; it walks
// the human through claiming their free listing. Review replies are NOT
// programmable — monitor only.

export interface AppleClaimStep {
  order: number;
  title: string;
  detail: string;
  ownerAction: string;
}

export const APPLE_CLAIM_STEPS: AppleClaimStep[] = [
  {
    order: 1,
    title: "Open Apple Business Connect",
    detail: "Sign in at businessconnect.apple.com with the business owner's Apple ID. Use the owner's account — not an agency login — so ownership transfers cleanly.",
    ownerAction: "Sign in with the owner's Apple ID",
  },
  {
    order: 2,
    title: "Search for the business",
    detail: "Search by business name and address. If Apple already has a place card, claim it instead of creating a duplicate — duplicates split ratings and confuse Maps.",
    ownerAction: "Find or create the place card",
  },
  {
    order: 3,
    title: "Complete verification",
    detail: "Apple verifies ownership — typically via a phone call or document upload to the business listing. This is owner-performed; Marketr cannot do it for you.",
    ownerAction: "Complete Apple's verification",
  },
  {
    order: 4,
    title: "Enter NAP, hours, categories, photos",
    detail: "Fill in name, address, phone, website, hours, categories, and photos. Keep this identical to the GBP listing — NAP consistency is what the verification sweep checks.",
    ownerAction: "Enter listing details matching GBP",
  },
  {
    order: 5,
    title: "Enable Showcases and review monitoring",
    detail: "Apple Business Connect shows reviews aggregated from partner sources (e.g. Yelp) — review replies are NOT programmable on Apple. Monitor here; reply on the source platform.",
    ownerAction: "Monitor reviews; reply on Yelp",
  },
  {
    order: 6,
    title: "Mark claimed in Marketr",
    detail: "Once Apple confirms the listing, mark it claimed in Marketr so the channel status flips to connected and sync monitoring begins.",
    ownerAction: "Confirm the claim in Marketr",
  },
];

export type AppleClaimProgress = "not_started" | "in_progress" | "claimed";

export const APPLE_REVIEW_REPLIES_COPY =
  "Review replies are NOT programmable on Apple Business Connect — monitor only. " +
  "Apple Maps reviews aggregate from partner sources like Yelp; respond there.";

export interface AppleClaimState {
  workspaceId: string;
  progress: AppleClaimProgress;
  completedSteps: number[];
  startedAt: string | null;
  claimedAt: string | null;
}

export function newAppleClaimState(workspaceId: string): AppleClaimState {
  return { workspaceId, progress: "not_started", completedSteps: [], startedAt: null, claimedAt: null };
}

/** Mark a walkthrough step complete. Steps must complete in order — no skipping implied. */
export function completeAppleClaimStep(state: AppleClaimState, stepOrder: number): AppleClaimState {
  if (!APPLE_CLAIM_STEPS.some((s) => s.order === stepOrder)) {
    throw new Error(`Unknown Apple claim step ${stepOrder}.`);
  }
  const expected = state.completedSteps.length + 1;
  if (stepOrder !== expected) {
    throw new Error(`Apple claim steps complete in order — step ${expected} is next, not step ${stepOrder}.`);
  }
  const completedSteps = [...state.completedSteps, stepOrder];
  const claimed = completedSteps.length === APPLE_CLAIM_STEPS.length;
  return {
    ...state,
    progress: claimed ? "claimed" : "in_progress",
    completedSteps,
    startedAt: state.startedAt ?? new Date().toISOString(),
    claimedAt: claimed ? new Date().toISOString() : null,
  };
}
