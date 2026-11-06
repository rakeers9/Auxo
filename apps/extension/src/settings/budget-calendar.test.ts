import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addDays,
  dayRole,
  localDate,
  pick,
  rangeDays,
  rangeSummary,
  renderBudgetCalendar,
  repeatPhrase,
  shortDate,
  type BudgetRange,
} from "./budget-calendar";

// Friday, November 6, 2026, local time.
const NOW = new Date(2026, 10, 6, 12);
const now = () => NOW;

describe("date helpers", () => {
  it("counts days across months and years", () => {
    expect(rangeDays("2026-11-01", "2026-11-05")).toBe(5);
    expect(rangeDays("2026-12-30", "2027-01-02")).toBe(4);
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("uses the local calendar date for today", () => {
    expect(localDate(new Date(2026, 10, 6, 23, 59))).toBe("2026-11-06");
  });

  it("writes short dates, with the year only outside this one", () => {
    expect(shortDate("2026-11-05", 2026)).toBe("Nov 5");
    expect(shortDate("2027-01-02", 2026)).toBe("Jan 2, 2027");
  });

  it("words the repeat", () => {
    expect(repeatPhrase(1)).toBe("every day");
    expect(repeatPhrase(7)).toBe("every week");
    expect(repeatPhrase(14)).toBe("every 2 weeks");
    expect(repeatPhrase(5)).toBe("every 5 days");
  });

  it("summarizes a range and its next cycle", () => {
    expect(rangeSummary({ start: "2026-11-01", end: "2026-11-05", repeats: true }, 2026))
      .toBe("Nov 1 to Nov 5, 5 days. Repeats every 5 days: next Nov 6 to Nov 10, and so on.");
    expect(rangeSummary({ start: "2026-11-01", end: "2026-11-01", repeats: false }, 2026)).toBe("Nov 1 to Nov 1, 1 day. Doesn't repeat.");
    expect(rangeSummary({ start: "2026-11-01", end: null, repeats: false }, 2026)).toBe("From Nov 1. Now pick the last day.");
  });
});

describe("pick", () => {
  it("picks the start, then the end, then starts over", () => {
    const first = pick(null, "2026-11-10", false);
    expect(first).toEqual({ start: "2026-11-10", end: null, repeats: false });
    const second = pick(first, "2026-11-14", false);
    expect(second).toEqual({ start: "2026-11-10", end: "2026-11-14", repeats: false });
    expect(pick(second, "2026-11-20", true)).toEqual({ start: "2026-11-20", end: null, repeats: true });
  });

  it("moves the start when the second click is earlier, and allows one day", () => {
    const first = pick(null, "2026-11-10", false);
    expect(pick(first, "2026-11-03", false)).toEqual({ start: "2026-11-03", end: null, repeats: false });
    expect(pick(first, "2026-11-10", false)).toEqual({ start: "2026-11-10", end: "2026-11-10", repeats: false });
  });
});

describe("dayRole", () => {
  it("marks the ends, the inside, and repeat cycles", () => {
    const role = (date: string, repeats = true) => dayRole(date, "2026-11-01", "2026-11-05", repeats);
    expect(role("2026-11-01")).toBe("start");
    expect(role("2026-11-03")).toBe("inside");
    expect(role("2026-11-05")).toBe("end");
    expect(role("2026-11-06")).toBe("repeat-start");
    expect(role("2026-11-07")).toBe("repeat");
    expect(role("2026-11-11")).toBe("repeat-start");
    expect(role("2026-10-31")).toBeNull();
    expect(role("2026-11-06", false)).toBeNull();
  });

  it("marks a lone start", () => {
    expect(dayRole("2026-11-01", "2026-11-01", null, false)).toBe("single");
    expect(dayRole("2026-11-02", "2026-11-01", null, false)).toBeNull();
  });
});

describe("renderBudgetCalendar", () => {
  let container: HTMLElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });
  afterEach(() => container.remove());

  const day = (date: string) => container.querySelector<HTMLButtonElement>(`[data-date="${date}"]`);
  const captions = () => [...container.querySelectorAll(".auxo-cal-caption-text")].map((node) => node.textContent);
  const summary = () => container.querySelector('[data-role="range-summary"]')?.textContent ?? "";
  const field = (name: string) => container.querySelector<HTMLButtonElement>(`[data-field="${name}"]`)!;
  const repeat = () => container.querySelector<HTMLInputElement>('input[name="repeats"]')!;
  const step = (action: string) => container.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;

  it("shows this month and the next, with Sunday-first weeks", () => {
    renderBudgetCalendar(container, { now });
    expect(captions()).toEqual(["November 2026", "December 2026"]);
    // Nov 1, 2026 is a Sunday, so no blanks; Dec 1 is a Tuesday, two blanks.
    const [november, december] = container.querySelectorAll(".auxo-cal-grid");
    expect(november?.querySelectorAll(".auxo-cal-blank")).toHaveLength(0);
    expect(december?.querySelectorAll(".auxo-cal-blank")).toHaveLength(2);
    expect(day("2026-11-06")?.dataset.today).toBe("true");
    expect(day("2026-11-06")?.getAttribute("aria-label")).toBe("Friday, November 6, 2026, today");
    expect(summary()).toBe("Pick the first day of the limit.");
  });

  it("books a range with two clicks and reports each change", () => {
    const onChange = vi.fn<(value: BudgetRange) => void>();
    const calendar = renderBudgetCalendar(container, { now, onChange });

    day("2026-11-10")!.click();
    expect(onChange).toHaveBeenLastCalledWith({ start: "2026-11-10", end: null, repeats: false });
    expect(field("end").getAttribute("aria-pressed")).toBe("true");

    day("2026-11-14")!.click();
    expect(calendar.value()).toEqual({ start: "2026-11-10", end: "2026-11-14", repeats: false });
    expect(field("start").textContent).toContain("Nov 10");
    expect(field("end").textContent).toContain("Nov 14");
    expect(day("2026-11-10")?.dataset.state).toBe("start");
    expect(day("2026-11-12")?.dataset.state).toBe("inside");
    expect(day("2026-11-14")?.dataset.state).toBe("end");
    expect(day("2026-11-14")?.getAttribute("aria-pressed")).toBe("true");
    expect(summary()).toBe("Nov 10 to Nov 14, 5 days. Doesn't repeat.");
  });

  it("shades the repeat cycles once repeat is on", () => {
    const onChange = vi.fn<(value: BudgetRange) => void>();
    renderBudgetCalendar(container, { now, start: "2026-11-01", end: "2026-11-05", onChange });
    expect(day("2026-11-06")?.dataset.state).toBeUndefined();
    expect(container.querySelector(".auxo-cal-repeat")?.textContent).toBe("Repeat every 5 days");

    repeat().checked = true;
    repeat().dispatchEvent(new Event("change"));

    expect(onChange).toHaveBeenLastCalledWith({ start: "2026-11-01", end: "2026-11-05", repeats: true });
    expect(day("2026-11-06")?.dataset.state).toBe("repeat-start");
    expect(day("2026-11-08")?.dataset.state).toBe("repeat");
    expect(day("2026-12-01")?.dataset.state).toBe("repeat-start");
    expect(summary()).toContain("Repeats every 5 days: next Nov 6 to Nov 10");
  });

  it("previews the range while hovering for the end day", () => {
    renderBudgetCalendar(container, { now });
    day("2026-11-10")!.click();
    day("2026-11-13")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

    expect(day("2026-11-12")?.dataset.state).toBe("inside");
    expect(day("2026-11-12")?.dataset.preview).toBe("true");
    expect(day("2026-11-13")?.dataset.state).toBe("end");

    container.querySelector(".auxo-cal-months")!.dispatchEvent(new MouseEvent("mouseleave"));
    expect(day("2026-11-12")?.dataset.state).toBeUndefined();
  });

  it("moves between months and opens on the booked start", () => {
    renderBudgetCalendar(container, { now, start: "2027-01-03", end: "2027-01-09" });
    expect(captions()).toEqual(["January 2027", "February 2027"]);
    step("next").click();
    expect(captions()).toEqual(["February 2027", "March 2027"]);
    step("previous").click();
    step("previous").click();
    expect(captions()).toEqual(["December 2026", "January 2027"]);
  });

  it("starts over from the Start chip and re-picks the end from the End chip", () => {
    const calendar = renderBudgetCalendar(container, { now, start: "2026-11-01", end: "2026-11-05" });
    field("end").click();
    expect(calendar.value()).toEqual({ start: "2026-11-01", end: null, repeats: false });
    day("2026-11-08")!.click();
    expect(calendar.value().end).toBe("2026-11-08");

    field("start").click();
    expect(calendar.value()).toEqual({ start: "", end: null, repeats: false });
  });

  it("moves focus by day and week with the arrow keys, across months", () => {
    renderBudgetCalendar(container, { now, months: 1 });
    expect(day("2026-11-06")?.tabIndex).toBe(0);
    day("2026-11-06")!.focus();
    day("2026-11-06")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(day("2026-11-13"));
    day("2026-11-13")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    day("2026-11-20")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    day("2026-11-27")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(captions()).toEqual(["December 2026"]);
    expect(document.activeElement).toBe(day("2026-12-04"));
  });

  it("resets, and removes itself and its listeners on destroy", () => {
    const onChange = vi.fn();
    const calendar = renderBudgetCalendar(container, { now, start: "2026-11-01", end: "2026-11-05", repeats: true, onChange });
    calendar.reset();
    expect(calendar.value()).toEqual({ start: "", end: null, repeats: false });
    expect(repeat().checked).toBe(false);

    const cell = day("2026-11-10")!;
    calendar.destroy();
    cell.click();
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[data-role="budget-calendar"]')).toBeNull();
  });

  it("adds its stylesheet once", () => {
    renderBudgetCalendar(container, { now });
    renderBudgetCalendar(container, { now });
    expect(document.querySelectorAll("#auxo-calendar-style")).toHaveLength(1);
  });
});
