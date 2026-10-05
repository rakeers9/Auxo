import { browser } from "wxt/browser";

import { createWishlist, WISHLIST_KEY } from "../../src/wishlist/store";
import { renderWishlist } from "../../src/wishlist/view";

const wishlist = createWishlist({
  get: (key) => browser.storage.local.get(key),
  set: (items) => browser.storage.local.set(items),
});

const root = document.getElementById("app");
if (root) {
  const view = renderWishlist(root, wishlist);
  // An item saved while the popup is open (by the worker) shows up right away.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && WISHLIST_KEY in changes) void view.refresh();
  });
}
