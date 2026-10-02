"use client";

// Marketr — CAD + Hardware slice 1: in-browser three.js model viewer.
// Renders STL and OBJ natively via three/examples/jsm loaders. STEP is
// NEVER rendered here: the parent shows the honest "conversion pending"
// panel instead (see STEP_PREVIEW_MESSAGE in lib/cad/types).

import { useEffect, useRef, useState } from "react";
import { Box, Loader2, RotateCcw, RefreshCw, Grid3x3, MapPin } from "lucide-react";
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
  /** When provided, a "Place note" mode appears: clicking the model calls
   *  this with the picked 3D point (viewer/world coordinates). */
  onPointPicked?: (point: [number, number, number]) => void;
  /** Annotation markers rendered in the same world coordinates. */
  markers?: { id: string; point: [number, number, number] }[];
}

type LoadState = "loading" | "ready" | "error";

export function CadViewer({ fileUrl, format, fileName, compact = false, onPointPicked, markers = [] }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [wireframe, setWireframe] = useState(false);
  const [spin, setSpin] = useState(true);
  const [picking, setPicking] = useState(false);
  const controlsRef = useRef<{ setWireframe: (w: boolean) => void; reset: () => void } | null>(null);
  const sceneRef = useRef<{ camera: any; object: any; markerGroup: any; THREE: any; maxDim: number } | null>(null);
  const onPointPickedRef = useRef(onPointPicked);
  onPointPickedRef.current = onPointPicked;
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
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

      // Annotation markers (slice 2): small spheres in world coordinates.
      const markerGroup = new THREE.Group();
      scene.add(markerGroup);
      sceneRef.current = { camera, object, markerGroup, THREE, maxDim };

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
        sceneRef.current = null;
        const mount = mountRef.current;
        if (mount && renderer.domElement.parentElement === mount) {
          mount.removeChild(renderer.domElement);
        }
        material.dispose();
        object.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.isMesh) (mesh.geometry as THREE.BufferGeometry).dispose();
        });
        markerGroup.traverse((child: any) => {
          child.geometry?.dispose?.();
          child.material?.dispose?.();
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

  // Slice 2: click-to-place annotation picking. A drag is not a click —
  // only count presses that barely move, so orbiting never places a note.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !onPointPicked) return;
    let downX = 0;
    let downY = 0;
    const onDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      if (!pickingRef.current) return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
      const s = sceneRef.current;
      if (!s) return;
      const { camera, object, THREE } = s;
      const canvas = mount.querySelector("canvas");
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObject(object, true);
      if (hits.length > 0) {
        const p = hits[0].point;
        onPointPickedRef.current?.([
          Math.round(p.x * 1000) / 1000,
          Math.round(p.y * 1000) / 1000,
          Math.round(p.z * 1000) / 1000,
        ]);
      }
    };
    mount.addEventListener("pointerdown", onDown);
    mount.addEventListener("pointerup", onUp);
    return () => {
      mount.removeEventListener("pointerdown", onDown);
      mount.removeEventListener("pointerup", onUp);
    };
  }, [onPointPicked]);

  // Slice 2: render annotation markers in world coordinates.
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const { markerGroup, THREE, maxDim } = s;
    while (markerGroup.children.length > 0) {
      const child = markerGroup.children.pop();
      if (child) {
        child.geometry?.dispose();
        child.material?.dispose();
      }
    }
    const radius = Math.max((maxDim ?? 100) / 120, 1e-6);
    for (const m of markers) {
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0x111111 }),
      );
      sphere.position.set(m.point[0], m.point[1], m.point[2]);
      markerGroup.add(sphere);
    }
  }, [markers]);

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
          {onPointPicked && (
            <button
              type="button"
              onClick={() => setPicking((p) => !p)}
              aria-pressed={picking}
              title={picking ? "Cancel note placement" : "Click the model to place a note"}
              className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-colors ${
                picking ? "bg-ink text-paper" : "bg-paper text-ink shadow-[inset_0_0_0_1.5px_var(--aos-ink)]"
              }`}
            >
              <MapPin className="h-3.5 w-3.5" aria-hidden />
              {picking ? "Placing…" : "Place note"}
            </button>
          )}
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
        <div
          ref={mountRef}
          className="w-full"
          style={{ height: compact ? 320 : 480, cursor: picking ? "crosshair" : undefined }}
        />
        {picking && (
          <div className="absolute left-3 top-3 rounded-full bg-ink px-3 py-1.5 text-xs font-semibold text-paper">
            Click a point on the model to place the note
          </div>
        )}
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
