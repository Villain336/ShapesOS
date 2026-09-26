// Marketr — Knowledge Brain: 3D immersive view.
//
// A dark, futuristic "agent brain": the 48 corpus sources as glowing neurons
// arranged in two hemispheres, tier rings, curved synapse edges with pulses
// of light, bloom post-processing, particle dust, and a wireframe brain
// shell. Code-split (dynamic import, ssr:false) so the 3D bundle never
// touches the rest of the app.
//
// The surrounding chrome (toolbar, detail panel, dialogs) stays in the
// locked light design system; only this viewport is the dark showcase.

"use client";

import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Sparkles, Billboard } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { Loader2 } from "lucide-react";
import {
  layoutBrain3D,
  BRAIN_RX,
  BRAIN_RY,
  BRAIN_RZ,
  type Brain3DNode,
} from "@/lib/intelligence/corpus/brain3d-layout";
import type { BrainGraph, BrainNode } from "@/lib/intelligence/corpus/graph";
import { PILLAR_COLORS } from "./brain-ui";
import type { FocusRequest } from "./BrainCanvas2D";

export interface BrainScene3DProps {
  graph: BrainGraph;
  nodeById: Map<string, BrainNode>;
  isDimmed: (n: BrainNode) => boolean;
  selectedId: string | null;
  hoverId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
  focusRequest: FocusRequest | null;
}

// ── Tier rings ───────────────────────────────────────────────────────────────

function DashedRing({ radius, color, dashSize, gapSize, opacity }: { radius: number; color: string; dashSize: number; gapSize: number; opacity: number }) {
  const obj = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineDashedMaterial({ color, dashSize, gapSize, transparent: true, opacity });
    const line = new THREE.LineLoop(geo, mat);
    line.computeLineDistances();
    return line;
  }, [radius, color, dashSize, gapSize, opacity]);
  useEffect(() => () => {
    obj.geometry.dispose();
    (obj.material as THREE.Material).dispose();
  }, [obj ]);
  return <primitive object={obj} />;
}

function SolidRing({ radius, color, opacity, tube = 0.014 }: { radius: number; color: string; opacity: number; tube?: number }) {
  return (
    <mesh>
      <torusGeometry args={[radius, tube, 8, 72]} />
      <meshBasicMaterial color={color} transparent opacity={opacity} />
    </mesh>
  );
}

function TierRings({ node, p }: { node: BrainNode; p: Brain3DNode }) {
  const color = PILLAR_COLORS[node.pillar];
  const r = p.radius;
  let rings: React.ReactNode = null;
  if (node.kind === "proposed") {
    rings = <DashedRing radius={r + 0.16} color="#a8a29e" dashSize={0.03} gapSize={0.06} opacity={0.85} />;
  } else if (node.kind === "removal-flagged") {
    rings = <DashedRing radius={r + 0.16} color="#ef4444" dashSize={0.09} gapSize={0.06} opacity={0.95} />;
  } else if (node.tier === "1") {
    rings = (
      <>
        <SolidRing radius={r + 0.13} color="#fbbf24" opacity={0.95} />
        <SolidRing radius={r + 0.21} color="#fbbf24" opacity={0.5} tube={0.01} />
      </>
    );
  } else if (node.tier === "1S") {
    rings = <DashedRing radius={r + 0.16} color={color} dashSize={0.1} gapSize={0.07} opacity={0.9} />;
  }
  if (!rings) return null;
  return <Billboard position={[p.x, p.y, p.z]}>{rings}</Billboard>;
}

// ── Neuron ─────────────────────────────────────────────────────────────────

