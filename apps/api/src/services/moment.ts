import type { DecisionMoment, PartOfDay, Weekday } from "@auxo/shared";

// The user's local time at `at`, in `timeZone` (an IANA name the request
// already validated). Null when the zone can't be used, so a bad zone only
// loses the local time, never the decision.
export function describeMoment(at: Date, timeZone: string): DecisionMoment | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "long",
    }).formatToParts(at);
  } catch {
    return null;
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value;
  const hour = Number(part("hour"));
  const minute = part("minute");
  const weekday = part("weekday")?.toLowerCase();
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || minute === undefined || !isWeekday(weekday)) return null;
  return {
    time_zone: timeZone,
    local_time: `${String(hour).padStart(2, "0")}:${minute}`,
    weekday,
    part_of_day: partOfDay(hour),
  };
}

export function partOfDay(hour: number): PartOfDay {
  if (hour < 5) return "night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

const WEEKDAYS: readonly string[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function isWeekday(value: string | undefined): value is Weekday {
  return value !== undefined && WEEKDAYS.includes(value);
}
