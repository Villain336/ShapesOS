// Marketr — Phase 11 "Canvas": 3D → 2D sticker pre-render pipeline.
//
// Renders the curated CC0 3D model set (Kenney — CC0, no attribution
// required) to transparent PNGs at 3 preset camera angles, using headless
// three.js inside chromium (playwright). This is architecture (a) from the
// asset-API survey §7: curation-time pre-render, so the editor panel is a
// static gallery and NO 3D runtime ships to the browser.
//
// Why pre-render instead of on-demand server render (b):
//   - Zero WebGL/GPU surface in the Next server process.
//   - Render cost is paid once at curation time; panel inserts are plain
//     <img>/Konva image nodes (identical cost to stock photos).
//   - Deterministic output — every still is inspected before commit.
//
// Usage:
//   npx tsx scripts/render-3d-stills.mts [--force] [--only <model-id>] [--out <dir>]
//
// Re-runnable: a model is skipped when all 3 angle PNGs already exist in
// the output dir, unless --force. GLBs are downloaded from the official
// Kenney CDN into a temp cache dir (os.tmpdir) and are NOT committed —
// only the rendered PNGs under public/studio/3d-stills/ live in the repo.
//
// Requirements (dev-only, all already in node_modules): playwright,
// chromium_headless_shell, three, sharp.

import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, type Page } from "playwright";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

const REPO = "/home/hatch/workspace/marketr";
const RENDER_PX = 640;

/** One curated model: where to fetch the GLB + what to name the stills. */
interface RenderJob {
  /** Matches the manifest id in lib/design/polyhaven.ts. */
  id: string;
  /** Direct Kenney CDN ZIP (scraped from the pack page; re-check if 404). */
  zipUrl: string;
  /** GLB path inside the ZIP. */
  glbPath: string;
}

const JOBS: RenderJob[] = [
  { id: "kenney-chair", zipUrl: "https://kenney.nl/media/pages/assets/furniture-kit/440e0608a4-1677580847/kenney_furniture-kit.zip", glbPath: "Models/GLTF format/chair.glb" },
  { id: "kenney-sofa", zipUrl: "https://kenney.nl/media/pages/assets/furniture-kit/440e0608a4-1677580847/kenney_furniture-kit.zip", glbPath: "Models/GLTF format/loungeSofa.glb" },
  { id: "kenney-coffee-table", zipUrl: "https://kenney.nl/media/pages/assets/furniture-kit/440e0608a4-1677580847/kenney_furniture-kit.zip", glbPath: "Models/GLTF format/tableCoffee.glb" },
  { id: "kenney-floor-lamp", zipUrl: "https://kenney.nl/media/pages/assets/furniture-kit/440e0608a4-1677580847/kenney_furniture-kit.zip", glbPath: "Models/GLTF format/lampRoundFloor.glb" },
  { id: "kenney-potted-plant", zipUrl: "https://kenney.nl/media/pages/assets/furniture-kit/440e0608a4-1677580847/kenney_furniture-kit.zip", glbPath: "Models/GLTF format/pottedPlant.glb" },
  { id: "kenney-laptop", zipUrl: "https://kenney.nl/media/pages/assets/furniture-kit/440e0608a4-1677580847/kenney_furniture-kit.zip", glbPath: "Models/GLTF format/laptop.glb" },
  { id: "kenney-tree", zipUrl: "https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip", glbPath: "Models/GLTF format/tree_detailed.glb" },
  { id: "kenney-bush", zipUrl: "https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip", glbPath: "Models/GLTF format/plant_bushLarge.glb" },
  { id: "kenney-rock", zipUrl: "https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip", glbPath: "Models/GLTF format/rock_largeA.glb" },
  { id: "kenney-sedan", zipUrl: "https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip", glbPath: "Models/GLB format/sedan.glb" },
  { id: "kenney-truck", zipUrl: "https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip", glbPath: "Models/GLB format/truck.glb" },
  { id: "kenney-astronaut", zipUrl: "https://kenney.nl/media/pages/assets/space-kit/20874c75ac-1677698978/kenney_space-kit.zip", glbPath: "Models/GLTF format/astronautA.glb" },
  { id: "kenney-space-racer", zipUrl: "https://kenney.nl/media/pages/assets/space-kit/20874c75ac-1677698978/kenney_space-kit.zip", glbPath: "Models/GLTF format/craft_racer.glb" },
];

