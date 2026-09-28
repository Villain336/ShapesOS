// Marketr — Knowledge Brain: hidden orb-14 "thinking" farm.
//
// Renders ONE orb-14 shader orb (state="thinking") to a small offscreen canvas.
// BrainScene3D samples that canvas as a THREE.CanvasTexture shared by all 48
// source-core sprites — one WebGPU context total instead of 48, and every orb
// churns with the same "actively thinking" plasma preset. Pillar identity is
// carried by the halo sprites, which stay per-pillar tinted.
//
// Baked-shader note: the official @shadercn/orb-14 registry files
// (components/orbs/orb-14/{index.tsx,meta.ts,gpu.ts}) are byte-identical to
// https://shadercn.run/r/orb-14.json, but gpu.ts defines its shader with
// TypeGPU `"use gpu"` functions, which need the unplugin-typegpu build
// transform — unavailable under Next.js 16's Turbopack build. Importing
// gpu.ts in the browser throws "Missing metadata for tgpu.fn function body"
// and crashes the page. The shader is fully static (all runtime variation
// flows through uniforms), so scripts/bake-orb14-shader.mjs resolves it once
// (esbuild + unplugin-typegpu) into components/orbs/orb-14/shader.baked.ts.
// This farm builds its OrbVariant on that baked WGSL string plus the
// registry's uniform struct / param defaults / thinking preset, copied here
// as pure data (no "use gpu" involved). The registry runtime
// (components/orbs/{canvas,rendere}.tsx, vgpu) is used unmodified.
//
// If WebGPU is unavailable, onSupport(false) fires and the scene falls back
// to the legacy luminous sphere nuclei.

"use client";

import { useEffect, useRef } from "react";
import { d } from "typegpu";
import { ShaderOrb } from "@/components/orbs/canvas";
import type { OrbVariant } from "@/components/orbs/renderer";
import { orb14ShaderBaked } from "@/components/orbs/orb-14/shader.baked";

export const ORB_FARM_PX = 256;

// Uniform struct copied from the registry's orb14Params (pure data — the
// struct is only used for byte layout via d.memoryLayoutOf).
const orb14ParamsBaked = d.struct({
  anim: d.f32,
  c_ink: d.vec3f,
  c_paper: d.vec3f,
  inputVol: d.f32,
  outputVol: d.f32,
  p_cells: d.f32,
  p_contrast: d.f32,
  p_gain: d.f32,
  p_levels: d.f32,
  p_light: d.f32,
  p_plasma: d.f32,
  p_radius: d.f32,
  p_rim: d.f32,
  p_scale: d.f32,
  p_speed: d.f32,
  p_spin: d.f32,
  res: d.vec2f,
  time: d.f32,
});

// OrbVariant assembled from the registry's meta.ts values (defaults, colors,
// thinking preset) with the baked WGSL in place of the runtime-resolved
// tgpu.resolve() string.
const orb14BakedVariant: OrbVariant = {
  colors: [
    { default: "#101426", key: "ink", label: "Ink" },
    { default: "#cfe6ff", key: "paper", label: "Paper" },
  ],
  key: "orb-14",
  label: "ORB-14",
  note: "a lit plasma dome quantized to chunky two-tone pixels",
  params: [
    { default: 0.5, integrate: true, key: "speed", label: "Wave speed", max: 10, min: 0.015, step: 0.05 },
    { default: 0.15, integrate: true, key: "spin", label: "Roll", max: 5, min: 0, step: 0.03 },
    { default: 0.9, key: "radius", label: "Radius", max: 3, min: 0.15, step: 0.015 },
    { default: 140, key: "cells", label: "Grid cells", max: 320, min: 32, step: 2 },
    { default: 3, key: "levels", label: "Tone steps", max: 8, min: 2, step: 1 },
    { default: 1.5, key: "scale", label: "Wave scale", max: 12, min: 0.3, step: 0.1 },
    { default: 0.9, key: "plasma", label: "Wave amount", max: 3, min: 0, step: 0.015 },
    { default: 0.9, key: "light", label: "Key light", max: 3, min: 0, step: 0.015 },
    { default: 0.35, key: "rim", label: "Rim light", max: 3, min: 0, step: 0.015 },
    { default: 1, key: "gain", label: "Brightness", max: 5, min: 0.05, step: 0.05 },
    { default: 1.1, key: "contrast", label: "Contrast", max: 10, min: 0.15, step: 0.05 },
  ],
  shader: orb14ShaderBaked,
  stateColors: {
    idle: { ink: "#101426", paper: "#cfe6ff" },
    speaking: { ink: "#2a1410", paper: "#ffd9a4" },
    thinking: { ink: "#140f38", paper: "#a9b9ff" },
  },
  // Thinking churns the plasma in place while the light freezes.
  statePresets: {
    idle: { contrast: 1.1, gain: 1, plasma: 0.9, speed: 0.5, spin: 0.15 },
    speaking: { contrast: 1.05, gain: 1.3, plasma: 1, speed: 1.3, spin: 0.8 },
    thinking: { contrast: 1.15, gain: 0.95, plasma: 1.15, speed: 1.6, spin: 0.05 },
  },
  uniforms: orb14ParamsBaked,
};

export function BrainOrbFarm({
  onCanvas,
  onSupport,
}: {
  onCanvas: (canvas: HTMLCanvasElement | null) => void;
  onSupport: (supported: boolean) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const nav = navigator as Navigator & {
      gpu?: { requestAdapter: () => Promise<unknown> };
    };
    if (!nav.gpu) {
      onSupport(false);
      return;
    }
    nav.gpu
      .requestAdapter()
      .then((adapter) => {
        if (!cancelled) onSupport(!!adapter);
      })
      .catch(() => {
        if (!cancelled) onSupport(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const canvas = wrapRef.current?.querySelector("canvas") ?? null;
    onCanvas(canvas);

    // Verify the orb actually paints: sample the canvas after the pipeline
    // has had time to compile and render. If it's blank (pipeline failed),
    // signal unsupported so the scene falls back to luminous spheres.
    // (Adapter availability alone isn't enough — SwiftShader can provide an
    // adapter but fail pipeline compilation.)
    let checkTimer: ReturnType<typeof setTimeout> | undefined;
    if (canvas) {
      checkTimer = setTimeout(() => {
        try {
          const probe = document.createElement("canvas");
          probe.width = 16;
          probe.height = 16;
          const ctx = probe.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(canvas, 0, 0, 16, 16);
            const data = ctx.getImageData(0, 0, 16, 16).data;
            let lit = 0;
            for (let i = 0; i < data.length; i += 4) {
              if (data[i] + data[i + 1] + data[i + 2] > 24) lit++;
            }
            // The thinking orb is bright (paper #a9b9ff on ink #140f38);
            // a blank/failed canvas stays near-black.
            onSupport(lit > 8);
          }
        } catch {
          onSupport(false);
        }
      }, 4000);
    }

    return () => {
      if (checkTimer) clearTimeout(checkTimer);
      onCanvas(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={wrapRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        left: -10000,
        top: 0,
        width: ORB_FARM_PX,
        height: ORB_FARM_PX,
        pointerEvents: "none",
        opacity: 0,
      }}
    >
      <ShaderOrb
        variant={orb14BakedVariant}
        state="thinking"
        size={ORB_FARM_PX}
        pauseOffscreen={false}
        maxDpr={1}
        ariaLabel="Thinking orb"
      />
    </div>
  );
}
