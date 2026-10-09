import { expect, it } from "vitest";
import { createClickGate } from "./gate";
it("blocks again after the backend pass expires", () => {
  const verdict = { decision_id: "id", lane: "L3" as const, action: "block" as const, template_id: "l3-block", cooldown_seconds: 0 };
  const gate = createClickGate({ alwaysOn: false, devVerdict: verdict });
  gate.setVerdict(verdict);
  gate.override("id", Date.now() - 1);
  expect(gate.check({ intent: "checkout", source: "known" })).toMatchObject({ block: true });
});
