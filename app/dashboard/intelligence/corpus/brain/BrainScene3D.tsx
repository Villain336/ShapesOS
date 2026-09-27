// Marketr — Knowledge Brain: 3D luminous galaxy view.
//
// An Obsidian-graph-style knowledge galaxy in LIGHT space: the 48 corpus
// sources as luminous cluster cores, each source's chunks as tiny glowing
// sparkle nodes orbiting it (2,678 sparkles, all real manifest chunk counts,
// one instanced draw call). Pillar clusters sit at organic asymmetric
// centers; the largest source is a hero "solar system" with a dotted orbital
// ring + satellite sub-cluster; a deterministic subset trails wispy strands.
// Code-split (dynamic import, ssr:false) so the 3D bundle never touches the
// rest of the app.
//
// The surrounding chrome (toolbar, health strip, dossier, sources table,
// activity feed, dialogs) stays in the locked light design system; only this
// viewport changed.

"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Billboard } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { Loader2, Play, X } from "lucide-react";
import {
  layoutGalaxy3D,
  layoutChunkSparkles,
  GALAXY_RADIUS,
  PILLAR_CLUSTER_CENTER,
  type GalaxyCore,
  type ChunkSparkle,
} from "@/lib/intelligence/corpus/brain3d-layout";
import type { BrainGraph, BrainNode, BrainPillar } from "@/lib/intelligence/corpus/graph";
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

// ── Soft radial glow texture (white core → transparent; tinted per sprite) ──