const ANGLES = [
  { key: "three-quarter", azDeg: 35, elDeg: 22 },
  { key: "front", azDeg: 0, elDeg: 10 },
  { key: "side", azDeg: 90, elDeg: 10 },
] as const;

type AngleKey = (typeof ANGLES)[number]["key"];

function args(argv: string[]) {
  const a = { force: false, only: null as string | null, out: join(REPO, "public/studio/3d-stills") };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--force") a.force = true;
    else if (argv[i] === "--only") a.only = argv[++i] ?? null;
    else if (argv[i] === "--out") a.out = resolve(argv[++i] ?? "");
  }
  return a;
}

const CACHE = join(tmpdir(), "marketr-3d-stills-cache");
mkdirSync(CACHE, { recursive: true });

async function downloadZip(url: string): Promise<string> {
  const name = url.split("/").pop() ?? "pack.zip";
  const dest = join(CACHE, name);
  if (existsSync(dest)) return dest;
  console.log(`  downloading ${name}…`);
  const res = await fetch(url, { headers: { "User-Agent": "Marketr-Studio/1.0 (CC0 asset curation)" } });
  if (!res.ok || !res.body) throw new Error(`ZIP download failed: HTTP ${res.status} for ${url}`);
  await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(dest));
  return dest;
}

async function extractGlb(zipPath: string, glbPath: string, outPath: string): Promise<void> {
  if (existsSync(outPath)) return;
  await execFileAsync("unzip", ["-o", "-j", zipPath, glbPath, "-d", CACHE]);
  const base = glbPath.split("/").pop() as string;
  const extracted = join(CACHE, base);
  if (!existsSync(extracted)) throw new Error(`GLB not found in ZIP: ${glbPath}`);
  writeFileSync(outPath, readFileSync(extracted));
}

/** Serves the repo's three.js over localhost so the headless page can import it. */
function startThreeServer(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      try {
        const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
        const p = join(REPO, "node_modules", rel);
        const data = readFileSync(p);
        res.writeHead(200, {
          "Content-Type": p.endsWith(".js") ? "text/javascript" : "application/octet-stream",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolvePromise({ server, baseUrl: `http://127.0.0.1:${port}/three` });
    });
  });
}

/** Renders one GLB at all 3 angles inside a single headless page. */
async function renderAngles(page: Page, glbB64: string): Promise<Record<AngleKey, string>> {
  return page.evaluate(
    ({ glbB64: b64, angles }: { glbB64: string; angles: ReadonlyArray<{ key: string; azDeg: number; elDeg: number }> }) => {
      return (window as unknown as { __renderAngles: (b: string, a: unknown) => Promise<Record<AngleKey, string>> })
        .__renderAngles(b64, angles);
    },
    { glbB64, angles: ANGLES },
  );
}

