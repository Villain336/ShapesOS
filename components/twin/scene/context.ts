// ShapesOS — Phase 13 (twinui): what every object component in the twin
// scene can read (site grid, view quadrant for cut-away walls, selection,
// hover, edit mode and the edit callbacks). Client-only.

"use client";

import { createContext, useContext, type MutableRefObject } from "react";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { TwinFootprint, TwinObject } from "@/lib/twin/types";
import type { SiteGrid } from "@/lib/twin/scene-kit";

export interface SceneCtx {
  grid: SiteGrid;
  /** 0 SE · 1 NE · 2 NW · 3 SW: which walls face the camera. */
  quadrant: 0 | 1 | 2 | 3;
  selectedId: string | null;
  hoverId: string | null;
  editing: boolean;
  /** buildings that contain other objects are drawn cut-away (no roof, low front walls) */
  hollowBuildings: ReadonlySet<string>;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  /** Edit mode: an object was dragged to a new footprint (false = refused; the object snaps back). */
  onMove: (o: TwinObject, footprint: TwinFootprint) => Promise<boolean | void> | void;
  controls: MutableRefObject<OrbitControlsImpl | null>;
}

export const TwinSceneContext = createContext<SceneCtx | null>(null);

export function useTwinScene(): SceneCtx {
  const v = useContext(TwinSceneContext);
  if (!v) throw new Error("useTwinScene outside TwinCanvas");
  return v;
}

/** Props every per-kind component receives (local space: centred, unrotated, front = +z). */
export interface KindProps {
  o: TwinObject;
}