let glowTex: THREE.Texture | null = null;
function getGlowTexture(): THREE.Texture {
  if (typeof document === "undefined") return null as unknown as THREE.Texture;
  if (!glowTex) {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(255,255,255,0.55)");
    g.addColorStop(0.6, "rgba(255,255,255,0.14)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    glowTex = new THREE.CanvasTexture(c);
  }
  return glowTex;
}

// ── Tier rings: thin luminous rings, billboarded to face the camera ─────────

function DashedRing({
  radius,
  color,
  dashSize,
  gapSize,
  opacity,
}: {
  radius: number;
  color: string;
  dashSize: number;
  gapSize: number;
  opacity: number;
}) {
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
  useEffect(
    () => () => {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    },
    [obj],
  );
  return <primitive object={obj} />;
}

function TierRings({ node, radius }: { node: BrainNode; radius: number }) {
  const color = PILLAR_COLORS[node.pillar];
  if (node.kind === "proposed" || node.kind === "catalog") {
    return <DashedRing radius={radius + 0.22} color="#a8a29e" dashSize={0.05} gapSize={0.08} opacity={0.9} />;
  }
  if (node.kind === "removal-flagged") {
    return <DashedRing radius={radius + 0.22} color="#dc2626" dashSize={0.12} gapSize={0.08} opacity={0.95} />;
  }
  if (node.tier === "1") {
    return (
      <mesh>
        <torusGeometry args={[radius + 0.16, 0.014, 8, 72]} />
        <meshBasicMaterial color={color} transparent opacity={0.85} />
      </mesh>
    );
  }
  if (node.tier === "1S") {
    return <DashedRing radius={radius + 0.18} color="#a8a29e" dashSize={0.12} gapSize={0.08} opacity={0.85} />;
  }
  return null;
}

// ── Luminous source core ───────────────────────────────────────────────────

const easeOutBack = (t: number) => {
  const c = 1.70158;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};

function SourceCore({
  node,
  core,
  dimmed,
  selected,
  hovered,
  birth,
  now,
  onHover,
  onSelect,
}: {
  node: BrainNode;
  core: GalaxyCore;
  dimmed: boolean;
  selected: boolean;
  hovered: boolean;
  birth: number;
  now: React.MutableRefObject<number>;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const haloIn = useRef<THREE.SpriteMaterial>(null);
  const haloOut = useRef<THREE.SpriteMaterial>(null);
  const color = PILLAR_COLORS[node.pillar];
  const r = core.radius;
  const targetScale = hovered || selected ? 1.22 : 1;

  useFrame((_, dt) => {
    const age = now.current - birth;
    const grow = age <= 0 ? 0.0001 : age >= 1 ? 1 : Math.max(0.0001, easeOutBack(age));
    if (group.current) {
      const s = THREE.MathUtils.damp(group.current.scale.x, targetScale * grow, 14, dt);
      group.current.scale.setScalar(Math.max(0.0001, s));
    }
    if (mat.current) {
      mat.current.opacity = THREE.MathUtils.damp(mat.current.opacity, dimmed ? 0.14 : 1, 10, dt);
    }
    if (haloIn.current) {
      haloIn.current.opacity = THREE.MathUtils.damp(
        haloIn.current.opacity,
        dimmed ? 0.05 : hovered || selected ? 0.9 : 0.65,
        10,
        dt,
      );
    }
    if (haloOut.current) {
      haloOut.current.opacity = THREE.MathUtils.damp(
        haloOut.current.opacity,
        dimmed ? 0.03 : hovered || selected ? 0.5 : 0.3,
        10,
        dt,
      );
    }
  });

  return (
    <group ref={group} position={[core.x, core.y, core.z]} scale={0.0001}>
      {/* Halo aura (tinted glow sprites read as luminous on light space) */}
      <sprite scale={[r * 5.2, r * 5.2, 1]}>
        <spriteMaterial
          ref={haloOut}
          map={getGlowTexture()}
          color={color}
          transparent
          opacity={0.3}
          depthWrite={false}
        />
      </sprite>
      <sprite scale={[r * 2.7, r * 2.7, 1]}>
        <spriteMaterial
          ref={haloIn}
          map={getGlowTexture()}
          color={color}
          transparent
          opacity={0.65}
          depthWrite={false}
        />
      </sprite>
      {/* Saturated luminous nucleus */}
      <mesh
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
        <sphereGeometry args={[r, 28, 20]} />
        <meshBasicMaterial ref={mat} color={color} transparent />
      </mesh>
      {!dimmed && (
        <Billboard>
          <TierRings node={node} radius={r} />
        </Billboard>
      )}
      {selected && !dimmed && (
        <Billboard>
          <mesh>
            <torusGeometry args={[r * 1.5 + 0.28, 0.02, 8, 72]} />
            <meshBasicMaterial color={color} transparent opacity={0.9} />
          </mesh>
        </Billboard>
      )}
    </group>
  );
}

// ── Chunk sparkles: one instanced draw call, custom glow shader ─────────────

const SPARKLE_VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute float aDim;
attribute float aBirth;
uniform float uScale;
uniform float uTime;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  float age = uTime - aBirth;
  float g = age <= 0.0 ? 0.0 : (age >= 1.0 ? 1.0 : 1.0 - pow(1.0 - age, 3.0));
  float pop = (age > 0.0 && age < 1.0) ? sin(age * 3.14159) * 0.3 : 0.0;
  float s = aSize * g * (1.0 + pop);
  vAlpha = mix(1.0, 0.08, aDim) * g;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = s * uScale / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const SPARKLE_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  if (d > 0.5) discard;
  float a = smoothstep(0.5, 0.04, d);
  // Bright nucleus fading into the saturated pillar color — luminous on white.
  vec3 col = mix(vColor, vec3(1.0), smoothstep(0.22, 0.0, d) * 0.55);
  gl_FragColor = vec4(col, a * vAlpha);
}
`;

function SparklePoints({
  sparkles,
  dimSet,
  now,
  seenRef,
}: {
  sparkles: ChunkSparkle[];
  dimSet: Set<string>;
  now: React.MutableRefObject<number>;
  seenRef: React.MutableRefObject<Set<string>>;
}) {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const geoRef = useRef<THREE.BufferGeometry>(null);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);

  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const n = sparkles.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const aSize = new Float32Array(n);
    const aDim = new Float32Array(n);
    const aBirth = new Float32Array(n);
    const c = new THREE.Color();
    const firstMount = seenRef.current.size === 0;
    const t = now.current;
    sparkles.forEach((s, i) => {
      pos[i * 3] = s.x;
      pos[i * 3 + 1] = s.y;
      pos[i * 3 + 2] = s.z;
      c.set(PILLAR_COLORS[s.pillar]);
      // Slight value jitter so the cloud shimmers instead of banding.
      const jitter = 0.92 + ((i * 7919) % 100) / 100 * 0.16;
      col[i * 3] = Math.min(1, c.r * jitter + 0.04);
      col[i * 3 + 1] = Math.min(1, c.g * jitter + 0.04);
      col[i * 3 + 2] = Math.min(1, c.b * jitter + 0.04);
      aSize[i] = s.size;
      aDim[i] = dimSet.has(s.sourceId) ? 1 : 0;
      // First mount: staggered bloom from the layout; later data refreshes:
      // existing sources are already grown, brand-new ones bloom now.
      aBirth[i] = firstMount ? s.birth : seenRef.current.has(s.sourceId) ? -100 : t;
    });
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(aSize, 1));
    g.setAttribute("aDim", new THREE.BufferAttribute(aDim, 1));
    g.setAttribute("aBirth", new THREE.BufferAttribute(aBirth, 1));
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sparkles]);

  useEffect(() => {
    const attr = geo.getAttribute("aDim") as THREE.BufferAttribute;
    sparkles.forEach((s, i) => attr.setX(i, dimSet.has(s.sourceId) ? 1 : 0));
    attr.needsUpdate = true;
  }, [dimSet, sparkles, geo]);

  useEffect(
    () => () => {
      geo.dispose();
    },
    [geo],
  );
  useEffect(() => {
    geoRef.current = geo;
  }, [geo]);

  const uniforms = useMemo(
    () => ({
      uScale: { value: 800 },
      uTime: { value: 0 },
    }),
    [],
  );

  useEffect(() => {
    const persp = camera as THREE.PerspectiveCamera;
    const hPx = size.height * dpr;
    uniforms.uScale.value = hPx / (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2)));
  }, [camera, size, dpr, uniforms]);

  useFrame(() => {
    if (matRef.current) matRef.current.uniforms.uTime.value = now.current;
  });

  return (
    <points geometry={geo} frustumCulled={false}>
      <shaderMaterial
        ref={matRef}
        vertexShader={SPARKLE_VERT}
        fragmentShader={SPARKLE_FRAG}
        uniforms={uniforms}
        transparent
        depthWrite={false}
      />
    </points>
  );
}

// ── Threads & edges ─────────────────────────────────────────────────────────

function ThreadLines({ sparkles, cores }: { sparkles: ChunkSparkle[]; cores: GalaxyCore[] }) {
  const obj = useMemo(() => {
    const byId = new Map(cores.map((c) => [c.id, c]));
    const n = sparkles.length;
    const pos = new Float32Array(n * 6);
    const col = new Float32Array(n * 6);
    const c = new THREE.Color();
    let w = 0;
    for (const s of sparkles) {
      const core = byId.get(s.sourceId);
      if (!core) continue;
      pos[w * 6] = core.x;
      pos[w * 6 + 1] = core.y;
      pos[w * 6 + 2] = core.z;
      pos[w * 6 + 3] = s.x;
      pos[w * 6 + 4] = s.y;
      pos[w * 6 + 5] = s.z;
      c.set(PILLAR_COLORS[s.pillar]);
      for (let k = 0; k < 2; k++) {
        col[w * 6 + k * 3] = c.r;
        col[w * 6 + k * 3 + 1] = c.g;
        col[w * 6 + k * 3 + 2] = c.b;
      }
      w++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos.slice(0, w * 6), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col.slice(0, w * 6), 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.09,
      depthWrite: false,
    });
    return new THREE.LineSegments(geo, mat);
  }, [sparkles, cores]);
  useEffect(
    () => () => {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    },
    [obj],
  );
  return <primitive object={obj} />;
}

function EdgeLines({
  graph,
  byId,
  dimSet,
}: {
  graph: BrainGraph;
  byId: Map<string, GalaxyCore>;
  dimSet: Set<string>;
}) {
  const items = useMemo(() => {
    const mat = new THREE.LineBasicMaterial({ color: "#a8a29e", transparent: true, opacity: 0.4 });
    return graph.edges.flatMap((e) => {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) return [];
      const va = new THREE.Vector3(a.x, a.y, a.z);
      const vb = new THREE.Vector3(b.x, b.y, b.z);
      const dir = vb.clone().sub(va);
      const len = dir.length() || 1;
      const up = Math.abs(dir.y / len) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const normal = new THREE.Vector3().crossVectors(dir, up).normalize();
      const ctrl = va.clone().add(vb).multiplyScalar(0.5).add(normal.multiplyScalar(Math.min(0.8, len * 0.18)));
      const curve = new THREE.QuadraticBezierCurve3(va, ctrl, vb);
      const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(24));
      const line = new THREE.Line(geo, mat);
      return [{ key: `${e.from}→${e.to}`, line, dimmed: dimSet.has(e.from) || dimSet.has(e.to) }];
    });
  }, [graph, byId, dimSet]);
  useEffect(
    () => () => {
      for (const it of items) it.line.geometry.dispose();
    },
    [items],
  );
  return (
    <>
      {items.map((it) => (
        <primitive key={it.key} object={it.line} visible={!it.dimmed} />
      ))}
    </>
  );
}

// ── Camera rig: cinematic intro, guided tour, search fly-to, idle drift ─────

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface TourLeg {
  target: THREE.Vector3;
  camPos: THREE.Vector3;
}

function Rig({
  controls,
  auto,
  fly,
  focusRequest,
  cores,
  tourCtl,
  onTouringChange,
}: {
  controls: React.RefObject<OrbitControlsImpl | null>;
  auto: React.MutableRefObject<boolean>;
  fly: React.MutableRefObject<{ active: boolean; target: THREE.Vector3; camPos: THREE.Vector3 }>;
  focusRequest: FocusRequest | null;
  cores: GalaxyCore[];
  tourCtl: React.MutableRefObject<{ start: () => void; cancel: () => void } | null>;
  onTouringChange: (touring: boolean) => void;
}) {
  const { camera } = useThree();
  const lastFocus = useRef<number>(0);
  const intro = useRef({ active: false, t: 0, fromPos: new THREE.Vector3(), toPos: new THREE.Vector3(), fromTg: new THREE.Vector3(), toTg: new THREE.Vector3() });
  const tour = useRef({
    active: false,
    leg: 0,
    phase: "fly" as "fly" | "dwell",
    t: 0,
    legs: [] as TourLeg[],
    fromPos: new THREE.Vector3(),
    fromTg: new THREE.Vector3(),
  });
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hero = useMemo(() => cores.find((c) => c.hero) ?? cores[0], [cores]);

  // Cinematic intro: start inside the hero cluster, pull back to the full galaxy.
  useEffect(() => {
    const c = controls.current;
    if (!c || !hero) return;
    const hp = new THREE.Vector3(hero.x, hero.y, hero.z);
    intro.current.fromPos.copy(hp).add(new THREE.Vector3(1.6, 0.9, 2.0));
    intro.current.toPos.set(10.5, 6.2, 12.5);
    intro.current.fromTg.copy(hp);
    intro.current.toTg.set(0, -0.2, 0.4);
    camera.position.copy(intro.current.fromPos);
    c.target.copy(intro.current.fromTg);
    intro.current.active = true;
    intro.current.t = 0;
    c.autoRotate = false;
    auto.current = false;
  }, [camera, controls, hero, auto]);

  const cancelFlights = () => {
    intro.current.active = false;
    tour.current.active = false;
    fly.current.active = false;
    onTouringChange(false);
    const c = controls.current;
    if (c) {
      c.enabled = true;
      c.autoRotate = false;
    }
    auto.current = false;
  };

  const scheduleResume = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      auto.current = true;
      if (controls.current) controls.current.autoRotate = true;
    }, 4000);
  };

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const onStart = () => {
      cancelFlights();
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
    const onEnd = () => scheduleResume();
    c.addEventListener("start", onStart);
    c.addEventListener("end", onEnd);
    return () => {
      c.removeEventListener("start", onStart);
      c.removeEventListener("end", onEnd);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls]);

  // Cinematic tour: cluster to cluster, ending on the full-galaxy reveal.
  useEffect(() => {
    tourCtl.current = {
      start: () => {
        const c = controls.current;
        if (!c) return;
        const at = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
        const designC = PILLAR_CLUSTER_CENTER.design;
        const growthC = PILLAR_CLUSTER_CENTER.growth;
        const wispy = cores.find((x) => x.wispy && !x.hero);
        const hp = hero ? at(hero.x, hero.y, hero.z) : at(0, 0, 0);
        const legs: TourLeg[] = [
          { target: hp, camPos: hp.clone().add(at(2.4, 1.4, 2.8)) },
          { target: at(...designC), camPos: at(designC[0] + 4.5, designC[1] + 2.5, designC[2] + 5.5) },
          { target: at(...growthC), camPos: at(growthC[0] + 3.5, growthC[1] + 2, growthC[2] + 4.5) },
        ];
        if (wispy) {
          const wp = at(wispy.x, wispy.y, wispy.z);
          legs.push({ target: wp, camPos: wp.clone().add(at(2.0, 1.1, 2.4)) });
        }
        legs.push({ target: at(0, -0.2, 0.4), camPos: at(10.5, 6.2, 12.5) });
        tour.current = {
          active: true,
          leg: 0,
          phase: "fly",
          t: 0,
          legs,
          fromPos: camera.position.clone(),
          fromTg: c.target.clone(),
        };
        intro.current.active = false;
        fly.current.active = false;
        auto.current = false;
        c.autoRotate = false;
        c.enabled = false;
        onTouringChange(true);
      },
      cancel: () => {
        cancelFlights();
        scheduleResume();
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cores, hero, controls, tourCtl]);

  // Search / table-row fly-to.
  useEffect(() => {
    if (!focusRequest || focusRequest.nonce === lastFocus.current) return;
    lastFocus.current = focusRequest.nonce;
    const p = cores.find((c) => c.id === focusRequest.id);
    const c = controls.current;
    if (!p || !c) return;
    cancelFlights();
    const target = new THREE.Vector3(p.x, p.y, p.z);
    const dir = camera.position.clone().sub(c.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.4, 1);
    dir.normalize();
    const camPos = target.clone().add(dir.multiplyScalar(4.6)).add(new THREE.Vector3(0, 0.8, 0));
    fly.current = { active: true, target, camPos };
    c.enabled = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest, cores, controls, camera]);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    const it = intro.current;
    if (it.active) {
      it.t += dt;
      const k = easeInOutCubic(Math.min(1, it.t / 6.5));
      camera.position.lerpVectors(it.fromPos, it.toPos, k);
      c.target.lerpVectors(it.fromTg, it.toTg, k);
      if (it.t >= 6.5) {
        it.active = false;
        auto.current = true;
        c.autoRotate = true;
      }
    }
    const tr = tour.current;
    if (tr.active && tr.legs.length) {
      tr.t += dt;
      const leg = tr.legs[tr.leg];
      if (tr.phase === "fly") {
        const k = easeInOutCubic(Math.min(1, tr.t / 2.4));
        camera.position.lerpVectors(tr.fromPos, leg.camPos, k);
        c.target.lerpVectors(tr.fromTg, leg.target, k);
        if (tr.t >= 2.4) {
          tr.phase = "dwell";
          tr.t = 0;
        }
      } else {
        if (tr.t >= 1.2) {
          tr.leg += 1;
          tr.t = 0;
          if (tr.leg >= tr.legs.length) {
            tr.active = false;
            c.enabled = true;
            onTouringChange(false);
            scheduleResume();
          } else {
            tr.phase = "fly";
            tr.fromPos.copy(camera.position);
            tr.fromTg.copy(c.target);
          }
        }
      }
    }
    const f = fly.current;
    if (f.active) {
      const k = 1 - Math.exp(-4.5 * dt);
      c.target.lerp(f.target, k);
      camera.position.lerp(f.camPos, k);
      if (camera.position.distanceTo(f.camPos) < 0.06 && c.target.distanceTo(f.target) < 0.06) {
        f.active = false;
        c.enabled = true;
        auto.current = true;
        c.autoRotate = true;
      }
    }
    c.update();
  });
  return null;
}

// ── Scene ──────────────────────────────────────────────────────────────────

function Scene(
  props: BrainScene3DProps & {
    tourCtl: React.MutableRefObject<{ start: () => void; cancel: () => void } | null>;
    onTouringChange: (touring: boolean) => void;
  },
) {
  const { graph, nodeById, isDimmed, selectedId, hoverId, onHover, onSelect, focusRequest } = props;

  const cores = useMemo(
    () =>
      layoutGalaxy3D(
        graph.nodes.map((n) => ({ id: n.id, pillar: n.pillar, chunks: n.chunks, kind: n.kind, tier: n.tier })),
      ),
    [graph],
  );
  const sparkles = useMemo(
    () =>
      layoutChunkSparkles(
        graph.nodes.map((n) => ({ id: n.id, pillar: n.pillar, chunks: n.chunks, kind: n.kind, tier: n.tier })),
        cores,
      ),
    [graph, cores],
  );
  const byId = useMemo(() => new Map(cores.map((c) => [c.id, c])), [cores]);
  const dimSet = useMemo(
    () => new Set(graph.nodes.filter((n) => isDimmed(n)).map((n) => n.id)),
    [graph, isDimmed],
  );
  // Sparkles of dimmed sources are ghosted in-shader; their threads are
  // dropped from the line geometry (rebuilt only when the filter changes).
  const litSparkles = useMemo(() => sparkles.filter((s) => !dimSet.has(s.sourceId)), [sparkles, dimSet]);

  const controls = useRef<OrbitControlsImpl | null>(null);
  const auto = useRef(false);
  const fly = useRef({ active: false, target: new THREE.Vector3(), camPos: new THREE.Vector3() });
  const now = useRef(0);
  const seenRef = useRef<Set<string>>(new Set());
  const birthRef = useRef<Map<string, number>>(new Map());

  useFrame((state) => {
    now.current = state.clock.elapsedTime;
  });

  // Grow-in bookkeeping: brand-new source ids bloom; known ids are instant.
  const coreIds = useMemo(() => cores.map((c) => c.id).join(","), [cores]);
  useEffect(() => {
    const t = now.current;
    const seen = seenRef.current;
    const first = seen.size === 0;
    for (const c of cores) {
      if (!birthRef.current.has(c.id)) {
        // Stagger the initial bloom so the galaxy grows core-by-core.
        birthRef.current.set(c.id, first ? 0.5 + (cores.indexOf(c) % 12) * 0.12 : t);
      }
      seen.add(c.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coreIds]);

  useEffect(() => {
    document.body.style.cursor = hoverId ? "pointer" : "";
    return () => {
      document.body.style.cursor = "";
    };
  }, [hoverId]);

  return (
    <>
      {/* Light-space galaxy: no armature, no beads — pure knowledge graph */}
      <SparklePoints sparkles={sparkles} dimSet={dimSet} now={now} seenRef={seenRef} />
      <ThreadLines sparkles={litSparkles} cores={cores} />
      <EdgeLines graph={graph} byId={byId} dimSet={dimSet} />

      {cores.map((p) => {
        const node = nodeById.get(p.id);
        if (!node) return null;
        return (
          <SourceCore
            key={p.id}
            node={node}
            core={p}
            dimmed={dimSet.has(p.id)}
            selected={selectedId === p.id}
            hovered={hoverId === p.id}
            birth={birthRef.current.get(p.id) ?? 0}
            now={now}
            onHover={onHover}
            onSelect={onSelect}
          />
        );
      })}

      <Rig
        controls={controls}
        auto={auto}
        fly={fly}
        focusRequest={focusRequest}
        cores={cores}
        tourCtl={props.tourCtl}
        onTouringChange={props.onTouringChange}
      />

      <OrbitControls
        ref={controls}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        autoRotate={false}
        autoRotateSpeed={0.55}
        minDistance={1.6}
        maxDistance={34}
      />
    </>
  );
}

// ── Exported viewport ──────────────────────────────────────────────────────

export function BrainScene3D(props: BrainScene3DProps) {
  const { hoverId, nodeById, onSelect } = props;
  const hoverNode = hoverId ? nodeById.get(hoverId) : undefined;
  const tourCtl = useRef<{ start: () => void; cancel: () => void } | null>(null);
  const [touring, setTouring] = useState(false);
  const [introDone, setIntroDone] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setIntroDone(true), 7000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      className="relative min-h-[420px] flex-1 overflow-hidden rounded-lg border border-stone-200"
      style={{
        background: "radial-gradient(120% 90% at 50% 30%, #ffffff 0%, #FAFAF7 55%, #f1efeb 100%)",
      }}
    >
      <Suspense
        fallback={
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-[13px] text-stone-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Growing the brain…
          </div>
        }
      >
        <Canvas
          camera={{ position: [10.5, 6.2, 12.5], fov: 50 }}
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
          onPointerMissed={() => onSelect(null)}
        >
          <fog attach="fog" args={["#f1efeb", 18, 42]} />
          <Scene {...props} tourCtl={tourCtl} onTouringChange={setTouring} />
        </Canvas>
      </Suspense>

      {/* Light legend */}
      <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1.5 rounded-md border border-stone-200 bg-white/80 px-2.5 py-2 shadow-sm backdrop-blur">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-stone-700">
          <span className="inline-block h-2 w-2 rounded-full bg-violet-500 shadow-[0_0_6px_2px_rgba(124,58,237,0.45)]" /> Galaxy model
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-stone-500">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-violet-500" /> Core = source · size ∝ chunks
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-stone-500">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-500 shadow-[0_0_4px_1px_rgba(2,132,199,0.5)]" /> Sparkle = chunk
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-stone-500">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-dotted border-stone-400" /> Dotted ring = hero orbit
        </div>
      </div>

      {/* Cinematic tour */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
        <button
          type="button"
          onClick={() => (touring ? tourCtl.current?.cancel() : tourCtl.current?.start())}
          className="flex items-center gap-1.5 rounded-full bg-violet-600 px-4 py-2 text-[12px] font-medium text-white shadow-md hover:bg-violet-700"
        >
          {touring ? <X className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {touring ? "Skip tour" : "Cinematic tour"}
        </button>
      </div>

      {/* Hover card */}
      {hoverNode && (
        <div className="pointer-events-none absolute bottom-3 left-3 max-w-[280px] rounded-md border border-stone-200 bg-white/85 px-2.5 py-2 shadow-sm backdrop-blur">
          <div className="text-[12px] font-semibold text-stone-900">{hoverNode.title}</div>
          <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-stone-500">{hoverNode.teaches}</div>
        </div>
      )}

      {/* Controls hint */}
      <div className="pointer-events-none absolute bottom-3 right-3 rounded-md border border-stone-200 bg-white/80 px-2 py-1 text-[10px] tracking-wide text-stone-500 shadow-sm backdrop-blur">
        {!introDone ? "opening flight — click anywhere to take over" : "drag to rotate · scroll to zoom · click a core"}
      </div>
    </div>
  );
}
