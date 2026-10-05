import type { ClickIntent } from "./known";

// Whole-phrase matches against a control's normalized label (see normalize).
// Order matters only for readability; phrases don't overlap across intents.
export const GUESS_PHRASES: Record<ClickIntent, string[]> = {
  add_to_cart: ["add to cart", "add to bag", "add to basket", "add to shopping cart", "add to shopping bag"],
  buy_now: ["buy now", "buy it now"],
  view_cart: [
    "cart",
    "view cart",
    "go to cart",
    "bag",
    "view bag",
    "go to bag",
    "basket",
    "shopping cart",
    "shopping bag",
    "your cart",
    "item in cart",
    "items in cart",
  ],
  checkout: ["checkout", "check out", "proceed to checkout", "continue to checkout", "go to checkout", "secure checkout"],
  place_order: ["place order", "place your order", "complete purchase", "complete order", "pay now", "submit order"],
  // Cart edits. Only whole, unambiguous phrases. No +/− guesses: product
  // pages use the same "Increase/Decrease quantity" buttons for how many to
  // add (Horizon), which isn't a cart edit; a bare "+"/"−" normalizes to "".
  // "remove", "delete" and "save for later" stay EXCLUDED_PHRASES for the buy
  // intents above.
  increase_qty: [],
  decrease_qty: [],
  remove_item: ["remove", "delete", "remove item", "delete item", "remove from cart", "remove from bag"],
  save_for_later: ["save for later"],
};

// The cart edits, as opposed to buy intents.
export const EDIT_INTENTS: ReadonlySet<ClickIntent> = new Set<ClickIntent>([
  "increase_qty",
  "decrease_qty",
  "remove_item",
  "save_for_later",
]);

// Look-alikes. If any of a control's labels contains one of these, it is not
// a buy-intent control, whatever else it says. Edit intents ignore this list.
export const EXCLUDED_PHRASES = [
  "wishlist",
  "wish list",
  "add to list",
  "add to registry",
  "registry",
  "save for later",
  "remove",
  "delete",
];

const PHRASE_TO_INTENT = new Map<string, ClickIntent>(
  (Object.entries(GUESS_PHRASES) as Array<[ClickIntent, string[]]>).flatMap(([intent, phrases]) =>
    phrases.map((phrase) => [phrase, intent] as [string, ClickIntent]),
  ),
);

// Lowercase, keep letters only, collapse spaces. Digits and symbols go, so a
// cart count ("Cart (3)") or an arrow ("Checkout →") doesn't block a match,
// and a label that is only a number normalizes to "".
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
}

export function guessIntent(label: string): ClickIntent | null {
  return PHRASE_TO_INTENT.get(normalize(label)) ?? null;
}

export function isExcluded(label: string): boolean {
  const normalized = ` ${normalize(label)} `;
  return EXCLUDED_PHRASES.some((phrase) => normalized.includes(` ${phrase} `));
}

// A form action that adds to cart or starts checkout, on any store.
// /cart/add, /cart/add.js, /cart/add-to-cart/... → add_to_cart; /checkout... → checkout.
export function guessFromAction(pathname: string): ClickIntent | null {
  const path = pathname.toLowerCase();
  if (/(^|\/)cart\/add([/._-]|$)/.test(path)) return "add_to_cart";
  if (/(^|\/)checkout([/._-]|$)/.test(path)) return "checkout";
  return null;
}
