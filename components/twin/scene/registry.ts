// ShapesOS — Phase 13 (twinui): one lazily-loaded component per object kind.
// Each `import()` is its own chunk, so a store never downloads the dock-door
// or forklift code and a warehouse never loads registers.

"use client";

import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { TwinObjectKind } from "@/lib/twin/types";
import type { KindProps } from "./context";

export const KIND_COMPONENTS: Readonly<Record<TwinObjectKind, LazyExoticComponent<ComponentType<KindProps>>>> = {
  building: lazy(() => import("./kinds/Building")),
  dock_door: lazy(() => import("./kinds/DockDoor")),
  rack: lazy(() => import("./kinds/Rack")),
  bin_zone: lazy(() => import("./kinds/BinZone")),
  yard_slot: lazy(() => import("./kinds/YardSlot")),
  work_center: lazy(() => import("./kinds/WorkCentre")),
  register: lazy(() => import("./kinds/Register")),
  shelf: lazy(() => import("./kinds/Shelf")),
  path: lazy(() => import("./kinds/Path")),
  equipment: lazy(() => import("./kinds/Equipment")),
};