function Neuron({
  node,
  p,
  dimmed,
  selected,
  hovered,
  onHover,
  onSelect,
}: {
  node: BrainNode;
  p: Brain3DNode;
  dimmed: boolean;
  selected: boolean;
  hovered: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}) {
  const mesh = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  const core = useRef<THREE.MeshBasicMaterial>(null);
  const color = PILLAR_COLORS[node.pillar];
  const phase = useMemo(() => (p.x * 12.9898 + p.y * 78.233 + p.z * 37.719) % (Math.PI * 2), [p]);
  const targetScale = hovered || selected ? 1.45 : 1;

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    if (mesh.current) {
      const s = THREE.MathUtils.damp(mesh.current.scale.x, targetScale, 12, dt);
      mesh.current.scale.setScalar(s);
    }
    if (mat.current) {
      // Breathing glow — the brain shimmers.
      const breathe = Math.sin(t * 1.8 + phase) * 0.3;
      mat.current.emissiveIntensity = dimmed ? 0 : (hovered || selected ? 3.4 : 1.7 + breathe);
      mat.current.opacity = THREE.MathUtils.damp(mat.current.opacity, dimmed ? 0.07 : 1, 10, dt);
    }
    if (core.current) {
      core.current.opacity = THREE.MathUtils.damp(core.current.opacity, dimmed ? 0 : 0.95, 10, dt);
    }
  });

  return (
    <group position={[p.x, p.y, p.z]}>
      <mesh
        ref={mesh}
        onClick={(e) => {
          if (dimmed) return;
          e.stopPropagation();
          onSelect(node.id);
        }}
        onPointerOver={(e) => {
          if (dimmed) return;
          e.stopPropagation();
          onHover(node.id);
        }}
        onPointerOut={() => onHover(null)}
      >
        <sphereGeometry args={[p.radius, 28, 28]} />
        <meshStandardMaterial
          ref={mat}
          color="#0d0d16"
          emissive={color}
          emissiveIntensity={1.7}
          roughness={0.32}
          metalness={0.25}
          transparent
        />
        {/* Nucleus */}
        <mesh scale={0.42}>
          <sphereGeometry args={[p.radius, 20, 20]} />
          <meshBasicMaterial ref={core} color="#ffffff" transparent opacity={0.95} />
        </mesh>
      </mesh>
      {!dimmed && <TierRings node={node} p={{ ...p, x: 0, y: 0, z: 0 }} />}
      {selected && !dimmed && (
        <Billboard>
          <SolidRing radius={p.radius * 1.45 + 0.22} color="#e9d5ff" opacity={0.95} tube={0.018} />
        </Billboard>
      )}
    </group>
  );
}

// ── Edges + pulses ─────────────────────────────────────────────────────────

interface EdgeItem {
  key: string;
  curve: THREE.QuadraticBezierCurve3;
  line: THREE.Line;
  dimmed: boolean;
  phase: number;
  speed: number;
}

function useEdgeItems(
  graph: BrainGraph,
  byId: Map<string, Brain3DNode>,
  dimSet: Set<string>,
): EdgeItem[] {
  return useMemo(() => {
    const items: EdgeItem[] = [];
    const mat = new THREE.LineBasicMaterial({ color: "#8b5cf6", transparent: true, opacity: 0.34 });
    graph.edges.forEach((e, i) => {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) return;
      const va = new THREE.Vector3(a.x, a.y, a.z);
      const vb = new THREE.Vector3(b.x, b.y, b.z);
      const dir = vb.clone().sub(va);
      const len = dir.length() || 1;
      const up = Math.abs(dir.y / len) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const normal = new THREE.Vector3().crossVectors(dir, up).normalize();
      const ctrl = va.clone().add(vb).multiplyScalar(0.5).add(normal.multiplyScalar(Math.min(0.9, len * 0.22)));
      const curve = new THREE.QuadraticBezierCurve3(va, ctrl, vb);
      const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(36));
      const line = new THREE.Line(geo, mat);
      items.push({
        key: `${e.from}→${e.to}`,
        curve,
        line,
        dimmed: dimSet.has(e.from) || dimSet.has(e.to),
        phase: (i * 0.37) % 1,
        speed: 0.22 + (i % 3) * 0.07,
      });
    });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, byId, dimSet]);
}

function EdgePulses({ items }: { items: EdgeItem[] }) {
  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const g = group.current;
    if (!g) return;
    for (let i = 0; i < items.length; i++) {
      const m = g.children[i] as THREE.Mesh | undefined;
      if (!m) continue;
      const it = items[i];
      if (it.dimmed) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      const pt = it.curve.getPoint((t * it.speed + it.phase) % 1);
      m.position.copy(pt);
    }
  });
  return (
    <group ref={group}>
      {items.map((it) => (
        <mesh key={`pulse-${it.key}`} visible={false}>
          <sphereGeometry args={[0.06, 12, 12]} />
          <meshBasicMaterial color="#ede9fe" />
        </mesh>
      ))}
    </group>
  );
}

// ── Camera rig: auto-rotate, idle resume, search fly-to ─────────────────────

