// ShapesOS — Phase 13 (twinui): the twin's isometric 3D canvas.
//
// Client-only chunk (loaded with next/dynamic { ssr: false } by TwinClient;
// the server-rendered TwinTopDownSvg holds its place until the first frame).
// Orthographic isometric camera, frameloop="demand" (renders only when
// something changes — no idle animation), OrbitControls limited to the site,
// soft directional + ambient light, a flat clay ground with a token-coloured
// grid, one lazily-loaded component per object kind, raycast hover/select,
// agent markers as the only status colours, gsap fly-to (jumps instead under
// prefers-reduced-motion), and the layout editor's place/drag on the grid.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import gsap from "gsap";
import type {
  TwinFootprint,
  TwinObject,
  TwinObjectKind,
  TwinSnapshot,
} from "@/lib/twin/types";
import {
  clayColor,
  clayMaterial,
  fitZoom,
  footprintCenter,
  cellToWorld,
  groundPlaneGeometry,
  isoCameraPosition,
  ISO_AZIMUTH,
  ISO_ELEVATION,
  occupiedRect,
  viewQuadrant,
  worldToCell,
  boxGeometry,
  type SiteGrid,
} from "@/lib/twin/scene-kit";
import { agentsByObject } from "@/lib/twin/view-model";
import type { TwinCameraApi } from "../camera-api";
import { TwinSceneContext, type SceneCtx } from "./context";
import { ObjectShell } from "./ObjectShell";
import {
  MarkerLayer,
  MarkerProjector,
  markerAnchor,
  type MarkerAnchor,
} from "./Markers";

export interface TwinCanvasProps {
  snapshot: TwinSnapshot;
  selectedId: string | null;
  hoverId: string | null;
  editing: boolean;
  /** Edit mode: the palette kind being placed (a ground click places it). */
  placing: { kind: TwinObjectKind; w: number; d: number } | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onMove: (
    o: TwinObject,
    footprint: TwinFootprint,
  ) => Promise<boolean | void> | void;
  onPlace: (cell: { x: number; z: number }) => void;
  onApi: (api: TwinCameraApi | null) => void;
  /** The first frame is on screen (the SVG placeholder can go). */
  onReady: () => void;
  /** WebGL context lost / failed (fall back to the SVG). */
  onFail: (reason: string) => void;
}

const DISTANCE = 220;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

// ---------------------------------------------------------------------------
// Ground: the site slab and its 1 m grid (5 m lines a touch stronger)
// ---------------------------------------------------------------------------

