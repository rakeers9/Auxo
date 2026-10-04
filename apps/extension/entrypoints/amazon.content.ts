import { defineContentScript } from "wxt/utils/define-content-script";

export default defineContentScript({
  matches: ["https://www.amazon.com/*"],
  main() {
    // Cart detection, the decide call, and the overlay are wired here in a later step.
  },
});
