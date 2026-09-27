// Marketr — Phase 12 "embeds": GrowthBook JS SDK wiring.
// Client provider + useFlag hook.
//
// Evaluation order for a flag (first hit wins):
//   1. this workspace's override (Settings → Experiments toggle) —
//      fetched from /api/experiments/flags as effectiveValue;
//   2. the GrowthBook sidecar's remote value (init fetch);
//   3. Marketr's built-in default (lib/integrations/growthbook.ts).
// Without a configured sidecar the built-ins apply — the app behaves
// identically, which is the whole point of the proof loop.
//
// The SDK config is injected by a tiny server component
// (GrowthBookConfig) so no secret ever reaches the browser — the client
// key is public by design.

"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { GrowthBook } from "@growthbook/growthbook";
import {
  MARKETR_FLAGS,
  type MarketrFlagKey,
} from "@/lib/integrations/growthbook";

export interface GrowthBookPublicConfig {
  apiHost: string;
  clientKey: string;
}

const FlagContext = createContext<Record<MarketrFlagKey, boolean> | null>(null);

function defaultFlags(): Record<MarketrFlagKey, boolean> {
  const out = {} as Record<MarketrFlagKey, boolean>;
  for (const [key, def] of Object.entries(MARKETR_FLAGS)) {
    out[key as MarketrFlagKey] = def.defaultValue;
  }
  return out;
}

type EffectiveFlagRow = {
  id: string;
  effectiveValue: unknown;
};

export function GrowthBookProvider({
  config,
  children,
}: {
  config: GrowthBookPublicConfig | null;
  children: ReactNode;
}) {
  const [flags, setFlags] = useState<Record<MarketrFlagKey, boolean>>(defaultFlags);

  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    const seedFeatures: Record<string, { defaultValue: boolean }> = {};
    for (const [key, def] of Object.entries(MARKETR_FLAGS)) {
      seedFeatures[key] = { defaultValue: def.defaultValue };
    }
    const gb = new GrowthBook({
      apiHost: config.apiHost,
      clientKey: config.clientKey,
      features: seedFeatures,
      enableDevMode: false,
    });

    const apply = (effective: Record<string, unknown>) => {
      const next = defaultFlags();
      for (const key of Object.keys(MARKETR_FLAGS) as MarketrFlagKey[]) {
        // Workspace override wins; otherwise the SDK's evaluated value
        // (remote GrowthBook value or seeded built-in default).
        next[key] =
          typeof effective[key] === "boolean"
            ? (effective[key] as boolean)
            : gb.getFeatureValue(key, next[key]);
      }
      setFlags(next);
    };

    (async () => {
      // 1. Workspace overrides first — they must survive the init fetch.
      let effective: Record<string, unknown> = {};
      try {
        const res = await fetch("/api/experiments/flags");
        if (res.ok) {
          const json = (await res.json()) as { features?: EffectiveFlagRow[] };
          for (const f of json.features ?? []) {
            if (typeof f.id === "string") effective[f.id] = f.effectiveValue;
          }
          // Re-apply after init() below: the remote fetch can overwrite
          // seeded features, and the tenant override must win.
          gb.setFeatures(
            Object.fromEntries(
              Object.entries(effective).map(([k, v]) => [k, { defaultValue: v }]),
            ),
          );
        }
      } catch {
        // Flags API unreachable — SDK defaults still apply.
      }
      // 2. Live values from the sidecar (no-op when unreachable).
      try {
        await gb.init({ streaming: false });
      } catch {
        // Keep whatever we have.
      }
      if (cancelled) return;
      // 3. Re-assert overrides post-init: init's remote fetch would
      // otherwise clobber the tenant-scoped values.
      if (Object.keys(effective).length > 0) {
        gb.setFeatures(
          Object.fromEntries(
            Object.entries(effective).map(([k, v]) => [k, { defaultValue: v }]),
          ),
        );
      }
      apply(effective);
    })();

    return () => {
      cancelled = true;
      gb.destroy();
    };
  }, [config]);

  const value = useMemo(() => flags, [flags]);
  return <FlagContext.Provider value={value}>{children}</FlagContext.Provider>;
}

/** Read a Marketr flag; falls back to the built-in default outside a provider. */
export function useFlag(key: MarketrFlagKey): boolean {
  const ctx = useContext(FlagContext);
  if (ctx) return ctx[key];
  return MARKETR_FLAGS[key].defaultValue;
}
