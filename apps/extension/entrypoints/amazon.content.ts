import type { Verdict } from "@auxo/shared";
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import {
  createShadowRootUi,
  type ShadowRootContentScriptUi,
} from "wxt/utils/content-script-ui/shadow-root";

import { extractAmazonCart, hashCart, isAmazonCartPage } from "../src/cart";
import { createCartFlow } from "../src/flow";
import { buildExitEvent } from "../src/api/events";
import type { DecideMessage, DecideResult, EventMessage, EventResult, ExitAction } from "../src/messages";
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

    // Every exit is logged (design invariant: every override is recorded).
    // The event is built once, so a retry would reuse its event_id.
    const onExit = (verdict: Verdict, action: ExitAction) => {
      removeOverlay();
      const event = buildExitEvent(verdict.decision_id, action);
      void browser.runtime
        .sendMessage<EventMessage, EventResult>({ type: "auxo:event", event })
        .then((result) => {
          if (!result.ok) console.info("[Auxo] exit not recorded:", result.reason);
        })
        .catch(() => console.info("[Auxo] exit not recorded: worker unavailable"));
    };

    const show = async (verdict: Verdict) => {
      removeOverlay();
      if (verdict.lane === "L0") return; // silent pass

      const next = await createShadowRootUi(ctx, {
        name: "auxo-overlay",
        position: "inline",
        anchor: "body",
        onMount: (container) =>
          renderOverlay(container, verdict, { onExit: (action) => onExit(verdict, action) }),
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
