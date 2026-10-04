// ShapesOS — New task composer, pure parts.
// Run: npx tsx --test lib/aos/__tests__/composer.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TASK_MAX_CHARS,
  TASK_MAX_FILES,
  attachmentError,
  composeTaskMessage,
  composerAgents,
  formatBytes,
  isComposerAgentKey,
  pickTaskProject,
  taskPromptError,
} from "../composer";
import { LEAD_AGENT, SUB_AGENTS } from "../agents";

describe("composer agents", () => {
  it("lists the lead first, then every sub-agent", () => {
    const agents = composerAgents();
    assert.equal(agents[0]!.key, "lead");
    assert.equal(agents[0]!.name, LEAD_AGENT.name);
    assert.deepEqual(
      agents.slice(1).map((a) => a.key),
      Object.keys(SUB_AGENTS),
    );
  });

  it("accepts only known agent keys", () => {
    assert.equal(isComposerAgentKey("lead"), true);
    assert.equal(isComposerAgentKey("researcher"), true);
    assert.equal(isComposerAgentKey("admin"), false);
    assert.equal(isComposerAgentKey(undefined), false);
  });
});

describe("composeTaskMessage", () => {
  it("sends the lead the prompt as typed (trimmed)", () => {
    assert.equal(composeTaskMessage({ agent: "lead", prompt: "  Draft the brief  ", tools: [] }), "Draft the brief");
  });

  it("spells out a sub-agent hand-off and the chosen tools, in kit order", () => {
    const msg = composeTaskMessage({ agent: "researcher", prompt: "Compare Q3", tools: ["code", "web"] });
    assert.equal(msg, "Hand this task to the Researcher sub-agent.\n\nCompare Q3\n\nTools to use: Web search, Code runner.");
  });
});

describe("taskPromptError", () => {
  it("needs a prompt", () => {
    assert.equal(taskPromptError({ agent: "lead", prompt: "   ", tools: [] }), "Describe the task first.");
    assert.equal(taskPromptError({ agent: "lead", prompt: "ok", tools: [] }), null);
  });

  it("counts the whole message against the chat limit", () => {
    const prompt = "x".repeat(TASK_MAX_CHARS);
    assert.equal(taskPromptError({ agent: "lead", prompt, tools: [] }), null);
    const err = taskPromptError({ agent: "drafter", prompt, tools: [] });
    assert.match(err ?? "", /^Shorten the task by \d+ characters\.$/);
  });
});

describe("attachments", () => {
  it("caps count and size", () => {
    assert.equal(attachmentError({ name: "a.csv", size: 10 }, 0), null);
    assert.match(attachmentError({ name: "a.csv", size: 10 }, TASK_MAX_FILES) ?? "", /up to 10 files/);
    assert.match(attachmentError({ name: "big.mov", size: 26 * 1024 * 1024 }, 0) ?? "", /big\.mov is over the 25 MB limit/);
  });

  it("formats sizes like the kit chip", () => {
    assert.equal(formatBytes(312), "312 B");
    assert.equal(formatBytes(48 * 1024), "48 KB");
    assert.equal(formatBytes(1.25 * 1024 * 1024), "1.3 MB");
    assert.equal(formatBytes(24 * 1024 * 1024), "24 MB");
  });
});

describe("pickTaskProject", () => {
  const projects = [
    { id: "new", createdAt: "2026-09-02T00:00:00Z" },
    { id: "old", createdAt: "2026-01-02T00:00:00Z" },
  ];
  it("prefers the open project, else the oldest (the assistant's default)", () => {
    assert.equal(pickTaskProject(projects, "new")?.id, "new");
    assert.equal(pickTaskProject(projects, "missing")?.id, "old");
    assert.equal(pickTaskProject(projects)?.id, "old");
    assert.equal(pickTaskProject([], "x"), null);
  });
});
