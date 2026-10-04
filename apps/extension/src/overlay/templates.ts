import type { Lane, Verdict } from "@auxo/shared";

// How a lane is shown. The kind sets the friction; the copy is just words.
export type OverlayKind = "none" | "banner" | "pause" | "block";

export interface OverlayTemplate {
  id: string;
  lane: Lane;
  kind: OverlayKind;
  title: string;
  body: string;
}

// One template per lane. The ids match what the API returns today
// (apps/api/src/services/policy-engine.ts and stub-decision.ts).
export const LANE_TEMPLATES: Record<Lane, OverlayTemplate> = {
  L0: { id: "l0-pass", lane: "L0", kind: "none", title: "", body: "" },
  L1: {
    id: "l1-banner",
    lane: "L1",
    kind: "banner",
    title: "Quick check",
    body: "Is this something you need, or something you want right now?",
  },
  L2: {
    id: "l2-pause",
    lane: "L2",
    kind: "pause",
    title: "Take a breath",
    body: "Give it a moment before you check out. If you still want it after the timer, go ahead.",
  },
  L3: {
    id: "l3-block",
    lane: "L3",
    kind: "block",
    title: "Hold on",
    body: "This cart goes against the limits you set. You can leave, save it for later, or continue once the timer runs out.",
  },
  L4: {
    id: "l4-block",
    lane: "L4",
    kind: "block",
    title: "Step back for a minute",
    body: "This is a big purchase by your own rules. Sleep on it, save it for later, or continue once the timer runs out.",
  },
};

const TEMPLATES_BY_ID = new Map<string, OverlayTemplate>(
  Object.values(LANE_TEMPLATES).map((template) => [template.id, template]),
);

// The lane decides the friction. A template_id is only honored when it belongs
// to the verdict's lane; anything unknown or mismatched falls back to the lane's
// template, so a bad id can never weaken (or strengthen) the overlay.
export function resolveTemplate(verdict: Pick<Verdict, "lane" | "template_id">): OverlayTemplate {
  const byId = TEMPLATES_BY_ID.get(verdict.template_id);
  if (byId && byId.lane === verdict.lane) return byId;
  return LANE_TEMPLATES[verdict.lane];
}
