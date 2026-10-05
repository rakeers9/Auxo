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

export interface FinishOptions {
  // How problem messages name the store's own total.
  totalLabel?: string;
  // Defaults are Amazon's; other stores pass their own.
  merchant?: string;
  currency?: string;
}

// Check the lines against the store's own total and build the draft, or
// explain why not. Every reader ends here, so they share one bar for "reliable".
export function finishReading(
  pageUrl: string,
  items: Item[],
  total: number | null,
  problems: string[],
  details: Record<string, string>,
  { totalLabel = "Amazon's total", merchant = MERCHANT, currency = CURRENCY }: FinishOptions = {},
): Reading {
  if (total !== null && items.length > 0 && problems.length === 0) {
    const sum = items.reduce((acc, item) => acc + item.price_minor * item.qty, 0);
    details["items sum"] = formatMinor(sum, currency);
    if (!Number.isSafeInteger(sum) || sum !== total) {
      problems.push(`items sum ${formatMinor(sum, currency)} but ${totalLabel} says ${formatMinor(total, currency)}`);
    }
  }
  if (problems.length > 0 || total === null) return { draft: null, problems, details };

  const draft: CartDraft = {
    merchant,
    items,
    total_minor: total,
    currency,
    url: pageUrl,
  };
  const parsed = CartDraftSchema.safeParse(draft);
  if (!parsed.success) {
    problems.push(`cart failed the shared Cart schema: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    return { draft: null, problems, details };
  }
  return { draft, problems, details };
}

// A cart the page shows as verifiably empty: no items, no problems. Not a
// valid Cart for /v1/decide (items must be non-empty), and the flow never
// decides on it; it only lets watchers see that the last item went away.
export function emptyReading(
  pageUrl: string,
  details: Record<string, string>,
  { merchant = MERCHANT, currency = CURRENCY }: Pick<FinishOptions, "merchant" | "currency"> = {},
): Reading {
  return { draft: { merchant, items: [], total_minor: 0, currency, url: pageUrl }, problems: [], details };
}

// Trim, collapse whitespace, and cap at the Cart schema's name limit.
export function cleanName(text: string | null | undefined): string {
  return normalize(text ?? "").slice(0, MAX_NAME_LENGTH);
}

export function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// 12684 -> "$126.84" (or "126.84 EUR"), for 2-decimal currencies. For problem
// messages only, never for money math.
export function formatMinor(minor: number, currency = CURRENCY): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const amount = `${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
  return currency === "USD" ? `${sign}$${amount}` : `${sign}${amount} ${currency}`;
}

// Quote page text in a problem message, shortened so the panel stays readable.
export function quote(text: string | null | undefined, max = 40): string {
  if (text === null || text === undefined) return "(missing)";
  const clean = normalize(text);
  return JSON.stringify(clean.length > max ? `${clean.slice(0, max)}…` : clean);
}
