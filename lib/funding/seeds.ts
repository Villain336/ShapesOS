// Marketr — Funding/VC slice 1: seed data.
// Boardy AI ships as the PRELOADED starter contact in every tenant's
// funding graph — the first card in the deck. Boardy is an AI superconnector
// (boardy@boardy.ai, free to use); his job here is to help the founder get
// MORE contacts through warm intros matched to the founder's target investor
// profile. There is no programmatic Boardy API — the agentskill page is an
// email flow, and Boardy's double-opt-in norms govern his side.

import { BOARDY_STARTER_KEY } from "./types";

export interface SeedFundingContact {
  name: string;
  role: string;
  handle: string;
  note: string;
  source: "boardy_starter";
  isStarterContact: true;
  starterKey: typeof BOARDY_STARTER_KEY;
}

export const BOARDY_STARTER_CONTACT: SeedFundingContact = {
  name: "Boardy",
  role: "AI superconnector",
  handle: "boardy@boardy.ai",
  note: "Your starter contact. Boardy helps you grow your network through warm intros matched to your target investor profile — free to use, double-opt-in on his side. Start with your raise profile, then ask Boardy who to meet.",
  source: "boardy_starter",
  isStarterContact: true,
  starterKey: BOARDY_STARTER_KEY,
};

/** Validate the seed at boot: the starter contact must never lose its marker. */
export function validateStarterSeed(seed: SeedFundingContact = BOARDY_STARTER_CONTACT): string[] {
  const errors: string[] = [];
  if (seed.name !== "Boardy") errors.push("starter contact name must be 'Boardy'.");
  if (seed.role !== "AI superconnector")
    errors.push("starter contact role must be 'AI superconnector'.");
  if (seed.handle !== "boardy@boardy.ai")
    errors.push("starter contact handle must be 'boardy@boardy.ai'.");
  if (seed.source !== "boardy_starter")
    errors.push("starter contact source must be 'boardy_starter'.");
  if (!seed.isStarterContact)
    errors.push("starter contact must carry isStarterContact = true.");
  if (seed.starterKey !== BOARDY_STARTER_KEY)
    errors.push("starter contact starterKey must be the Boardy idempotency key.");
  return errors;
}
