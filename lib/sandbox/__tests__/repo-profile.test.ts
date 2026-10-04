// ShapesOS — Phase 8 (ship): repo profile detection fixtures (PURE).
// Run: npx tsx --test lib/sandbox/__tests__/repo-profile.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectRepoProfile, makeTargets } from "../repo-profile";

function detect(files: Record<string, string>, extraNames: string[] = []) {
  return detectRepoProfile([...Object.keys(files), ...extraNames], (n) => (n in files ? files[n]! : null));
}

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "x", scripts, ...extra });

describe("JavaScript / TypeScript", () => {
  it("pnpm from its lockfile; scripts become commands", () => {
    const p = detect({ "package.json": pkg({ test: "vitest", lint: "eslint .", build: "next build", typecheck: "tsc --noEmit" }), "pnpm-lock.yaml": "", "tsconfig.json": "{}" });
    assert.equal(p.packageManager, "pnpm");
    assert.equal(p.language, "typescript");
    assert.deepEqual(p.commands, {
      install: "pnpm install --frozen-lockfile",
      test: "pnpm test",
      lint: "pnpm run lint",
      build: "pnpm run build",
      typecheck: "pnpm run typecheck",
    });
    assert.deepEqual(p.detectedFrom, ["package.json", "pnpm-lock.yaml", "tsconfig.json"]);
  });

  it("npm with package-lock → npm ci; the npm init placeholder test is not a test", () => {
    const p = detect({ "package.json": pkg({ test: 'echo "Error: no test specified" && exit 1', build: "tsc" }), "package-lock.json": "{}" });
    assert.equal(p.packageManager, "npm");
    assert.equal(p.language, "javascript");
    assert.equal(p.commands.install, "npm ci");
    assert.equal(p.commands.test, undefined);
    assert.equal(p.commands.build, "npm run build");
  });

  it("yarn and bun lockfiles; packageManager field wins over lockfiles", () => {
    assert.equal(detect({ "package.json": pkg({ test: "jest" }), "yarn.lock": "" }).commands.test, "yarn test");
    assert.equal(detect({ "package.json": pkg({ test: "bun test" }) }, ["bun.lockb"]).commands.test, "bun run test");
    const p = detect({ "package.json": pkg({ lint: "x" }, { packageManager: "yarn@4.1.0" }), "pnpm-lock.yaml": "" });
    assert.equal(p.packageManager, "yarn");
    assert.equal(p.commands.lint, "yarn lint");
  });
});

describe("Python", () => {
  it("uv + pytest + ruff + mypy from pyproject", () => {
    const p = detect({
      "pyproject.toml": "[project]\nname='x'\n[tool.pytest.ini_options]\naddopts='-q'\n[tool.ruff]\nline-length=100\n[tool.mypy]\nstrict=true\n",
      "uv.lock": "",
    });
    assert.equal(p.packageManager, "uv");
    assert.equal(p.language, "python");
    assert.deepEqual(p.commands, { install: "uv sync", test: "uv run pytest", lint: "uv run ruff check .", typecheck: "uv run mypy ." });
  });

  it("poetry from [tool.poetry]; pip from requirements with pytest.ini", () => {
    assert.equal(detect({ "pyproject.toml": "[tool.poetry]\nname='x'\n[tool.poetry.group.dev.dependencies]\npytest='^8'\n" }).commands.test, "poetry run pytest");
    const pip = detect({ "requirements.txt": "flask\n", "requirements-dev.txt": "pytest\n", "pytest.ini": "[pytest]\n", ".flake8": "" });
    assert.equal(pip.packageManager, "pip");
    assert.equal(pip.commands.install, "pip install -r requirements.txt -r requirements-dev.txt");
    assert.equal(pip.commands.test, "python -m pytest");
    assert.equal(pip.commands.lint, "python -m flake8");
  });

  it("no pytest anywhere → no test command (never guessed)", () => {
    assert.equal(detect({ "requirements.txt": "flask\n" }).commands.test, undefined);
  });
});

describe("Go, Rust, Ruby, JVM and Makefile", () => {
  it("go.mod and Cargo.toml", () => {
    assert.deepEqual(detect({ "go.mod": "module x" }).commands, { install: "go mod download", test: "go test ./...", build: "go build ./...", lint: "go vet ./..." });
    assert.equal(detect({ "Cargo.toml": "[package]" }).commands.lint, "cargo clippy -- -D warnings");
  });

  it("Gemfile with spec/ → rspec; gradle wrapper; maven", () => {
    assert.equal(detect({ Gemfile: "" }, ["spec"]).commands.test, "bundle exec rspec");
    assert.equal(detect({ "build.gradle.kts": "" }, ["gradlew"]).commands.test, "./gradlew test");
    assert.equal(detect({ "pom.xml": "<project/>" }).commands.build, "mvn -B package -DskipTests");
  });

  it("Makefile targets fill gaps but never override package scripts", () => {
    assert.deepEqual([...makeTargets("test: deps\n\tgo test\nlint:\n\tx\nVAR := 1\n.PHONY: test\n")].sort(), [".PHONY", "lint", "test"]);
    const p = detect({ "package.json": pkg({ test: "vitest" }), Makefile: "test:\n\tmake-test\nlint:\n\tmake-lint\n" });
    assert.equal(p.commands.test, "npm test");
    assert.equal(p.commands.lint, "make lint");
    const bare = detect({ Makefile: "build:\n\tcc\ntest:\n\t./t\n" });
    assert.equal(bare.packageManager, null);
    assert.deepEqual(bare.commands, { test: "make test", build: "make build" });
  });

  it("an empty repository has no profile to speak of", () => {
    assert.deepEqual(detect({ "README.md": "hi" }), { packageManager: null, language: null, commands: {}, detectedFrom: [] });
  });
});
