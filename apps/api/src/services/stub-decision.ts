import { LaneSchema, type Cart, type Lane, type Verdict } from "@auxo/shared";

import { createPolicyVerdict } from "./policy-engine.js";

const LANES = LaneSchema.options;

// The lane comes from the last hex digit of cart_hash, so each lane can be
// reproduced on purpose while testing.
export function stubLane(cart: Cart): Lane {
  const normalizedHash = cart.cart_hash.replace(/^sha256:/i, "");
  const finalNibble = Number.parseInt(normalizedHash[normalizedHash.length - 1] ?? "0", 16);
  return LANES[finalNibble % LANES.length] ?? "L1";
}

export function createStubVerdict(cart: Cart, decisionId: string): Verdict {
  return createPolicyVerdict(decisionId, stubLane(cart));
}
