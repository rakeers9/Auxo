import type { DecidedCart } from "./override-carry";

// Keeps a pause or block's timer running across pages for the same cart.
//
// Every page asks for a fresh decision, and each one used to show its overlay
// with the full cooldown, so walking from the added-to-cart page to the cart
// to checkout restarted the wait each time. Now the cooldown counts from when
// a pause or block for this cart (merchant + cart_hash) was first shown in
// this tab. A stricter lane's longer cooldown still applies, also counted from
// that first showing. Kept in the tab's sessionStorage for CARRY_WINDOW_MS;
// after that, the cart starts fresh.

export interface CooldownCarry {
  // Seconds left of `cooldownSeconds` for this cart: the full cooldown when
  // it hasn't been paused in this tab recently, less the time since then.
  remaining(cart: DecidedCart, cooldownSeconds: number): number;
  // A pause or block for this cart is on screen. Keeps the first time.
  shown(cart: DecidedCart): void;
}

export const CARRY_WINDOW_MS = 30 * 60_000;

const KEY = "auxo:cooldowns";
const MAX_SAVED = 20;

interface Saved {
  merchant: string;
  cart_hash: string;
  shown_at: number;
}

// storage is null when sessionStorage is unavailable; then the timer only
// carries within this page.
export function createCooldownCarry(storage: Storage | null, now: () => number = Date.now): CooldownCarry {
  let saved = read(storage);

  const active = (): Saved[] => {
    const cutoff = now() - CARRY_WINDOW_MS;
    const byCart = new Map<string, Saved>();
    for (const s of [...read(storage), ...saved]) {
      if (s.shown_at <= cutoff || s.shown_at > now()) continue;
      const key = JSON.stringify([s.merchant, s.cart_hash]);
      // The earliest showing wins: that's when the wait started.
      if ((byCart.get(key)?.shown_at ?? Infinity) > s.shown_at) byCart.set(key, s);
    }
    saved = [...byCart.values()];
    return saved;
  };
  const shownAt = (cart: DecidedCart): number | undefined =>
    active().find((s) => s.merchant === cart.merchant && s.cart_hash === cart.cartHash)?.shown_at;

  return {
    remaining(cart, cooldownSeconds) {
      const since = shownAt(cart);
      if (since === undefined) return cooldownSeconds;
      const elapsedSeconds = Math.floor((now() - since) / 1000);
      return Math.max(0, cooldownSeconds - elapsedSeconds);
    },
    shown(cart) {
      if (shownAt(cart) !== undefined) return;
      const entry: Saved = { merchant: cart.merchant, cart_hash: cart.cartHash, shown_at: now() };
      saved = [entry, ...active()].slice(0, MAX_SAVED);
      try {
        storage?.setItem(KEY, JSON.stringify(saved));
      } catch {
        // Full or blocked storage: this page still remembers.
      }
    },
  };
}

function read(storage: Storage | null): Saved[] {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (s): s is Saved =>
        typeof s === "object" && s !== null &&
        typeof s.merchant === "string" && typeof s.cart_hash === "string" && typeof s.shown_at === "number",
    );
  } catch {
    return [];
  }
}
