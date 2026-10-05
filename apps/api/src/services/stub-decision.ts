import type { Cart, Lane, Verdict, VerdictAction } from "@auxo/shared";

const LANES = ["L0", "L1", "L2", "L3", "L4"] as const satisfies readonly Lane[];

const LANE_POLICY: Record<
  Lane,
  { action: VerdictAction; cooldownSeconds: number; templateId: string }
> = {
  L0: { action: "allow", cooldownSeconds: 0, templateId: "l0-pass" },
  L1: { action: "allow", cooldownSeconds: 0, templateId: "l1-banner" },
  L2: { action: "pause", cooldownSeconds: 60, templateId: "l2-pause" },
  L3: { action: "block", cooldownSeconds: 300, templateId: "l3-block" },
  L4: { action: "block", cooldownSeconds: 900, templateId: "l4-block" },
};

// The lane comes from the last hex digit of cart_hash, so each lane can be
// reproduced on purpose while testing.
export function createStubVerdict(cart: Cart, decisionId: string): Verdict {
  const normalizedHash = cart.cart_hash.replace(/^sha256:/i, "");
  const finalNibble = Number.parseInt(normalizedHash.at(-1) ?? "0", 16);
  const lane = LANES[finalNibble % LANES.length] ?? "L1";
  const policy = LANE_POLICY[lane];

  return {
    decision_id: decisionId,
    lane,
    action: policy.action,
    template_id: policy.templateId,
    cooldown_seconds: policy.cooldownSeconds,
  };
}
