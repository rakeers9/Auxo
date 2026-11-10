// A date-range picker for a spending limit, like booking a round trip: click
// a start day, then an end day, and optionally repeat the same number of days
// back to back (the API's `repeats`, apps/api/src/services/budget-period.ts).
// Repeat cycles after the booked one are shaded so the repeat is visible.
// Plain DOM, text through textContent only. Dates are YYYY-MM-DD.

export interface BudgetRange {
  start: string;
  // Null while the user is still picking the end day.
  end: string | null;
  repeats: boolean;
}

export interface BudgetCalendarOptions {
  start?: string;
  end?: string;
  repeats?: boolean;
  now?: () => Date;
  // How many months show side by side (2 by default).
  months?: number;
  onChange?: (value: BudgetRange) => void;
}

export interface BudgetCalendar {
  value(): BudgetRange;
  // Clear the range (or set a new one) and show its month.
  reset(value?: Partial<BudgetRange>): void;
  destroy(): void;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT_MONTHS = MONTHS.map((month) => month.slice(0, 3));
const LONG_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const STYLE_ID = "auxo-calendar-style";

// ---- Date helpers (calendar dates, no time zone) ----

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00.000Z`) / DAY_MS);
}

function dateOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return dateOf(dayNumber(date) + days);
}

// Today in the user's own calendar.
export function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function rangeDays(start: string, end: string): number {
  return dayNumber(end) - dayNumber(start) + 1;
}

function parts(date: string): { year: number; month: number; day: number; weekday: number } {
  const value = new Date(`${date}T00:00:00.000Z`);
  return { year: value.getUTCFullYear(), month: value.getUTCMonth(), day: value.getUTCDate(), weekday: value.getUTCDay() };
}

// "Nov 5" (or "Nov 5, 2027" outside `thisYear`).
export function shortDate(date: string, thisYear?: number): string {
  const { year, month, day } = parts(date);
  return `${SHORT_MONTHS[month]} ${day}${thisYear === undefined || year === thisYear ? "" : `, ${year}`}`;
}

// "every day", "every week", "every 2 weeks", "every 30 days".
export function repeatPhrase(days: number): string {
  if (days === 1) return "every day";
  if (days === 7) return "every week";
  if (days % 7 === 0) return `every ${days / 7} weeks`;
  return `every ${days} days`;
}

// One line describing a range: "Nov 1 to Nov 5, 5 days" and, when it
// repeats, "Repeats every 5 days: next Nov 6 to Nov 10".
export function rangeSummary(value: BudgetRange, thisYear?: number): string {
  if (value.end === null) return `From ${shortDate(value.start, thisYear)}. Now pick the last day.`;
  const days = rangeDays(value.start, value.end);
  const span = `${shortDate(value.start, thisYear)} to ${shortDate(value.end, thisYear)}, ${days === 1 ? "1 day" : `${days} days`}`;
  if (!value.repeats) return `${span}. Doesn't repeat.`;
  const next = addDays(value.end, 1);
  return `${span}. Repeats ${repeatPhrase(days)}: next ${shortDate(next, thisYear)} to ${shortDate(addDays(next, days - 1), thisYear)}, and so on.`;
}

// Where a day sits relative to the range, for styling.
export type DayRole = "start" | "end" | "single" | "inside" | "repeat-start" | "repeat" | null;

export function dayRole(date: string, start: string | null, end: string | null, repeats: boolean): DayRole {
  if (start === null) return null;
  if (end === null) return date === start ? "single" : null;
  if (date === start && date === end) return "single";
  if (date === start) return "start";
  if (date === end) return "end";
  if (date > start && date < end) return "inside";
  if (repeats && date > end) {
    return (dayNumber(date) - dayNumber(start)) % rangeDays(start, end) === 0 ? "repeat-start" : "repeat";
  }
  return null;
}

