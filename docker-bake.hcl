# ShapesOS — release image builds (docker buildx bake; deploy PR).
# Used by .github/workflows/release.yml (docker/bake-action). Locally:
#   TAG=$(git rev-parse HEAD) docker buildx bake --print        # show the plan
#   TAG=dev docker buildx bake runner --load                     # one image
# Each target is a stage of the existing Dockerfile; the shared `deps` stage
# is built once. Plain `docker build` / `docker compose build` don't use this
# file and behave as before.

variable "REGISTRY" {
  default = "ghcr.io/villain336"
}
# The git commit sha: the deploy tag (immutable; Render rolls back by it).
variable "TAG" {
  default = "dev"
}
# "true" also moves :latest (what a fresh Render Blueprint pulls first).
variable "LATEST" {
  default = "false"
}
variable "GIT_COMMIT" {
  default = ""
}
# Baked into the runner bundle by `next build` (NEXT_PUBLIC_* are inlined).
variable "APP_URL" {
  default = ""
}
# "1" = the CI memory settings (next.config.ts: no Turbopack disk cache or
# source maps; the type check already ran in the ci workflow) so the build
# fits a standard 8 GB GitHub runner. "" keeps source maps (needs ~13 GB).
variable "LOW_MEMORY_BUILD" {
  default = "1"
}
# The repository the GHCR packages belong to (links access and visibility).
variable "SOURCE_URL" {
  default = "https://github.com/Villain336/ShapesOS"
}
# Registry layer cache. Not the GitHub Actions cache: runs started by
# workflow_run only get READ access to it, and it is capped at 10 GB per repo
# (https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).
variable "CACHE_REF" {
  default = "ghcr.io/villain336/shapesos-buildcache"
}

function "tags" {
  params = [name]
  result = equal(LATEST, "true") ? ["${REGISTRY}/shapesos-${name}:${TAG}", "${REGISTRY}/shapesos-${name}:latest"] : ["${REGISTRY}/shapesos-${name}:${TAG}"]
}

group "default" {
  targets = ["runner", "worker", "migrate", "backup"]
}

target "_common" {
  context    = "."
  dockerfile = "Dockerfile"
  # Render runs linux/amd64 images only (https://render.com/docs/deploying-an-image#image-requirements).
  platforms = ["linux/amd64"]
  # A plain image manifest (no attestation index) for the simplest pulls.
  attest = ["type=provenance,disabled=true", "type=sbom,disabled=true"]
  labels = {
    # Links each GHCR package to the repository (access and visibility).
    "org.opencontainers.image.source"   = SOURCE_URL
    "org.opencontainers.image.revision" = GIT_COMMIT
  }
}

target "runner" {
  inherits   = ["_common"]
  target     = "runner"
  tags       = tags("runner")
  cache-from = ["type=registry,ref=${CACHE_REF}:runner"]
  cache-to   = ["type=registry,ref=${CACHE_REF}:runner,mode=max,ignore-error=true"]
  args = {
    CI                   = LOW_MEMORY_BUILD
    SKIP_BUILD_TYPECHECK = LOW_MEMORY_BUILD
    NEXT_PUBLIC_APP_URL  = APP_URL
    MARKETR_GIT_COMMIT   = GIT_COMMIT
  }
}

target "worker" {
  inherits = ["_common"]
  target   = "worker"
  tags     = tags("worker")
  # The deps stage is the same as the runner's: reuse its cache.
  cache-from = ["type=registry,ref=${CACHE_REF}:runner", "type=registry,ref=${CACHE_REF}:worker"]
  cache-to   = ["type=registry,ref=${CACHE_REF}:worker,mode=min,ignore-error=true"]
}

target "migrate" {
  inherits   = ["_common"]
  target     = "migrate"
  tags       = tags("migrate")
  cache-from = ["type=registry,ref=${CACHE_REF}:runner", "type=registry,ref=${CACHE_REF}:migrate"]
  cache-to   = ["type=registry,ref=${CACHE_REF}:migrate,mode=min,ignore-error=true"]
}

target "backup" {
  inherits   = ["_common"]
  target     = "backup"
  tags       = tags("backup")
  cache-from = ["type=registry,ref=${CACHE_REF}:backup"]
  cache-to   = ["type=registry,ref=${CACHE_REF}:backup,mode=max,ignore-error=true"]
}
