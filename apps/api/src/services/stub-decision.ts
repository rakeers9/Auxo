import { createHash } from "node:crypto";

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

function deterministicUuid(cartHash: string, userId: string): string {
  const digest = createHash("sha256")
    .update(`auxo-stub:${userId}:${cartHash}`)
    .digest("hex");
  const variant = ((Number.parseInt(digest[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const value = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;

  return value;
}

export function createStubVerdict(cart: Cart, userId: string): Verdict {
  const normalizedHash = cart.cart_hash.replace(/^sha256:/i, "");
  const finalNibble = Number.parseInt(normalizedHash.at(-1) ?? "0", 16);
  const lane = LANES[finalNibble % LANES.length] ?? "L1";
  const policy = LANE_POLICY[lane];

  return {
    decision_id: deterministicUuid(normalizedHash, userId),
    lane,
    action: policy.action,
    template_id: policy.templateId,
    cooldown_seconds: policy.cooldownSeconds,
  };
}