function Ground({
  grid,
  onGround,
  onGroundMove,
}: {
  grid: SiteGrid;
  onGround: (e: ThreeEvent<MouseEvent>) => void;
  onGroundMove: (e: ThreeEvent<PointerEvent>) => void;
}) {
  const lines = useMemo(() => {
    const minor: number[] = [];
    const major: number[] = [];
    const hw = grid.gridW / 2;
    const hd = grid.gridD / 2;
    for (let x = 0; x <= grid.gridW; x++)
      (x % 5 === 0 ? major : minor).push(x - hw, 0.012, -hd, x - hw, 0.012, hd);
    for (let z = 0; z <= grid.gridD; z++)
      (z % 5 === 0 ? major : minor).push(-hw, 0.012, z - hd, hw, 0.012, z - hd);
    const mk = (arr: number[]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
      return g;
    };
    return { minor: mk(minor), major: mk(major) };
  }, [grid.gridW, grid.gridD]);
  const mats = useMemo(
    () => ({
      minor: new THREE.LineBasicMaterial({
        color: new THREE.Color(clayColor("grid")),
      }),
      major: new THREE.LineBasicMaterial({
        color: new THREE.Color(clayColor(2)),
      }),
    }),
    [],
  );
  useEffect(
    () => () => {
      lines.minor.dispose();
      lines.major.dispose();
    },
    [lines],
  );
  return (
    <group>
      <mesh
        geometry={groundPlaneGeometry()}
        material={clayMaterial(0)}
        scale={[grid.gridW, 1, grid.gridD]}
        receiveShadow
        onClick={onGround}
        onPointerMove={onGroundMove}
      />
      {/* a thin plinth so the site reads as a slab */}
      <mesh
        geometry={boxGeometry()}
        material={clayMaterial(2)}
        scale={[grid.gridW, 0.4, grid.gridD]}
        position={[0, -0.205, 0]}
        raycast={() => null}
      />
      <lineSegments
        geometry={lines.minor}
        material={mats.minor}
        raycast={() => null}
      />
      <lineSegments
        geometry={lines.major}
        material={mats.major}
        raycast={() => null}
      />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Camera rig: fit on mount, clamp pan to the site, track the view quadrant,
// and implement the overlay controls' API.
// ---------------------------------------------------------------------------

function CameraRig({
  snapshot,
  controls,
  onApi,
  onQuadrant,
}: {
  snapshot: TwinSnapshot;
  controls: React.MutableRefObject<OrbitControlsImpl | null>;
  onApi: (api: TwinCameraApi | null) => void;
  onQuadrant: (q: 0 | 1 | 2 | 3) => void;
}) {
  const { camera, size, invalidate } = useThree();
  const grid = snapshot.site;
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;
  const tween = useRef<gsap.core.Tween | null>(null);
  const fit = useCallback(
    () => fitZoom(grid, size.width, size.height),
    [grid, size.width, size.height],
  );

  /** Put the camera at (target, azimuth, zoom) — instantly or with a short ease. */
  const goTo = useCallback(
    (
      target: { x: number; z: number },
      azimuth: number,
      zoom: number,
      animate = true,
    ) => {
      const ctl = controls.current;
      const cam = camera as THREE.OrthographicCamera;
      const from = {
        x: ctl ? ctl.target.x : 0,
        z: ctl ? ctl.target.z : 0,
        az: ctl ? ctl.getAzimuthalAngle() : ISO_AZIMUTH,
        zoom: cam.zoom,
      };
      // shortest way round
      let toAz = azimuth;
      while (toAz - from.az > Math.PI) toAz -= 2 * Math.PI;
      while (toAz - from.az < -Math.PI) toAz += 2 * Math.PI;
      const apply = (s: typeof from) => {
        const t = { x: s.x, y: 0, z: s.z };
        const p = isoCameraPosition(t, DISTANCE, s.az, ISO_ELEVATION);
        cam.position.set(p.x, p.y, p.z);
        cam.zoom = s.zoom;
        cam.updateProjectionMatrix();
        if (ctl) {
          ctl.target.set(t.x, 0, t.z);
          ctl.update();
        } else {
          cam.lookAt(t.x, 0, t.z);
        }
        invalidate();
      };
      tween.current?.kill();
      const to = { x: target.x, z: target.z, az: toAz, zoom };
      if (!animate || prefersReducedMotion()) {
        apply(to);
        return;
      }
      const state = { ...from };
      tween.current = gsap.to(state, {
        ...to,
        duration: 0.6,
        ease: "power2.inOut",
        onUpdate: () => apply(state),
      });
    },
    [camera, controls, invalidate],
  );

  // Initial view: default isometric, whole site.
  const placed = useRef(false);
  useEffect(() => {
    if (placed.current || size.width === 0) return;
    placed.current = true;
    goTo({ x: 0, z: 0 }, ISO_AZIMUTH, fit(), false);
  }, [fit, goTo, size.width]);

  // Clamp panning to the site and report the view quadrant.
  useEffect(() => {
    const ctl = controls.current;
    if (!ctl) return;
    let q = viewQuadrant(ctl.getAzimuthalAngle());
    onQuadrant(q);
    const hw = grid.gridW / 2;
    const hd = grid.gridD / 2;
    const onChange = () => {
      const t = ctl.target;
      const cx = Math.max(-hw, Math.min(hw, t.x));
      const cz = Math.max(-hd, Math.min(hd, t.z));
      if (cx !== t.x || cz !== t.z || t.y !== 0) {
        const dx = cx - t.x;
        const dy = -t.y;
        const dz = cz - t.z;
        t.set(cx, 0, cz);
        camera.position.x += dx;
        camera.position.y += dy;
        camera.position.z += dz;
      }
      const nq = viewQuadrant(ctl.getAzimuthalAngle());
      if (nq !== q) {
        q = nq;
        onQuadrant(nq);
      }
    };
    ctl.addEventListener("change", onChange);
    return () => ctl.removeEventListener("change", onChange);
  }, [controls, camera, grid.gridW, grid.gridD, onQuadrant]);

  useEffect(() => {
    const ctl = () => controls.current;
    const api: TwinCameraApi = {
      zoomBy: (f) => {
        const cam = camera as THREE.OrthographicCamera;
        const c = ctl();
        const z = Math.max(
          c?.minZoom ?? 1,
          Math.min(c?.maxZoom ?? 400, cam.zoom * f),
        );
        goTo(
          { x: c?.target.x ?? 0, z: c?.target.z ?? 0 },
          c?.getAzimuthalAngle() ?? ISO_AZIMUTH,
          z,
        );
      },
      rotate90: () => {
        const c = ctl();
        goTo(
          { x: c?.target.x ?? 0, z: c?.target.z ?? 0 },
          (c?.getAzimuthalAngle() ?? ISO_AZIMUTH) - Math.PI / 2,
          (camera as THREE.OrthographicCamera).zoom,
        );
      },
      reset: () => goTo({ x: 0, z: 0 }, ISO_AZIMUTH, fit()),
      home: () =>
        goTo({ x: 0, z: 0 }, ctl()?.getAzimuthalAngle() ?? ISO_AZIMUTH, fit()),
      flyTo: (id) => {
        const o = snapRef.current.objects.find((x) => x.id === id);
        if (!o) return;
        const c =
          o.state.kind === "equipment"
            ? cellToWorld(o.state.position.x, o.state.position.z, grid)
            : footprintCenter(o.footprint, grid);
        const cam = camera as THREE.OrthographicCamera;
        goTo(
          c,
          ctl()?.getAzimuthalAngle() ?? ISO_AZIMUTH,
          Math.max(cam.zoom, fit() * 2.2),
        );
      },
    };
    onApi(api);
    return () => onApi(null);
  }, [camera, controls, fit, goTo, grid, onApi]);

  useEffect(() => () => void tween.current?.kill(), []);
  return null;
}

// ---------------------------------------------------------------------------
// Placement ghost (edit mode)
// ---------------------------------------------------------------------------

function Ghost({
  cell,
  size,
  grid,
}: {
  cell: { x: number; z: number };
  size: { w: number; d: number };
  grid: SiteGrid;
}) {
  const c = cellToWorld(cell.x + size.w / 2, cell.z + size.d / 2, grid);
  const mat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(clayColor(4)),
        transparent: true,
        opacity: 0.35,
      }),
    [],
  );
  return (
    <mesh
      geometry={boxGeometry()}
      material={mat}
      scale={[size.w, 0.3, size.d]}
      position={[c.x, 0.15, c.z]}
      raycast={() => null}
    />
  );
}

