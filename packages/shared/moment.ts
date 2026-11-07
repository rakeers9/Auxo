import { z } from "zod";

// An IANA time zone name (e.g. "America/New_York") the runtime can format
// dates in. The extension sends the browser's zone so the API can tell what
// the user's local time is (it only ever sees UTC timestamps otherwise).
export const TimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isSupportedTimeZone, { message: "Unknown time zone." });

export const WeekdaySchema = z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);

// night 00:00–04:59, morning 05:00–11:59, afternoon 12:00–16:59, evening 17:00–23:59.
export const PartOfDaySchema = z.enum(["night", "morning", "afternoon", "evening"]);

// When the user is shopping, in their own time zone. Given to the decision
// model and returned in the decision context.
export const DecisionMomentSchema = z
  .object({
    time_zone: z.string(),
    // 24-hour local time, "HH:MM".
    local_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    weekday: WeekdaySchema,
    part_of_day: PartOfDaySchema,
  })
  .strict();

export function isSupportedTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export type Weekday = z.infer<typeof WeekdaySchema>;
export type PartOfDay = z.infer<typeof PartOfDaySchema>;
export type DecisionMoment = z.infer<typeof DecisionMomentSchema>;
