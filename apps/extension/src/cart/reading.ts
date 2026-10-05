import { CartSchema } from "@auxo/shared";

import type { CartDraft } from "../messages";

// What a page reader saw. `draft` is null exactly when `problems` is non-empty,
// and `problems` says why in plain English (shown in the dev debug panel).
export interface Reading {
  draft: CartDraft | null;
  problems: string[];
  details: Record<string, string>;
}

export const MERCHANT = "amazon.com";
export const CURRENCY = "USD";
const MAX_NAME_LENGTH = 500;

const CartDraftSchema = CartSchema.omit({ cart_hash: true });

type Item = CartDraft["items"][number];

// Check the lines against Amazon's own total and build the draft, or explain
// why not. Every reader ends here, so they share one bar for "reliable".
export function finishReading(
  pageUrl: string,
  items: Item[],
  total: number | null,
  problems: string[],
  details: Record<string, string>,
): Reading {
  if (total !== null && items.length > 0 && problems.length === 0) {
    const sum = items.reduce((acc, item) => acc + item.price_minor * item.qty, 0);
    details["items sum"] = formatMinor(sum);
    if (!Number.isSafeInteger(sum) || sum !== total) {
      problems.push(`items sum ${formatMinor(sum)} but Amazon's total says ${formatMinor(total)}`);
    }
  }
  if (problems.length > 0 || total === null) return { draft: null, problems, details };

  const draft: CartDraft = {
    merchant: MERCHANT,
    items,
    total_minor: total,
    currency: CURRENCY,
    url: pageUrl,
  };
  const parsed = CartDraftSchema.safeParse(draft);
  if (!parsed.success) {
    problems.push(`cart failed the shared Cart schema: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    return { draft: null, problems, details };
  }
  return { draft, problems, details };
}

// Trim, collapse whitespace, and cap at the Cart schema's name limit.
export function cleanName(text: string | null | undefined): string {
  return normalize(text ?? "").slice(0, MAX_NAME_LENGTH);
}

export function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// 12684 -> "$126.84". For problem messages only, never for money math.
export function formatMinor(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

// Quote page text in a problem message, shortened so the panel stays readable.
export function quote(text: string | null | undefined, max = 40): string {
  if (text === null || text === undefined) return "(missing)";
  const clean = normalize(text);
  return JSON.stringify(clean.length > max ? `${clean.slice(0, max)}…` : clean);
}