function Rig({
  controls,
  auto,
  fly,
  focusRequest,
  byId,
}: {
  controls: React.RefObject<OrbitControlsImpl | null>;
  auto: React.MutableRefObject<boolean>;
  fly: React.MutableRefObject<{ active: boolean; target: THREE.Vector3; camPos: THREE.Vector3 }>;
  focusRequest: FocusRequest | null;
  byId: Map<string, Brain3DNode>;
}) {
  const { camera } = useThree();
  const lastFocus = useRef<number>(0);

  useEffect(() => {
    if (!focusRequest || focusRequest.nonce === lastFocus.current) return;
    lastFocus.current = focusRequest.nonce;
    const p = byId.get(focusRequest.id);
    const c = controls.current;
    if (!p || !c) return;
    const target = new THREE.Vector3(p.x, p.y, p.z);
    const dir = camera.position.clone().sub(c.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.4, 1);
    dir.normalize();
    const camPos = target.clone().add(dir.multiplyScalar(4.4)).add(new THREE.Vector3(0, 0.7, 0));
    fly.current = { active: true, target, camPos };
    auto.current = false;
    c.autoRotate = false;
    c.enabled = false;
  }, [focusRequest, byId, controls, camera, auto, fly]);

  useFrame((_, dt) => {
    const c = controls.current;
    const f = fly.current;
    if (f.active && c) {
      const k = 1 - Math.exp(-4.5 * dt);
      c.target.lerp(f.target, k);
      camera.position.lerp(f.camPos, k);
      if (camera.position.distanceTo(f.camPos) < 0.06 && c.target.distanceTo(f.target) < 0.06) {
        f.active = false;
        c.enabled = true;
        // Resume the slow drift shortly after arriving.
        auto.current = true;
        c.autoRotate = true;
      }
    }
    c?.update();
  });
  return null;
}

function OrbitRing() {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.z += dt * 0.05;
  });
  return (
    <mesh ref={ref} rotation={[1.25, 0, 0.35]}>
      <torusGeometry args={[5.4, 0.008, 8, 128]} />
      <meshBasicMaterial color="#7c3aed" transparent opacity={0.28} />
    </mesh>
  );
}

// ── Scene ──────────────────────────────────────────────────────────────────

function Scene(props: BrainScene3DProps) {
  const { graph, nodeById, isDimmed, selectedId, hoverId, onHover, onSelect, focusRequest } = props;

  const placed = useMemo(
    () =>
      layoutBrain3D(
        graph.nodes.map((n) => ({ id: n.id, pillar: n.pillar, chunks: n.chunks, kind: n.kind })),
      ),
    [graph],
  );
  const byId = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed]);
  const dimSet = useMemo(
    () => new Set(graph.nodes.filter((n) => isDimmed(n)).map((n) => n.id)),
    [graph, isDimmed],
  );
  const edgeItems = useEdgeItems(graph, byId, dimSet);

  const group = useRef<THREE.Group | null>(null);
  const controls = useRef<OrbitControlsImpl | null>(null);
  const auto = useRef(true);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fly = useRef({ active: false, target: new THREE.Vector3(), camPos: new THREE.Vector3() });

  useEffect(() => {
    document.body.style.cursor = hoverId ? "pointer" : "";
    return () => {
      document.body.style.cursor = "";
    };
  }, [hoverId]);

  useEffect(
    () => () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    [],
  );

  const pauseAuto = () => {
    auto.current = false;
    fly.current.active = false;
    if (controls.current) {
      controls.current.autoRotate = false;
      controls.current.enabled = true;
    }
    if (idleTimer.current) clearTimeout(idleTimer.current);
  };
  const scheduleResume = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      auto.current = true;
      if (controls.current) controls.current.autoRotate = true;
    }, 4000);
  };

  return (
    <>
      <ambientLight intensity={0.55} />
      <pointLight position={[7, 5, 7]} intensity={260} color="#8b5cf6" />
      <pointLight position={[-7, -4, -5]} intensity={140} color="#0ea5e9" />
      <pointLight position={[0, 6, -6]} intensity={90} color="#db2777" />

      <group ref={group}>
        {/* Two wireframe hemisphere shells with a real longitudinal fissure */}
        {[-1, 1].map((s) => (
          <group key={s} position={[s * 0.32, 0, 0]}>
            <mesh scale={[BRAIN_RX * 1.02, BRAIN_RY * 1.02, BRAIN_RZ * 1.02]}>
              <sphereGeometry args={[1, 30, 22, s < 0 ? -Math.PI / 2 : Math.PI / 2, Math.PI]} />
              <meshBasicMaterial color="#7c3aed" wireframe transparent opacity={0.06} depthWrite={false} />
            </mesh>
            <mesh scale={[BRAIN_RX * 0.99, BRAIN_RY * 0.99, BRAIN_RZ * 0.99]}>
              <sphereGeometry args={[1, 30, 22, s < 0 ? -Math.PI / 2 : Math.PI / 2, Math.PI]} />
              <meshBasicMaterial
                color="#8b5cf6"
                transparent
                opacity={0.035}
                side={THREE.BackSide}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </mesh>
          </group>
        ))}

        {/* Synapse edges */}
        {edgeItems.map((it) => (
          <primitive key={it.key} object={it.line} visible={!it.dimmed} />
        ))}
        <EdgePulses items={edgeItems} />

        {/* Neurons */}
        {placed.map((p) => {
          const node = nodeById.get(p.id);
          if (!node) return null;
          return (
            <Neuron
              key={p.id}
              node={node}
              p={p}
              dimmed={dimSet.has(p.id)}
              selected={selectedId === p.id}
              hovered={hoverId === p.id}
              onHover={onHover}
              onSelect={onSelect}
            />
          );
        })}
        <OrbitRing />
      </group>

      <Rig controls={controls} auto={auto} fly={fly} focusRequest={focusRequest} byId={byId} />

      <OrbitControls
        ref={controls}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        autoRotate
        autoRotateSpeed={0.6}
        minDistance={4.5}
        maxDistance={24}
        onStart={pauseAuto}
        onEnd={scheduleResume}
      />
    </>
  );
}

