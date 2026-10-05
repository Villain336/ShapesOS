# CAD + Hardware — Slice 1: CAD viewer + versioning

Spec: `docs/BUSINESS-OS-FEATURE-SPECS.md` §2. Reference customer: the autonomous
drone platform build (drone airframe revisions are the model use case).

## Slice 1 layout

- `types.ts` — `CadFormat` (stl/obj/step), `CadError`, validation (project /
  model / version / share-link inputs), share-token generation (`cadsl_` +
  128-bit hex), expiry policy (required, default 14d, cap 730d), and the
  **preview truth table**: `previewAvailableForFormat` is true for STL/OBJ,
  false for STEP — always.
- `geometry.ts` — pure mesh parsing (no three.js, no prisma, browser-safe):
  `sniffCadFormat` (format from BYTES, never the extension — a renamed file is
  rejected, not trusted), `parseMeshStats` for binary STL (size-equation
  check first — binary STLs may start with "solid"), ASCII STL, and OBJ
  (fan-triangulated quads/ngons). STEP returns null — no geometry is ever
  extracted from STEP. Stats: triangle count, bbox min/max, signed-tetrahedra
  mesh-volume estimate (exact for closed meshes only, labeled an estimate).
- `diff.ts` — pure `computeModelDiff`: triangle delta, per-axis size delta,
  bbox-center shift, volume from→to→delta. "computed" only when BOTH sides
  have real stats; otherwise availability "unavailable" and every numeric
  field null — the UI says "not computable", never a guess.
- `prisma-store.ts` — tenant-scoped `PrismaCadStore`. Projects → models →
  immutable versions (create-only rows; the model's `currentVersionId`
  pointer moves forward). Uploads go through the existing filesystem pipeline
  (`writeFile`: 25 MB cap, quota, audit) into `/files/cad/<project>/<model>/`
  with version-distinct filenames. Mesh formats bypass the generic MIME
  allow-list (`skipSafety`) because binary STL has no magic bytes — the
  byte-level signature check in `geometry.ts` is the validation gate instead
  (documented, not waved through). Auto-diff vs the previous version at
  publish time (best-effort; the UI can request any pair). Share links are
  fail-closed (`resolveShareToken`: unknown/revoked/expired → coded errors;
  the public surface 404s all three).
- `__tests__/cad-slice1.test.ts` — 36 tests, incl. anti-violation tests:
  STEP never claims a preview (type level + DB row), STEP↔mesh diffs are
  "unavailable", garbage uploads rejected atomically (no orphaned model row),
  share links fail closed on expired/revoked/unknown tokens, and tenant
  isolation across every path.

## Routes

- `GET/POST /api/cad/projects` — list / create (editor).
- `GET/PATCH/DELETE /api/cad/projects/[id]` — detail (+models) / edit / delete (editor).
- `GET/POST /api/cad/projects/[id]/models` — list / multipart upload (editor):
  `modelId?` = publish a NEW version of an existing model; omit = register a
  new model + version 1. Fields: `name?`, `description?`, `notes?`, `file`.
- `GET/DELETE /api/cad/models/[id]` — detail (model + versions + diffs + links) / delete (editor).
- `GET /api/cad/models/[id]/versions/[vid]/file` — original bytes for the
  viewer (`?dl=1` forces download; hardened headers).
- `GET/POST /api/cad/models/[id]/diffs` — recorded diffs / compute a pair (editor).
- `GET/POST /api/cad/share-links` — list (tokens never returned) / mint (editor; token returned ONCE).
- `POST /api/cad/share-links/[id]` — revoke (editor, idempotent).
  `DELETE …/[id]` — delete (editor).
- `GET /api/cad/public/[token]/file` — anonymous bytes behind a valid token (`?dl=1` download).
- `GET /r/cad/[token]` — public viewer page (fail-closed → 404).

## UI

- `/dashboard/cad` (`CadApp.tsx`) — project rail, model table, upload flow
  with an explicit confirm step ("Publish version": publishing is
  consequential — previous versions stay untouched), model detail tabs:
  Viewer / Versions / Compare / Share links.
- `views/CadViewer.tsx` — three.js viewer (STLLoader/OBJLoader from
  three/examples/jsm, OrbitControls, wireframe + spin toggles, reset view).
- `views/CompareTab.tsx` — side-by-side viewers + computed diff metadata.
- `views/ShareLinksTab.tsx` — link creation behind an explicit confirmation
  step (what the link exposes, who can open it, when it expires); token shown
  once with copy; revoke (confirm) / delete.
- STEP versions render the honest panel: "Preview unavailable for STEP —
  conversion pending" + download — never a faked render.

## Hard guardrails (never bend)

1. **STEP is never rendered.** No three.js STEP loader exists; slice 1 stores
   + versions STEP files and says so. (If a real conversion — e.g.
   OpenCASCADE wasm — is wired later, this panel is where it lands.)
2. **Diff numbers are computed or unavailable.** Triangle deltas, bbox deltas,
   and the volume estimate come from real parsed geometry; STEP sides mark
   the diff "unavailable".
3. **Share links fail closed.** Unknown / revoked / expired → 404 on the
   public surface, no distinction leaks.
4. **Tenant-scoped everywhere.** Every row carries `workspaceId`; every query
   filters on it.

## Slice 2 — AI design assistant (annotations, proposals, manufacturability)

- `geometry.ts` — `extractMeshTriangles` returns the raw triangle soup for
  STL/OBJ (mirrors the slice-1 parsers exactly); STEP returns null, always.
