import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

import { decide } from "../src/api/client";
import { postEvent } from "../src/api/events";
import { handleDecideMessage, handleEventMessage, isDecideMessage, isEventMessage } from "../src/api/handler";
import { API_BASE_URL } from "../src/config";

export default defineBackground(() => {
  // All API calls happen here, so CORS only has to allow the extension origin.
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (isDecideMessage(message)) {
      void handleDecideMessage(message, (cart) => decide(cart, { baseUrl: API_BASE_URL })).then(sendResponse);
      return true; // keep the channel open for the async response
    }
    if (isEventMessage(message)) {
      void handleEventMessage(message, (event) => postEvent(event, { baseUrl: API_BASE_URL })).then(sendResponse);
      return true;
    }
  });
});
