import type { Verdict } from "@auxo/shared";
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import {
  createShadowRootUi,
  type ShadowRootContentScriptUi,
} from "wxt/utils/content-script-ui/shadow-root";

import { extractAmazonCart, hashCart, isAmazonCartPage } from "../src/cart";
import { createCartFlow } from "../src/flow";
import type { DecideMessage, DecideResult, ExitAction } from "../src/messages";
import { renderOverlay, type OverlayHandle } from "../src/overlay";
import { watchForChanges } from "../src/watch";

const RECHECK_DEBOUNCE_MS = 500;

export default defineContentScript({
  matches: ["https://www.amazon.com/*"],
  async main(ctx) {
    let ui: ShadowRootContentScriptUi<OverlayHandle | null> | null = null;

    const removeOverlay = () => {
      ui?.remove(); // onRemove calls destroy(), which clears timers and listeners
      ui = null;
    };

    const onExit = (action: ExitAction) => {
      // Phase 2 posts this to /v1/events. For now the overlay just gets out of the way.
      console.info("[Auxo] exit", action);
      removeOverlay();
    };

    const show = async (verdict: Verdict) => {
      removeOverlay();
      if (verdict.lane === "L0") return; // silent pass

      const next = await createShadowRootUi(ctx, {
        name: "auxo-overlay",
        position: "inline",
        anchor: "body",
        onMount: (container) => renderOverlay(container, verdict, { onExit }),
        onRemove: (handle) => handle?.destroy(),
      });
      if (ctx.isInvalid) return;
      next.mount();
      ui = next;
    };

    const run = createCartFlow({
      isCartPage: () => isAmazonCartPage(new URL(location.href), document),
      extract: () => extractAmazonCart(document, new URL(location.href)),
      hash: hashCart,
      requestVerdict: (cart) =>
        browser.runtime.sendMessage<DecideMessage, DecideResult>({ type: "auxo:decide", cart }),
      show: (verdict) => void show(verdict),
    });

    const check = () => {
      if (ctx.isInvalid) return;
      void run().then((outcome) => {
        if (outcome.status === "failed_open") console.info("[Auxo] failed open:", outcome.reason);
      });
    };

    check();
    const stop = watchForChanges(document.body, check, {
      debounceMs: RECHECK_DEBOUNCE_MS,
      ignore: () => ui?.shadowHost ?? null,
    });
    ctx.onInvalidated(() => {
      stop();
      removeOverlay();
    });
  },
});
