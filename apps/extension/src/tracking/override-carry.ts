import { REDUCING_INTENTS, type Trigger } from "@auxo/shared";

// Remembers which carts the user already continued past (AUX-37).
//
// Every decide gets a fresh decision_id, so an override is tied to a decision
// the next page never sees. Without this, Continue on the cart page is
// forgotten at checkout and the same cart gets a new block with the full
// cooldown. Overrides are kept per cart (merchant + cart_hash) in the tab's
// sessionStorage until the pass expires; a later decision about a covered
// cart is still asked and logged, but never shown or used to stop a click.

export interface DecidedCart {
  merchant: string;
  cartHash: string;
}

export interface OverrideCarry {
  // A decision came back for this cart. Returns when the user's earlier
  // override of this cart ends (ms), or undefined when none covers it.
  decided(decisionId: string, cart: DecidedCart, trigger: Trigger): number | undefined;
  // The user continued past this decision, until `expiresAt` (the pass's
  // expiry, ms). With none (no pass was needed, or it failed open), the
  // override carries for CARRY_FALLBACK_MS.
  overrode(decisionId: string, expiresAt?: number): void;
  // An earlier override covers this decision, so it shouldn't be shown.
  covers(decisionId: string): boolean;
}

// The server's pass lifetime (pass-service ttlSeconds).
export const CARRY_FALLBACK_MS = 10 * 60_000;

const KEY = "auxo:overrides";
const MAX_SAVED = 20;
const REDUCING = new Set<string>(REDUCING_INTENTS);

interface Saved {
  merchant: string;
  cart_hash: string;
  until: number;
}

// storage is null when sessionStorage is unavailable; then overrides only
// last for this page.
export function createOverrideCarry(storage: Storage | null, now: () => number = Date.now): OverrideCarry {
  // Kept here too, so a page whose storage throws still works on its own.
  let saved = read(storage);
  const carts = new Map<string, DecidedCart>();
  const covered = new Map<string, number>();
  let lastCart: DecidedCart | null = null;

  // Unexpired overrides from storage (other pages) and this page, one per
  // cart, keeping the latest expiry.
  const active = (): Saved[] => {
    const byCart = new Map<string, Saved>();
    for (const s of [...read(storage), ...saved]) {
      if (s.until <= now()) continue;
      const key = JSON.stringify([s.merchant, s.cart_hash]);
      if ((byCart.get(key)?.until ?? 0) < s.until) byCart.set(key, s);
    }
    saved = [...byCart.values()];
    return saved;
  };
  const coverUntil = (cart: DecidedCart): number | undefined =>
    active().find((s) => s.merchant === cart.merchant && s.cart_hash === cart.cartHash)?.until;
  const remember = (cart: DecidedCart, until: number) => {
    if ((coverUntil(cart) ?? 0) >= until) return; // never shortens a cover
    const entry: Saved = { merchant: cart.merchant, cart_hash: cart.cartHash, until };
    saved = [entry, ...active().filter((s) => !same(s, entry))].slice(0, MAX_SAVED);
    try {
      storage?.setItem(KEY, JSON.stringify(saved));
    } catch {
      // Full or blocked storage: this page still remembers.
    }
  };

  return {
    decided(decisionId, cart, trigger) {
      carts.set(decisionId, cart);
      let until = coverUntil(cart);
      // Putting things back from a cart the user already continued past keeps
      // the smaller cart covered. Adding things is decided again.
      if (until === undefined && REDUCING.has(trigger.intent) && lastCart) {
        const previous = coverUntil(lastCart);
        if (previous !== undefined) {
          remember(cart, previous);
          until = previous;
        }
      }
      lastCart = cart;
      if (until !== undefined) covered.set(decisionId, until);
      return until;
    },
    overrode(decisionId, expiresAt) {
      const cart = carts.get(decisionId);
      if (!cart) return;
      const until = expiresAt !== undefined && Number.isFinite(expiresAt) ? expiresAt : now() + CARRY_FALLBACK_MS;
      if (until > now()) remember(cart, until);
    },
    covers(decisionId) {
      return (covered.get(decisionId) ?? 0) > now();
    },
  };
}

function same(a: Saved, b: Saved): boolean {
  return a.merchant === b.merchant && a.cart_hash === b.cart_hash;
}

function read(storage: Storage | null): Saved[] {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (s): s is Saved =>
        typeof s === "object" && s !== null &&
        typeof s.merchant === "string" && typeof s.cart_hash === "string" && typeof s.until === "number",
    );
  } catch {
    return [];
  }
}
