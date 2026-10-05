import type { Verdict } from "@auxo/shared";
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import {
  createShadowRootUi,
  type ShadowRootContentScriptUi,
} from "wxt/utils/content-script-ui/shadow-root";

import { buildExitEvent } from "../src/api/events";
import { extractAmazonCart, hashCart, isAmazonCartPage } from "../src/cart";
import { inspectPage } from "../src/debug/inspect";
import { createDebugPanel, type BackendStatus, type DebugPanel } from "../src/debug/panel";
import { createCartFlow } from "../src/flow";
import type { DecideMessage, DecideResult, EventMessage, EventResult, ExitAction } from "../src/messages";
import { renderOverlay, type OverlayHandle } from "../src/overlay";
import { watchForChanges } from "../src/watch";

const RECHECK_DEBOUNCE_MS = 500;

// Dev builds (`wxt` or `wxt build --mode development`) show the always-on
// debug panel instead of the overlay, to check what the extension reads.
const DEBUG = import.meta.env.MODE === "development";

export default defineContentScript({
  matches: ["https://www.amazon.com/*"],
  async main(ctx) {
    let ui: ShadowRootContentScriptUi<OverlayHandle | null> | null = null;
    let debugUi: ShadowRootContentScriptUi<DebugPanel> | null = null;
    let checks = 0;
    let lastBackend: BackendStatus = { status: "not_asked" };

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
      if (DEBUG) return; // the debug panel shows the verdict instead
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

    if (DEBUG) {
      debugUi = await createShadowRootUi(ctx, {
        name: "auxo-debug",
        position: "inline",
        anchor: "body",
        onMount: (container) => createDebugPanel(container),
        onRemove: (panel) => panel?.destroy(),
      });
      debugUi.mount();
    }

    const debug = (backend: BackendStatus, cartHash: string | null = null) => {
      if (backend.status !== "pending") lastBackend = backend;
      if (!debugUi?.mounted) return;
      const url = new URL(location.href);
      debugUi.mounted.update({
        url: url.href,
        inspection: inspectPage(document, url),
        cartHash,
        backend,
        checkedAt: new Date(),
        checks,
      });
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
      checks += 1;
      debug({ status: "pending" });
      void run().then((outcome) => {
        if (outcome.status === "failed_open") console.info("[Auxo] failed open:", outcome.reason);
        switch (outcome.status) {
          case "not_cart":
          case "unreadable":
            return debug({ status: "not_asked" });
          case "unchanged":
            // Same cart as the last check on this page: keep showing its answer.
            return debug(lastBackend, outcome.cartHash);
          case "failed_open":
            return debug({ status: "failed", reason: outcome.reason }, outcome.cartHash);
          case "shown":
            return debug(
              {
                status: "verdict",
                lane: outcome.verdict.lane,
                decisionId: outcome.verdict.decision_id,
                templateId: outcome.verdict.template_id,
              },
              outcome.cartHash,
            );
        }
      });
    };

    check();
    const stop = watchForChanges(document.body, check, {
      debounceMs: RECHECK_DEBOUNCE_MS,
      ignore: () => [ui?.shadowHost, debugUi?.shadowHost],
    });
    ctx.onInvalidated(() => {
      stop();
      removeOverlay();
      debugUi?.remove();
    });
  },
});