// ---------------------------------------------------------------------------
// The canvas
// ---------------------------------------------------------------------------

export function TwinCanvas(props: TwinCanvasProps) {
  const {
    snapshot,
    selectedId,
    hoverId,
    editing,
    placing,
    onSelect,
    onHover,
    onMove,
    onPlace,
    onApi,
    onReady,
    onFail,
  } = props;
  const grid = useMemo(
    () => ({ gridW: snapshot.site.gridW, gridD: snapshot.site.gridD }),
    [snapshot.site.gridW, snapshot.site.gridD],
  );
  const controls = useRef<OrbitControlsImpl | null>(null);
  const [quadrant, setQuadrant] = useState<0 | 1 | 2 | 3>(0);
  const [ghost, setGhost] = useState<{ x: number; z: number } | null>(null);
  const agents = useMemo(() => agentsByObject(snapshot), [snapshot]);
  const markerNodes = useRef(new Map<string, HTMLElement>());
  const marked = useMemo(
    () => snapshot.objects.filter((o) => agents.has(o.id) || o.alert),
    [snapshot.objects, agents],
  );
  const focusedId = hoverId ?? selectedId;
  const focus = useMemo(
    () =>
      focusedId
        ? (snapshot.objects.find((o) => o.id === focusedId) ?? null)
        : null,
    [focusedId, snapshot.objects],
  );
  const anchors = useMemo<MarkerAnchor[]>(() => {
    const out: MarkerAnchor[] = marked.map((o) => ({
      key: `m:${o.id}`,
      ...markerAnchor(o, grid),
    }));
    if (focus) out.push({ key: "focus", ...markerAnchor(focus, grid) });
    return out;
  }, [marked, focus, grid]);
  // R3F forces a context loss when the canvas unmounts (view switch): that is
  // not a GPU failure, so the handler ignores it.
  const unmounting = useRef(false);
  useEffect(() => {
    unmounting.current = false;
    return () => {
      unmounting.current = true;
    };
  }, []);

  // Buildings that contain another object's centre are drawn cut-away.
  const hollowBuildings = useMemo(() => {
    const set = new Set<string>();
    for (const b of snapshot.objects) {
      if (b.kind !== "building") continue;
      const r = occupiedRect(b.footprint);
      const inside = snapshot.objects.some((o) => {
        if (o.id === b.id || o.kind === "building") return false;
        const c = occupiedRect(o.footprint);
        const cx = (c.x0 + c.x1) / 2;
        const cz = (c.z0 + c.z1) / 2;
        return cx > r.x0 && cx < r.x1 && cz > r.z0 && cz < r.z1;
      });
      if (inside) set.add(b.id);
    }
    return set;
  }, [snapshot.objects]);

  const ctx: SceneCtx = useMemo(
    () => ({
      grid,
      quadrant,
      selectedId,
      hoverId,
      editing,
      hollowBuildings,
      onSelect,
      onHover,
      onMove,
      controls,
    }),
    [
      grid,
      quadrant,
      selectedId,
      hoverId,
      editing,
      hollowBuildings,
      onSelect,
      onHover,
      onMove,
    ],
  );

  const fit0 =
    typeof window !== "undefined"
      ? fitZoom(grid, window.innerWidth * 0.7, 640)
      : 10;
  const start = isoCameraPosition({ x: 0, y: 0, z: 0 }, DISTANCE);
  const span = Math.max(grid.gridW, grid.gridD);

  const onGround = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.delta > 4) return;
    if (editing && placing) {
      const c = worldToCell(e.point.x, e.point.z, grid);
      onPlace(c);
      return;
    }
    onSelect(null);
  };
  const onGroundMove = (e: ThreeEvent<PointerEvent>) => {
    if (!(editing && placing)) {
      if (ghost) setGhost(null);
      return;
    }
    const c = worldToCell(e.point.x, e.point.z, grid);
    if (!ghost || ghost.x !== c.x || ghost.z !== c.z) setGhost(c);
  };

  return (
    <div className="relative h-full w-full">
      <Canvas
        orthographic
        frameloop="demand"
        shadows
        flat
        dpr={[1, 2]}
        camera={{
          position: [start.x, start.y, start.z],
          zoom: fit0,
          near: 1,
          far: 2000,
        }}
        gl={{
          antialias: true,
          alpha: true,
          powerPreference: "high-performance",
        }}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener(
            "webglcontextlost",
            () => {
              if (!unmounting.current)
                onFail("The 3D view lost its graphics context.");
            },
            { once: true },
          );
          requestAnimationFrame(() => onReady());
        }}
        onPointerMissed={() => !editing && onSelect(null)}
        aria-label={`${snapshot.site.name} — 3D view`}
        role="img"
      >
        <TwinSceneContext.Provider value={ctx}>
          <ambientLight intensity={1.7} />
          <directionalLight
            position={[span * 0.45, span * 0.9, span * 0.3]}
            intensity={1.9}
            castShadow
            shadow-mapSize={[2048, 2048]}
            shadow-camera-left={-span * 0.8}
            shadow-camera-right={span * 0.8}
            shadow-camera-top={span * 0.8}
            shadow-camera-bottom={-span * 0.8}
            shadow-camera-near={1}
            shadow-camera-far={span * 3}
            shadow-bias={-0.0004}
          />
          <directionalLight
            position={[-span, span * 0.6, -span * 0.4]}
            intensity={0.45}
          />
          <Ground grid={grid} onGround={onGround} onGroundMove={onGroundMove} />
          {snapshot.objects.map((o) => (
            <ObjectShell key={o.id} o={o} />
          ))}
          <MarkerProjector anchors={anchors} nodes={markerNodes} />
          {editing && placing && ghost && (
            <Ghost cell={ghost} size={placing} grid={grid} />
          )}
          <OrbitControls
            ref={controls}
            makeDefault
            enableDamping={false}
            screenSpacePanning={false}
            minPolarAngle={0.35}
            maxPolarAngle={1.3}
            minZoom={2}
            maxZoom={200}
            mouseButtons={{
              LEFT: THREE.MOUSE.PAN,
              MIDDLE: THREE.MOUSE.DOLLY,
              RIGHT: THREE.MOUSE.ROTATE,
            }}
            touches={{ ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE }}
          />
          <CameraRig
            snapshot={snapshot}
            controls={controls}
            onApi={onApi}
            onQuadrant={setQuadrant}
          />
        </TwinSceneContext.Provider>
      </Canvas>
      <MarkerLayer
        marked={marked}
        agents={agents}
        focus={focus}
        focusedId={focusedId}
        nodes={markerNodes}
        onSelect={onSelect}
      />
    </div>
  );
}

export default TwinCanvas;
