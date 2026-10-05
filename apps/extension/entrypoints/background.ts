import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

import { decide } from "../src/api/client";
import { postEvent } from "../src/api/events";
import {
  handleDecideMessage,
  handleEventMessage,
  isAckMessage,
  isCartLoadMessage,
  isCartRecordMessage,
  isClaimMessage,
  isConfigMessage,
  isDecideMessage,
  isDecisionForMessage,
  isEventMessage,
  isWishlistSaveMessage,
  triggerOf,
} from "../src/api/handler";
import { createCartState } from "../src/api/cart-state";
import { createDecisionMemory, type RememberedCart } from "../src/api/decision-memory";
import { createHandoff } from "../src/api/handoff";
import { createConfigCache, fetchStoreConfig, overridesFor } from "../src/api/store-config";
import { API_BASE_URL } from "../src/config";
import { saveDecisionToWishlist } from "../src/wishlist/save";
import { createWishlist } from "../src/wishlist/store";
import type { CartLoadResult, ClaimResult, ConfigResult, DecisionForResult } from "../src/messages";

export default defineBackground(() => {
  // Holds add-to-cart answers across page changes in a tab.
  const handoff = createHandoff();
  // Which decisions covered which items, kept across worker restarts.
  const memory = createDecisionMemory({
    get: (key) => browser.storage.session.get(key),
    set: (items) => browser.storage.session.set(items),
  });
  browser.tabs.onRemoved.addListener((tabId) => handoff.forget(tabId));
  // "Save for later" items, shown in the toolbar popup.
  const wishlist = createWishlist({
    get: (key) => browser.storage.local.get(key),
    set: (items) => browser.storage.local.set(items),
  });
  // The last cart any tab saw per store, to catch changes made elsewhere.
  const cartState = createCartState({
    get: (key) => browser.storage.local.get(key),
    set: (items) => browser.storage.local.set(items),
  });
  // Store selectors and on/off switches from the backend (data, not code).
  const config = createConfigCache({
    load: () => fetchStoreConfig({ baseUrl: API_BASE_URL }),
    area: { get: (key) => browser.storage.local.get(key), set: (items) => browser.storage.local.set(items) },
  });

  // All API calls happen here, so CORS only has to allow the extension origin.
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const tabId = sender.tab?.id;

    if (isDecideMessage(message)) {
      const result = handleDecideMessage(message, (cart, trigger) => decide(cart, { baseUrl: API_BASE_URL }, trigger));
      if (tabId !== undefined) handoff.track(tabId, triggerOf(message), result);
      void result.then((r) => {
        // r.ok means the cart passed validation in handleDecideMessage.
        if (r.ok) void memory.remember(r.verdict.decision_id, message.cart as RememberedCart);
      });
      void result.then(sendResponse);
      return true; // keep the channel open for the async response
    }
    if (isEventMessage(message)) {
      void handleEventMessage(message, (event) => postEvent(event, { baseUrl: API_BASE_URL })).then(sendResponse);
      return true;
    }
    if (isAckMessage(message)) {
      if (tabId !== undefined) void handoff.ack(tabId, message.decisionId);
      return;
    }
    if (isDecisionForMessage(message)) {
      void memory.decisionFor(message.items).then((decisionId) => sendResponse({ decisionId } satisfies DecisionForResult));
      return true;
    }
    if (isConfigMessage(message)) {
      void config.get().then((c) => sendResponse({ overrides: overridesFor(c, message.host) } satisfies ConfigResult));
      return true;
    }
    if (isCartRecordMessage(message)) {
      void cartState.record(message.merchant, message.cart);
      return;
    }
    if (isCartLoadMessage(message)) {
      void cartState.compareAtLoad(message.merchant, message.cart).then((change) => sendResponse({ change } satisfies CartLoadResult));
      return true;
    }
    if (isWishlistSaveMessage(message)) {
      void saveDecisionToWishlist(message.decisionId, memory, wishlist);
      return;
    }
    if (isClaimMessage(message)) {
      const claimed = tabId === undefined ? Promise.resolve(null) : handoff.claim(tabId);
      void claimed.then((verdict) => sendResponse({ verdict } satisfies ClaimResult));
      return true;
    }
  });
});
