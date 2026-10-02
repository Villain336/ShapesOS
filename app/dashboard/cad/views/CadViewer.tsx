"use client";

// Marketr — CAD + Hardware slice 1: in-browser three.js model viewer.
// Renders STL and OBJ natively via three/examples/jsm loaders. STEP is
// NEVER rendered here: the parent shows the honest "conversion pending"
// panel instead (see STEP_PREVIEW_MESSAGE in lib/cad/types).

import { useEffect, useRef, useState } from "react";
import { Box, Loader2, RotateCcw, RefreshCw, Grid3x3 } from "lucide-react";
// Type-only: the runtime three.js module is loaded dynamically below (so the
// page shell stays light); this gives tsc the THREE namespace for annotations.
import type * as THREE from "three";
import type { CadFormat } from "@/lib/cad/types";

interface Props {
  /** URL serving the raw model bytes (tenant-scoped API route). */
  fileUrl: string;
  format: CadFormat;
  fileName: string;
  /** Compact mode for side-by-side diffs. */
  compact?: boolean;
}

type LoadState = "loading" | "ready" | "error";

export function CadViewer({ fileUrl, format, fileName, compact = false }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [wireframe, setWireframe] = useState(false);
  const [spin, setSpin] = useState(true);
  const controlsRef = useRef<{ setWireframe: (w: boolean) => void; reset: () => void } | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    const mount = mountRef.current;
    if (!mount) return;

    setState("loading");

    (async () => {
      const THREE = await import("three");
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
      const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
      const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
      if (cancelled || !mountRef.current) return;

      const width = mount.clientWidth || 640;
      const height = compact ? 320 : 480;

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(width, height);
      renderer.setClearColor(0xf3f3f1, 1);
      mount.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xf3f3f1);

      const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 100000);
      camera.position.set(3, 2.5, 4);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.autoRotate = spin;
      controls.autoRotateSpeed = 1.2;

      scene.add(new THREE.HemisphereLight(0xffffff, 0xd6d6d2, 1.1));
      const dir = new THREE.DirectionalLight(0xffffff, 1.6);
      dir.position.set(5, 8, 6);
      scene.add(dir);
      const fill = new THREE.DirectionalLight(0xffffff, 0.5);
      fill.position.set(-6, 3, -4);
      scene.add(fill);

      // Neutral grid floor — the model sits on canvas, grid is a measuring aid.
      const grid = new THREE.GridHelper(10, 10, 0xcfcfcb, 0xe2e2df);
      grid.position.y = -0.001;
      scene.add(grid);

      const material = new THREE.MeshStandardMaterial({
        color: 0x8a8a86,
        metalness: 0.25,
        roughness: 0.55,
        wireframe: false,
        side: THREE.DoubleSide,
      });

      let object: THREE.Object3D | null = null;
      try {
        const res = await fetch(fileUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (format === "stl") {
          const buffer = await res.arrayBuffer();
          const geometry = new STLLoader().parse(buffer);
          geometry.computeVertexNormals();
          object = new THREE.Mesh(geometry, material);
        } else {
          const text = await res.text();
          object = new OBJLoader().parse(text);
          object.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
              const mesh = child as THREE.Mesh;
              mesh.material = material;
              const g = mesh.geometry as THREE.BufferGeometry;
              if (!g.attributes.normal) g.computeVertexNormals();
            }
          });
        }
      } catch {
        if (!cancelled) setState("error");
        renderer.dispose();
        mount.removeChild(renderer.domElement);
        return;
      }

      // Center the model and frame it.
      const bbox = new THREE.Box3().setFromObject(object);
      const center = bbox.getCenter(new THREE.Vector3());
      const size = bbox.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 0.001);
      object.position.sub(center);
      grid.position.y = -size.y / 2 - 0.001;
      scene.add(object);

      const fitDist = (maxDim / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      camera.position.set(fitDist * 1.1, fitDist * 0.85, fitDist * 1.35);
      controls.target.set(0, 0, 0);
      controls.update();

      const home = {
        pos: camera.position.clone(),
        target: controls.target.clone(),
      };

      controlsRef.current = {
        setWireframe: (w: boolean) => {
          material.wireframe = w;
        },
        reset: () => {
          camera.position.copy(home.pos);
          controls.target.copy(home.target);
          controls.update();
        },
      };

      let raf = 0;
      const tick = () => {
        raf = requestAnimationFrame(tick);
        controls.update();
        renderer.render(scene, camera);
      };
      tick();

      const onResize = () => {
        if (!mountRef.current) return;
        const w = mountRef.current.clientWidth || 640;
        const h = compact ? 320 : 480;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      };
      window.addEventListener("resize", onResize);

      if (!cancelled) setState("ready");

      cleanupRef.current = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener("resize", onResize);
        controls.dispose();
        renderer.dispose();
        const mount = mountRef.current;
        if (mount && renderer.domElement.parentElement === mount) {
          mount.removeChild(renderer.domElement);
        }
        material.dispose();
        object.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.isMesh) (mesh.geometry as THREE.BufferGeometry).dispose();
        });
      };
    })().catch(() => {
      if (!cancelled) setState("error");
    });

    return () => {
      cancelled = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
      controlsRef.current = null;
    };
    // fileUrl/format identify the version; spin is read once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileUrl, format]);

  useEffect(() => {
    controlsRef.current?.setWireframe(wireframe);
  }, [wireframe]);

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-canvas">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-paper px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Box className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <span className="truncate font-mono text-xs text-muted">{fileName}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setWireframe((w) => !w)}
            aria-pressed={wireframe}
            title={wireframe ? "Solid view" : "Wireframe view"}
            className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-colors ${
              wireframe ? "bg-ink text-paper" : "bg-paper text-ink shadow-[inset_0_0_0_1.5px_var(--aos-ink)]"
            }`}
          >
            <Grid3x3 className="h-3.5 w-3.5" aria-hidden />
            Wireframe
          </button>
          <button
            type="button"
            onClick={() => setSpin((s) => !s)}
            aria-pressed={spin}
            title={spin ? "Stop rotation" : "Auto-rotate"}
            className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-colors ${
              spin ? "bg-ink text-paper" : "bg-paper text-ink shadow-[inset_0_0_0_1.5px_var(--aos-ink)]"
            }`}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Spin
          </button>
          <button
            type="button"
            onClick={() => controlsRef.current?.reset()}
            title="Reset view"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-paper text-ink shadow-[inset_0_0_0_1.5px_var(--aos-ink)]"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>
      <div className="relative">
        <div ref={mountRef} className="w-full" style={{ height: compact ? 320 : 480 }} />
        {state === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center bg-canvas">
            <div className="flex items-center gap-2 text-sm text-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Loading model…
            </div>
          </div>
        )}
        {state === "error" && (
          <div className="absolute inset-0 flex items-center justify-center bg-canvas p-6">
            <p className="max-w-sm text-center text-sm text-muted">
              Could not render this file in the browser. The stored original is
              intact — download it and open it in your CAD tool.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
