import { DecisionMomentSchema } from "@auxo/shared";
import { describe, expect, it } from "vitest";

import { describeMoment, partOfDay } from "./moment.js";

describe("describeMoment", () => {
  it("gives the local time, weekday, and part of day in the user's zone", () => {
    // 05:30 UTC on Saturday 2026-11-07 is 00:30 Saturday in New York (EST).
    const moment = describeMoment(new Date("2026-11-07T05:30:00.000Z"), "America/New_York");

    expect(moment).toEqual({ time_zone: "America/New_York", local_time: "00:30", weekday: "saturday", part_of_day: "night" });
    expect(DecisionMomentSchema.safeParse(moment).success).toBe(true);
  });

  it("crosses the date line: the same instant is already Sunday morning in Tokyo", () => {
    expect(describeMoment(new Date("2026-11-07T23:15:00.000Z"), "Asia/Tokyo")).toMatchObject({
      local_time: "08:15",
      weekday: "sunday",
      part_of_day: "morning",
    });
  });

  it("returns null for a zone the runtime can't use", () => {
    expect(describeMoment(new Date("2026-11-07T12:00:00.000Z"), "Mars/Olympus_Mons")).toBeNull();
  });
});

describe("partOfDay", () => {
  it.each([
    [0, "night"],
    [4, "night"],
    [5, "morning"],
    [11, "morning"],
    [12, "afternoon"],
    [16, "afternoon"],
    [17, "evening"],
    [23, "evening"],
  ] as const)("hour %i is %s", (hour, expected) => {
    expect(partOfDay(hour)).toBe(expected);
  });
});
