import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

import { decide } from "../src/api/client";
import { postEvent } from "../src/api/events";
import {
  handleDecideMessage,
  handleEventMessage,
  isAckMessage,
  isClaimMessage,
  isDecideMessage,
  isEventMessage,
  triggerOf,
} from "../src/api/handler";
import { createHandoff } from "../src/api/handoff";
import { API_BASE_URL } from "../src/config";
import type { ClaimResult } from "../src/messages";

export default defineBackground(() => {
  // Holds add-to-cart answers across page changes in a tab.
  const handoff = createHandoff();
  browser.tabs.onRemoved.addListener((tabId) => handoff.forget(tabId));

  // All API calls happen here, so CORS only has to allow the extension origin.
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const tabId = sender.tab?.id;

    if (isDecideMessage(message)) {
      const result = handleDecideMessage(message, (cart, trigger) => decide(cart, { baseUrl: API_BASE_URL }, trigger));
      if (tabId !== undefined) handoff.track(tabId, triggerOf(message), result);
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
    if (isClaimMessage(message)) {
      const claimed = tabId === undefined ? Promise.resolve(null) : handoff.claim(tabId);
      void claimed.then((verdict) => sendResponse({ verdict } satisfies ClaimResult));
      return true;
    }
  });
});