- `manufacturability.ts` — deterministic checks over real triangles:
  wall thickness (grid + DDA raycast estimate, bounded sample, honest
  confidence), overhangs (face normal vs +Z print axis at the 45° guideline;
  faces resting on the build plate are excluded), tolerance risks
  (sub-resolution edges, sub-slicing-floor dimensions). Every flag cites its
  measurement; checks that cannot run report "unavailable". Process limits
  keep source pointers in `MFG_REFERENCES`. Mesh units are labeled
  "mm (assumed — mesh files carry no unit metadata)".
- `design-proposals.ts` — deterministic NL parser: operation vocabulary,
  measurement normalization to mm, feature-label + rationale extraction,
  honest high/medium/low confidence. Proposals stay editable while draft.
- `ai-store.ts` — `PrismaCadAiStore extends PrismaCadStore` (parent's
  `prisma` is now `protected`): annotations (point/region/whole-model,
  immutable), proposals (draft → approved | rejected; approve/reject are
  human-only via `requireCadHuman`, agents get `AGENT_CANNOT_ACT`),
  manufacturability runs + flags, dismissal-with-reason audit trail.

**The proposal-execution boundary (v1):** the ONLY code path that sets
`CadModel.changeRequested` is `approveProposal`. No method anywhere rewrites
mesh geometry from a proposal — proposing + approving + tracking is the v1
contract. The tenant carries the edit out in their CAD tool and publishes a
new version, which clears the flag. STEP manufacturability records an
"unavailable" run — never invented numbers.

## Routes (slice 2)

- `GET/POST /api/cad/models/[id]/annotations` — list (?versionId=) / create (editor).
- `DELETE /api/cad/annotations/[id]` — delete (editor).
- `GET/POST /api/cad/models/[id]/proposals` — approval queue (?status=) / draft from NL (editor).
- `GET/PATCH /api/cad/proposals/[id]` — detail / fix the parse while draft (editor).
- `POST /api/cad/proposals/[id]/approve` — approve (editor; human-only; marks model change-requested).
- `POST /api/cad/proposals/[id]/reject` — reject (editor; human-only).
- `GET/POST /api/cad/models/[id]/versions/[vid]/manufacturability` — runs + flags / run analysis (editor).
- `POST /api/cad/flags/[id]/dismiss` — dismiss with required reason (editor).

## UI (slice 2)

`/dashboard/cad` model detail gains Notes (click-to-place markers in the
three.js viewer via `CadViewer`'s `onPointPicked` + `markers`, or whole-model
notes; annotation list panel), Changes (NL composer → parsed draft card for
review → approve/reject with confirmation, parse editor, change-requested
banner on the model), and Manufacturing (run analysis, findings with the
cited measurements, dismiss-with-reason, run history with per-check details
and process-limit source links). Agentic OS design system throughout.

## Phase 4b — derived BOM

`bom-derive.ts` (pure) + `PrismaCadPipelineStore.deriveBomFromGeometry`.

- **Parts** = bodies in the version's mesh: OBJ `o`/`g` groups and
  multi-solid ASCII STL blocks are named parts; otherwise triangles are split
  into connected shells (exact-position vertex welding). More than 500 shells
  is treated as a triangle soup → one body (with a warning).
- **Quantities**: identical bodies (triangle count, volume to 4 significant
  digits, sorted bbox size to 0.01 mm; for named groups also the same base
  name, e.g. `screw_1`/`screw_2`) collapse into one line. Unnamed shells are
  named by size (`Quad part 20 × 20 × 20 mm`), so a part keeps its name
  across revisions and the cross-version diff can match it.
- **Volume** only for closed bodies (every edge shared by exactly two
  non-degenerate triangles); open / non-manifold / zero-volume / non-finite
  bodies get `volumeMm3 = null` and the reason. NaN/Infinity triangles (and
  OBJ faces using a non-finite vertex) are dropped and counted. Inverted
  normals use the magnitude, flagged.
- **Mass** = volume × the density of a tenant-picked material
  (`bom-materials.ts`: typical handbook densities, each with its source; or
  a custom material + density). No material → no mass. **Cost** only when
  the tenant enters a raw-material $/kg (warning about double-counting with
  per-cm³ print rates). Fasteners/electronics stay manual lines.
- The stored bytes are re-hashed against the version's sha256 before
  deriving (`FILE_INTEGRITY` on mismatch); the BOM version records
  `origin: "derived"` and `derivation` (method + version, source file +
  checksum, unit assumption, material + density source, warnings).
  STEP / unreadable → `DERIVE_UNAVAILABLE` (422), nothing written.
- Derived lines (`source: derived:mesh_bodies`, `volumeMm3`, `massG`,
  `measurement`) can't be typed in by hand (`DERIVED_LINE_NOT_MANUAL`); their
  quantity is locked (`DERIVED_QTY_IMMUTABLE`), name/supplier/cost stay
  editable.
- Rollups: `computeBomRollup` carries mass totals; `compareBomRollups` diffs
  two BOMs by part + material; `getBomHistory` lists every BOM of a model by
  model version with the change vs the previous one.
- CSV: `bomCsvRows` + `lib/csv.ts` (formula-injection-safe), unknowns empty.
- Routes: `POST /api/cad/models/[id]/bom/derive` (editor; emits
  `cad.bom_derived`), `GET /api/cad/models/[id]/bom/history`,
  `GET /api/cad/bom/compare?from=&to=`, `GET /api/cad/bom/[id]/export` (CSV).
- UI: Prototype tab → Bill of materials: "Derive from geometry" (material,
  custom density, $/kg), volume/mass columns, derivation notes, Export CSV,
  "Across revisions" history + part compare. Record search kind `bom_line`
  deep-links to `/dashboard/cad?project=…&model=…&tab=prototype`.
- Tests: `bom-derive.test.ts` (unit), `cad-derived-bom-db.test.ts` (DB).
