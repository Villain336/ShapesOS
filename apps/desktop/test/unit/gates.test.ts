import { describe, expect, it, vi } from "vitest";
import { gateClick, gateVoice, parseVoiceAnswer, proposalHint, voiceCanApprove } from "../../src/shared/approval";
import type { ProposalEvent } from "../../src/shared/contract";
import { confirmDictation } from "../../src/shared/dictation";
import { DEFAULT_EXCLUSIONS, exclusionMessage, matchExclusion, normaliseExclusions, parseExclusion } from "../../src/shared/exclusions";
import { decideCap, parseAgentIntent } from "../../src/shared/intents";

const tier1: ProposalEvent = {
  type: "proposal",
  approvalId: "ap_1",
  tool: "invoices.draft",
  summary: "Draft an invoice for Acme, $200",
  tier: 1,
  destructive: false,
  voiceApprovable: true,
};
const tier3: ProposalEvent = { ...tier1, approvalId: "ap_3", tool: "payroll.run", tier: 3, voiceApprovable: false };

describe("approval gating", () => {
  it("parses short spoken answers only", () => {
    expect(parseVoiceAnswer("Yes.")).toBe("yes");
    expect(parseVoiceAnswer("uh yeah please")).toBe("yes");
    expect(parseVoiceAnswer("Go ahead")).toBe("yes");
    expect(parseVoiceAnswer("No")).toBe("no");
    expect(parseVoiceAnswer("cancel")).toBe("no");
    expect(parseVoiceAnswer("yes and then also email the whole team about it")).toBeNull();
    expect(parseVoiceAnswer("where is the approvals page")).toBeNull();
  });

  it("a voice yes approves a voice-approvable Tier 1 proposal", () => {
    expect(gateVoice(tier1, "yes")).toEqual({
      action: "send",
      request: { approvalId: "ap_1", decision: "approve", via: "voice" },
      say: "Approved.",
    });
  });

  it("a voice yes is IGNORED when voiceApprovable=false (Tier 3)", () => {
    const r = gateVoice(tier3, "yes");
    expect(r.action).toBe("ignore");
    expect(r.say).toBe("Click to approve; voice can't approve this.");
    expect(proposalHint(tier3)).toBe("Click to approve; voice can't approve this.");
  });

  it("is ignored for destructive or Tier 3 even if the server wrongly says voiceApprovable", () => {
    expect(voiceCanApprove({ tier: 3, destructive: false, voiceApprovable: true })).toBe(false);
    expect(voiceCanApprove({ tier: 0, destructive: true, voiceApprovable: true })).toBe(false);
    expect(gateVoice({ ...tier1, destructive: true }, "yes").action).toBe("ignore");
    expect(gateVoice({ ...tier1, tier: 3 }, "yes").action).toBe("ignore");
  });

  it("a voice no always rejects (safe), and a click is the only path for Tier 3", () => {
    expect(gateVoice(tier3, "no")).toMatchObject({ action: "send", request: { decision: "reject", via: "voice" } });
    expect(gateClick(tier3, "approve")).toEqual({ approvalId: "ap_3", decision: "approve", via: "click" });
  });
});

describe("exclusion list", () => {
  it("matches password managers by app name, exe and bundle id", () => {
    expect(matchExclusion({ name: "1Password" }, DEFAULT_EXCLUSIONS)?.kind).toBe("app");
    expect(matchExclusion({ name: "Anything", path: "C:\\Program Files\\Bitwarden\\Bitwarden.exe" }, DEFAULT_EXCLUSIONS)?.value).toBe("bitwarden");
    expect(matchExclusion({ name: "1Password 8", bundleId: "com.1password.1password" }, DEFAULT_EXCLUSIONS)?.kind).toBe("bundle");
  });

  it("matches banking by tab host (and subdomains) and by a title word", () => {
    expect(matchExclusion({ name: "Google Chrome", url: "https://secure.chase.com/web/auth" }, DEFAULT_EXCLUSIONS)?.value).toBe("chase.com");
    expect(matchExclusion({ name: "Safari", title: "Online Banking - Sign in" }, DEFAULT_EXCLUSIONS)?.kind).toBe("title");
    expect(matchExclusion({ name: "Safari", url: "https://notchase.com.evil.io" }, DEFAULT_EXCLUSIONS)).toBeNull();
    expect(matchExclusion({ name: "Safari", title: "Embankment walk" }, DEFAULT_EXCLUSIONS)).toBeNull();
  });

  it("lets ordinary apps through and honours an edited list", () => {
    expect(matchExclusion({ name: "Slack", title: "general" }, DEFAULT_EXCLUSIONS)).toBeNull();
    expect(matchExclusion({ name: "Slack" }, ["slack"])?.value).toBe("slack");
    expect(matchExclusion({ name: "1Password" }, [])).toBeNull();
  });

  it("parses, rejects and de-duplicates entries", () => {
    expect(parseExclusion("url: https://www.PayPal.com/x")).toEqual({ kind: "url", value: "www.paypal.com", raw: "url: https://www.PayPal.com/x" });
    expect(parseExclusion("url:not a host")).toBeNull();
    expect(parseExclusion("   ")).toBeNull();
    expect(normaliseExclusions(["Slack", "slack", " ", "title:Bank", "title:bank"])).toEqual(["Slack", "title:Bank"]);
  });

  it("says what happened", () => {
    const hit = matchExclusion({ name: "1Password" }, DEFAULT_EXCLUSIONS)!;
    expect(exclusionMessage({ name: "1Password" }, hit)).toBe("1Password is on your exclusion list, so nothing on screen was captured.");
  });
});