// ── Exported viewport ──────────────────────────────────────────────────────

export function BrainScene3D(props: BrainScene3DProps) {
  const { hoverId, nodeById, onSelect } = props;
  const hoverNode = hoverId ? nodeById.get(hoverId) : undefined;

  return (
    <div
      className="relative min-h-[420px] flex-1 overflow-hidden rounded-lg border border-stone-800"
      style={{ background: "#06060a" }}
    >
      <Suspense
        fallback={
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-[13px] text-violet-300">
            <Loader2 className="h-4 w-4 animate-spin" /> Summoning the brain…
          </div>
        }
      >
        <Canvas
          camera={{ position: [1.1, 1.8, 9.0], fov: 50 }}
          dpr={[1, 2]}
          gl={{ antialias: true, powerPreference: "high-performance" }}
          onPointerMissed={() => onSelect(null)}
        >
          <color attach="background" args={["#06060a"]} />
          <fog attach="fog" args={["#06060a", 13, 26]} />
          <Scene {...props} />
          <Sparkles count={150} scale={[12, 8, 12]} size={2.6} speed={0.25} color="#a78bfa" opacity={0.55} />
          <EffectComposer>
            <Bloom mipmapBlur intensity={1.35} luminanceThreshold={0.12} luminanceSmoothing={0.25} />
            <Vignette eskil={false} offset={0.22} darkness={0.62} />
          </EffectComposer>
        </Canvas>
      </Suspense>

      {/* Dark legend */}
      <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1.5 rounded-md border border-white/10 bg-black/50 px-2.5 py-2 backdrop-blur">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-stone-200">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-violet-400" /> Live neural map
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-stone-400">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-[#fbbf24]" /> Tier 1 · official
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-stone-400">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-dashed border-violet-400" /> Tier 1S · synthesis
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-stone-400">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-violet-500" /> Size ∝ chunks
        </div>
      </div>

      {/* Hover card */}
      {hoverNode && (
        <div className="pointer-events-none absolute bottom-3 left-3 max-w-[280px] rounded-md border border-white/10 bg-black/60 px-2.5 py-2 backdrop-blur">
          <div className="text-[12px] font-semibold text-stone-100">{hoverNode.title}</div>
          <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-stone-400">{hoverNode.teaches}</div>
        </div>
      )}

      {/* Controls hint */}
      <div className="pointer-events-none absolute bottom-3 right-3 rounded-md border border-white/10 bg-black/50 px-2 py-1 text-[10px] tracking-wide text-stone-500 backdrop-blur">
        drag to rotate · scroll to zoom · click a neuron
      </div>
    </div>
  );
}
