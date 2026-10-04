import { LaneSchema } from "@auxo/shared";
import { describe, expect, it } from "vitest";

import { LANE_TEMPLATES, resolveTemplate } from "./templates";

describe("overlay templates", () => {
  it("covers every lane with matching lane fields and unique ids", () => {
    const lanes = LaneSchema.options;
    expect(Object.keys(LANE_TEMPLATES).sort()).toEqual([...lanes].sort());
    for (const lane of lanes) expect(LANE_TEMPLATES[lane].lane).toBe(lane);
    const ids = Object.values(LANE_TEMPLATES).map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("maps lanes to the right friction", () => {
    expect(LANE_TEMPLATES.L0.kind).toBe("none");
    expect(LANE_TEMPLATES.L1.kind).toBe("banner");
    expect(LANE_TEMPLATES.L2.kind).toBe("pause");
    expect(LANE_TEMPLATES.L3.kind).toBe("block");
    expect(LANE_TEMPLATES.L4.kind).toBe("block");
  });

  it("every visible template has copy", () => {
    for (const t of Object.values(LANE_TEMPLATES)) {
      if (t.kind === "none") continue;
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.body.length).toBeGreaterThan(0);
    }
  });

  it("resolves a known template_id for its lane", () => {
    expect(resolveTemplate({ lane: "L2", template_id: "l2-pause" })).toBe(LANE_TEMPLATES.L2);
  });

  it("falls back to the lane's template for an unknown id", () => {
    expect(resolveTemplate({ lane: "L4", template_id: "nope" })).toBe(LANE_TEMPLATES.L4);
  });

  it("ignores a template_id from another lane so friction follows the lane", () => {
    expect(resolveTemplate({ lane: "L4", template_id: "l1-banner" })).toBe(LANE_TEMPLATES.L4);
    expect(resolveTemplate({ lane: "L1", template_id: "l4-block" })).toBe(LANE_TEMPLATES.L1);
  });
});