describe("dictation: preview → paste → clipboard restore (mocked)", () => {
  function ports(canPaste = true) {
    const saved = { formats: { "text/plain": "original", "text/html": "<b>original</b>" } };
    let clip = "original";
    const restore = vi.fn(async (s: typeof saved) => {
      clip = s.formats["text/plain"];
    });
    const paste = vi.fn(async () => undefined);
    return {
      restore,
      paste,
      get clip() {
        return clip;
      },
      p: {
        clipboard: {
          snapshot: async () => saved,
          restore,
          writeText: async (t: string) => void (clip = t),
          readText: async () => clip,
        },
        paste: { canPaste: () => canPaste, paste },
        sleep: async () => undefined,
        platform: "darwin",
      },
    };
  }

  it("pastes, then restores the original clipboard", async () => {
    const t = ports();
    const order: string[] = [];
    t.p.paste.paste = vi.fn(async () => void order.push(`paste with clipboard=${t.clip}`));
    const r = await confirmDictation("Hello Acme", t.p);
    expect(r).toEqual({ status: "pasted", say: "Pasted." });
    expect(order).toEqual(["paste with clipboard=Hello Acme"]);
    expect(t.restore).toHaveBeenCalledOnce();
    expect(t.clip).toBe("original");
  });

  it("without permission it copies and says so (no fake paste)", async () => {
    const t = ports(false);
    const r = await confirmDictation("Hello", t.p);
    expect(r).toEqual({ status: "copied", say: "Copied. Press ⌘V to paste." });
    expect(t.paste).not.toHaveBeenCalled();
    expect(t.clip).toBe("Hello");
  });

  it("does not clobber a clipboard someone changed mid-paste", async () => {
    const t = ports();
    t.p.paste.paste = vi.fn(async () => void (await t.p.clipboard.writeText("user copied something")));
    await confirmDictation("Hello", t.p);
    expect(t.restore).not.toHaveBeenCalled();
  });
});

describe("agent mode intent and the spend cap", () => {
  it("parses goal and cap", () => {
    expect(parseAgentIntent("ShapesOS, research our competitors in the background, max $3")).toEqual({
      goal: "research our competitors",
      maxUsd: 3,
    });
    expect(parseAgentIntent("agent: summarise last week's churn, up to 2.50 dollars")).toEqual({
      goal: "summarise last week's churn",
      maxUsd: 2.5,
    });
    expect(parseAgentIntent("do it in the background")).toEqual({ goal: "do it", maxUsd: null });
    expect(parseAgentIntent("where do I approve a pay run?")).toBeNull();
  });

  it("applies the default and the ceiling", () => {
    expect(decideCap(null, { defaultUsd: 1, ceilingUsd: 10 })).toMatchObject({ ok: true, maxUsd: 1 });
    expect(decideCap(3, { defaultUsd: 1, ceilingUsd: 10 })).toEqual({ ok: true, maxUsd: 3, note: null });
    expect(decideCap(50, { defaultUsd: 1, ceilingUsd: 10 })).toMatchObject({ ok: false });
    expect(decideCap(0, { defaultUsd: 1, ceilingUsd: 10 })).toMatchObject({ ok: false });
  });
});