// What a click on `date` does: the first click (or a click before the start)
// picks the start, the next picks the end, and a click after a finished range
// starts a new one. Repeats is kept.
export function pick(value: BudgetRange | null, date: string, repeats: boolean): BudgetRange {
  if (value === null || value.end !== null || date < value.start) return { start: date, end: null, repeats };
  return { start: value.start, end: date, repeats };
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function addMonths(first: string, months: number): string {
  const { year, month } = parts(first);
  const total = year * 12 + month + months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
}

function daysInMonth(first: string): number {
  return rangeDays(first, addDays(addMonths(first, 1), -1));
}

// ---- The component ----

export function renderBudgetCalendar(container: HTMLElement, options: BudgetCalendarOptions = {}): BudgetCalendar {
  const doc = container.ownerDocument;
  const now = options.now ?? (() => new Date());
  const monthCount = Math.max(1, options.months ?? 2);
  injectStyle(doc);

  let repeats = options.repeats ?? false;
  let range: BudgetRange | null = options.start
    ? { start: options.start, end: options.end && options.end >= options.start ? options.end : null, repeats }
    : null;
  let hover: string | null = null;
  let firstMonth = monthStart(range?.start ?? localDate(now()));
  let focusDate = range?.start ?? localDate(now());

  const root = el(doc, "div", "auxo-cal");
  root.dataset.role = "budget-calendar";

  const fields = el(doc, "div", "auxo-cal-fields");
  const startField = fieldButton(doc, "Start");
  startField.root.dataset.field = "start";
  const endField = fieldButton(doc, "End");
  endField.root.dataset.field = "end";
  fields.append(startField.root, el(doc, "span", "auxo-cal-arrow", "→"), endField.root);

  const monthsBox = el(doc, "div", "auxo-cal-months");

  const repeatRow = el(doc, "label", "auxo-cal-repeat");
  const repeatBox = doc.createElement("input");
  repeatBox.type = "checkbox";
  repeatBox.name = "repeats";
  repeatBox.checked = repeats;
  const repeatText = el(doc, "span", undefined, "Repeat");
  repeatRow.append(repeatBox, repeatText);

  const summary = el(doc, "p", "auxo-cal-summary");
  summary.setAttribute("aria-live", "polite");
  summary.dataset.role = "range-summary";

  root.append(fields, monthsBox, repeatRow, summary);
  container.append(root);

  const value = (): BudgetRange => range ? { ...range, repeats } : { start: "", end: null, repeats };

  const changed = () => {
    draw();
    options.onChange?.(value());
  };

  const draw = () => {
    const thisYear = parts(localDate(now())).year;
    const today = localDate(now());
    startField.value.textContent = range ? shortDate(range.start, thisYear) : "Pick a day";
    endField.value.textContent = range?.end ? shortDate(range.end, thisYear) : "Pick a day";
    startField.root.setAttribute("aria-pressed", String(range === null || range.end !== null));
    endField.root.setAttribute("aria-pressed", String(range !== null && range.end === null));
    const days = range?.end ? rangeDays(range.start, range.end) : null;
    repeatText.textContent = days === null ? "Repeat" : `Repeat ${repeatPhrase(days)}`;
    summary.textContent = range ? rangeSummary({ ...range, repeats }, thisYear) : "Pick the first day of the limit.";

    // With only a start picked, hovering a later day previews the range.
    const previewEnd = range && range.end === null && hover && hover >= range.start ? hover : range?.end ?? null;

    monthsBox.replaceChildren();
    for (let index = 0; index < monthCount; index += 1) {
      const first = addMonths(firstMonth, index);
      const month = el(doc, "div", "auxo-cal-month");
      const { year, month: monthIndex } = parts(first);
      // The first month has the back arrow and the last the forward one.
      const caption = el(doc, "div", "auxo-cal-caption");
      caption.append(
        index === 0 ? navButton(doc, "‹", "Previous month", "previous") : el(doc, "span", "auxo-cal-step-gap"),
        el(doc, "span", "auxo-cal-caption-text", `${MONTHS[monthIndex]} ${year}`),
        index === monthCount - 1 ? navButton(doc, "›", "Next month", "next") : el(doc, "span", "auxo-cal-step-gap"),
      );
      const grid = el(doc, "div", "auxo-cal-grid");
      grid.setAttribute("role", "group");
      grid.setAttribute("aria-label", `${MONTHS[monthIndex]} ${year}`);
      for (const weekday of WEEKDAYS) grid.append(el(doc, "span", "auxo-cal-weekday", weekday));
      for (let blank = 0; blank < parts(first).weekday; blank += 1) grid.append(el(doc, "span", "auxo-cal-blank"));
      for (let day = 0; day < daysInMonth(first); day += 1) {
        const date = addDays(first, day);
        const cell = doc.createElement("button");
        cell.type = "button";
        cell.className = "auxo-cal-day";
        cell.textContent = String(day + 1);
        cell.dataset.date = date;
        const role = dayRole(date, range?.start ?? null, previewEnd, repeats && range?.end !== null);
        if (role) cell.dataset.state = role;
        if (range?.end === null && previewEnd && previewEnd !== range.start && role) cell.dataset.preview = "true";
        if (date === today) cell.dataset.today = "true";
        const selected = role === "start" || role === "end" || role === "single";
        cell.setAttribute("aria-pressed", String(selected));
        const { weekday } = parts(date);
        cell.setAttribute("aria-label", `${LONG_WEEKDAYS[weekday]}, ${MONTHS[monthIndex]} ${day + 1}, ${year}${date === today ? ", today" : ""}`);
        cell.tabIndex = date === focusDate ? 0 : -1;
        grid.append(cell);
      }
      month.append(caption, grid);
      monthsBox.append(month);
    }
    // Keep one day reachable with Tab even when focusDate is off screen.
    if (!monthsBox.querySelector('.auxo-cal-day[tabindex="0"]')) {
      const firstDay = monthsBox.querySelector<HTMLButtonElement>(".auxo-cal-day");
      if (firstDay) firstDay.tabIndex = 0;
    }
  };

  const shown = (date: string) => date >= firstMonth && date < addMonths(firstMonth, monthCount);

  const moveFocus = (date: string) => {
    focusDate = date;
    if (!shown(date)) firstMonth = date < firstMonth ? monthStart(date) : addMonths(monthStart(date), 1 - monthCount);
    draw();
    monthsBox.querySelector<HTMLButtonElement>(`[data-date="${date}"]`)?.focus();
  };

  const onClick = (event: Event) => {
    const step = (event.target as HTMLElement).closest<HTMLElement>(".auxo-cal-step")?.dataset.action;
    if (step) {
      firstMonth = addMonths(firstMonth, step === "previous" ? -1 : 1);
      draw();
      monthsBox.querySelector<HTMLButtonElement>(`.auxo-cal-step[data-action="${step}"]`)?.focus();
      return;
    }
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>(".auxo-cal-day");
    if (!target?.dataset.date) return;
    range = pick(range, target.dataset.date, repeats);
    focusDate = target.dataset.date;
    hover = null;
    changed();
    monthsBox.querySelector<HTMLButtonElement>(`[data-date="${focusDate}"]`)?.focus();
  };

  const onHover = (event: Event) => {
    if (!range || range.end !== null) return;
    const date = (event.target as HTMLElement).closest<HTMLElement>(".auxo-cal-day")?.dataset.date ?? null;
    if (date === hover) return;
    hover = date;
    draw();
  };

  const onLeave = () => {
    if (hover === null) return;
    hover = null;
    draw();
  };

  const KEY_STEPS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  const onKey = (event: KeyboardEvent) => {
    const date = (event.target as HTMLElement).closest<HTMLElement>(".auxo-cal-day")?.dataset.date;
    const step = KEY_STEPS[event.key];
    if (!date || step === undefined) return;
    event.preventDefault();
    moveFocus(addDays(date, step));
  };

  // The Start chip starts a new range; the End chip goes back to picking the
  // end day for the current start.
  const onStartField = () => {
    range = null;
    changed();
  };
  const onEndField = () => {
    if (!range) return;
    range = { ...range, end: null };
    changed();
  };
  const onRepeat = () => {
    repeats = repeatBox.checked;
    changed();
  };

  monthsBox.addEventListener("click", onClick);
  monthsBox.addEventListener("mouseover", onHover);
  monthsBox.addEventListener("mouseleave", onLeave);
  monthsBox.addEventListener("keydown", onKey);
  startField.root.addEventListener("click", onStartField);
  endField.root.addEventListener("click", onEndField);
  repeatBox.addEventListener("change", onRepeat);

  draw();

  return {
    value,
    reset(next = {}) {
      repeats = next.repeats ?? false;
      repeatBox.checked = repeats;
      range = next.start ? { start: next.start, end: next.end ?? null, repeats } : null;
      hover = null;
      focusDate = range?.start ?? localDate(now());
      firstMonth = monthStart(focusDate);
      draw();
    },
    destroy() {
      monthsBox.removeEventListener("click", onClick);
      monthsBox.removeEventListener("mouseover", onHover);
      monthsBox.removeEventListener("mouseleave", onLeave);
      monthsBox.removeEventListener("keydown", onKey);
      startField.root.removeEventListener("click", onStartField);
      endField.root.removeEventListener("click", onEndField);
      repeatBox.removeEventListener("change", onRepeat);
      root.remove();
    },
  };
}

function fieldButton(doc: Document, label: string): { root: HTMLButtonElement; value: HTMLElement } {
  const root = doc.createElement("button");
  root.type = "button";
  root.className = "auxo-cal-field";
  const value = el(doc, "span", "auxo-cal-field-value");
  root.append(el(doc, "span", "auxo-cal-field-label", label), value);
  return { root, value };
}

function navButton(doc: Document, text: string, label: string, action: string): HTMLButtonElement {
  const control = doc.createElement("button");
  control.type = "button";
  control.className = "auxo-cal-step";
  control.textContent = text;
  control.dataset.action = action;
  control.setAttribute("aria-label", label);
  return control;
}

function el(doc: Document, tag: string, className?: string, text?: string): HTMLElement {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The calendar brings its own styles, using the settings page's colour tokens
// (--fg, --muted, --line, --accent, --bg) with fallbacks.
function injectStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.auxo-cal { --cal-accent: var(--accent, #1d4ed8); --cal-line: var(--line, #e3e3e3); --cal-bg: var(--bg, #fff); --cal-muted: var(--muted, #5f6368);
  display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 600px; }
.auxo-cal-fields { display: flex; align-items: stretch; gap: 8px; }
.auxo-cal-field { flex: 1 1 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 8px 12px;
  border: 1px solid var(--cal-line); border-radius: 8px; background: transparent; text-align: left; cursor: pointer; }
.auxo-cal-field[aria-pressed="true"] { border-color: var(--cal-accent); box-shadow: inset 0 0 0 1px var(--cal-accent); }
.auxo-cal-field-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--cal-muted); }
.auxo-cal-field-value { font-size: 15px; font-weight: 600; }
.auxo-cal-arrow { align-self: center; color: var(--cal-muted); }
.auxo-cal-step, .auxo-cal-step-gap { flex: 0 0 32px; width: 32px; height: 32px; padding: 0; border-radius: 50%; font-size: 18px; line-height: 1; }
.auxo-cal-months { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px 28px; }
.auxo-cal-caption { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
.auxo-cal-caption-text { flex: 1; text-align: center; font-weight: 600; }
.auxo-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); row-gap: 2px; }
.auxo-cal-weekday { text-align: center; font-size: 11px; color: var(--cal-muted); padding: 4px 0; }
.auxo-cal-day { position: relative; height: 36px; padding: 0; border: 0; border-radius: 0; background: transparent; font-variant-numeric: tabular-nums; }
.auxo-cal-day:hover { background: color-mix(in srgb, var(--cal-accent) 12%, transparent); border-radius: 50%; }
.auxo-cal-day[data-today="true"] { font-weight: 700; text-decoration: underline; text-underline-offset: 3px; }
.auxo-cal-day[data-state="inside"] { background: color-mix(in srgb, var(--cal-accent) 16%, transparent); border-radius: 0; }
.auxo-cal-day[data-state="start"], .auxo-cal-day[data-state="end"], .auxo-cal-day[data-state="single"] {
  background: var(--cal-accent); color: var(--cal-bg); font-weight: 600; }
.auxo-cal-day[data-state="start"] { border-radius: 18px 0 0 18px; }
.auxo-cal-day[data-state="end"] { border-radius: 0 18px 18px 0; }
.auxo-cal-day[data-state="single"] { border-radius: 50%; }
.auxo-cal-day[data-preview="true"][data-state="inside"], .auxo-cal-day[data-preview="true"][data-state="end"] {
  background: color-mix(in srgb, var(--cal-accent) 10%, transparent); color: inherit; outline: 1px dashed var(--cal-accent); outline-offset: -1px; }
.auxo-cal-day[data-state="repeat"], .auxo-cal-day[data-state="repeat-start"] {
  background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--cal-accent) 9%, transparent) 0 4px, transparent 4px 8px); border-radius: 0; }
.auxo-cal-day[data-state="repeat-start"] { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--cal-accent) 55%, transparent); }
.auxo-cal-repeat { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
.auxo-cal-summary { margin: 0; font-size: 13px; color: var(--cal-muted); }
`;
  doc.head.append(style);
}