function pageHtml(threeBase: string): string {
  return `<!doctype html><html><body>
<script type="importmap">
{"imports":{"three":"${threeBase}/build/three.module.js","three/addons/":"${threeBase}/examples/jsm/"}}
</script>
<script type="module">
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const SIZE = ${RENDER_PX};
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(SIZE, SIZE);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x777788, 1.0));
const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(4, 7, 5);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
scene.add(key);
const fill = new THREE.DirectionalLight(0xdde6ff, 0.7);
fill.position.set(-5, 3, -2);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 0.9);
rim.position.set(0, 4, -6);
scene.add(rim);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.ShadowMaterial({ opacity: 0.22 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

function b64ToBuf(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

window.__renderAngles = async function (b64, angles) {
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.parse(b64ToBuf(b64), "", resolve, reject);
  });
  const obj = gltf.scene;
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(obj);
  const box = new THREE.Box3().setFromObject(obj);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = size.length() / 2;
  ground.position.y = box.min.y;

  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  key.target.position.copy(center);
  scene.add(key.target);
  key.shadow.camera.left = -radius * 2;
  key.shadow.camera.right = radius * 2;
  key.shadow.camera.top = radius * 2;
  key.shadow.camera.bottom = -radius * 2;
  key.shadow.camera.far = radius * 12;

  const dist = (radius / Math.sin(THREE.MathUtils.degToRad(35 / 2))) * 1.12;
  const out = {};
  for (const a of angles) {
    const az = THREE.MathUtils.degToRad(a.azDeg);
    const el = THREE.MathUtils.degToRad(a.elDeg);
    camera.position.set(
      center.x + dist * Math.cos(el) * Math.sin(az),
      center.y + dist * Math.sin(el),
      center.z + dist * Math.cos(el) * Math.cos(az)
    );
    camera.lookAt(center);
    renderer.render(scene, camera);
    out[a.key] = renderer.domElement.toDataURL("image/png");
  }
  return out;
};
window.__READY = true;
</script></body></html>`;
}

/** Compress to palette PNG and verify the render actually contains the model. */
async function savePng(dataUrl: string, outPath: string): Promise<number> {
  const raw = Buffer.from(dataUrl.split(",")[1], "base64");
  const { data, info } = await sharp(raw)
    .png({ compressionLevel: 9, palette: true, colors: 256 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let opaque = 0;
  for (let i = 3; i < data.length; i += info.channels) {
    if (data[i] > 8) opaque++;
  }
  const coverage = opaque / (info.width * info.height);
  if (coverage < 0.005) {
    throw new Error(`render looks empty (opaque coverage ${(coverage * 100).toFixed(2)}%) — check the GLB`);
  }
  const compressed = await sharp(raw).png({ compressionLevel: 9, palette: true, colors: 256 }).toBuffer();
  writeFileSync(outPath, compressed);
  return compressed.length;
}

async function main(): Promise<void> {
  const { force, only, out } = args(process.argv);
  mkdirSync(out, { recursive: true });
  const jobs = only ? JOBS.filter((j) => j.id === only) : JOBS;
  if (jobs.length === 0) throw new Error(`no jobs match --only ${only ?? ""}`);

  const { server, baseUrl } = await startThreeServer();
  const browser = await chromium.launch();
  try {
    for (const job of jobs) {
      const targets = ANGLES.map((a) => ({ angle: a.key as AngleKey, path: join(out, `${job.id}-${a.key}.png`) }));
      if (!force && targets.every((t) => existsSync(t.path))) {
        console.log(`skip ${job.id} (all stills exist; --force to re-render)`);
        continue;
      }
      console.log(`render ${job.id}`);
      const zipPath = await downloadZip(job.zipUrl);
      const glbCache = join(CACHE, `${job.id}.glb`);
      await extractGlb(zipPath, job.glbPath, glbCache);
      const glbB64 = readFileSync(glbCache).toString("base64");

      const page = await browser.newPage({ viewport: { width: RENDER_PX + 60, height: RENDER_PX + 60 } });
      page.on("pageerror", (e) => console.log(`  [page error] ${String(e).slice(0, 200)}`));
      await page.setContent(pageHtml(baseUrl), { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => (window as unknown as { __READY?: boolean }).__READY === true, {
        timeout: 60000,
      });
      const pngs = await renderAngles(page, glbB64);
      await page.close();

      for (const t of targets) {
        const dataUrl = pngs[t.angle];
        if (!dataUrl) throw new Error(`missing angle ${t.angle} for ${job.id}`);
        const bytes = await savePng(dataUrl, t.path);
        console.log(`  ${t.path.split("/").pop()} ${(bytes / 1024).toFixed(0)}KB`);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log("done");
}

main().catch((e) => {
  console.error(`render-3d-stills failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
