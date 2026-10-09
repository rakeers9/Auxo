import type { CartDraft } from "../messages";

// SHA-256 of a canonical JSON form of the cart, as 64 lowercase hex chars.
// Items are sorted and the URL is left out, so the same cart always gets the
// same hash (and so the same verdict), whatever order the page lists it in.
// Bump `v` if the canonical form ever changes.
export async function hashCart(draft: CartDraft): Promise<string> {
  const items = draft.items
    .map((item) => JSON.stringify([item.name, item.price_minor, item.qty]))
    .sort();
  const canonical = JSON.stringify({
    v: 1,
    merchant: draft.merchant,
    currency: draft.currency,
    total_minor: draft.total_minor,
    items: items.map((item) => JSON.parse(item) as unknown),
  });

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
