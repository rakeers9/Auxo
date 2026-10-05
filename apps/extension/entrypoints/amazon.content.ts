import type { DecisionEvent, Trigger, UserAction, Verdict } from "@auxo/shared";
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import {
  createShadowRootUi,
  type ShadowRootContentScriptUi,
} from "wxt/utils/content-script-ui/shadow-root";

import { buildExitEvent } from "../src/api/events";
import { hashCart, inspectAmazonPage } from "../src/cart";
import { classifyClick, classifySubmit } from "../src/clicks";
import { createDebugPanel, type BackendStatus, type DebugPanel } from "../src/debug/panel";
import { createCartFlow, type CartFlowOutcome } from "../src/flow";
import type { ClickSignal, DecideMessage, DecideResult, EventMessage, EventResult, ExitAction } from "../src/messages";
import { renderOverlay, type OverlayHandle } from "../src/overlay";
import { listenForBuyIntents } from "../src/tracking/listener";
import { createPendingStore } from "../src/tracking/pending";
import { createTracker } from "../src/tracking/tracker";
import { watchForChanges } from "../src/watch";

const RECHECK_DEBOUNCE_MS = 500;

// Dev builds (`wxt` or `wxt build --mode development`) show the always-on
// debug panel instead of the overlay, to check what the extension reads.
const DEBUG = import.meta.env.MODE === "development";

function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export default defineContentScript({
  matches: ["https://www.amazon.com/*"],
  async main(ctx) {
    let ui: ShadowRootContentScriptUi<OverlayHandle | null> | null = null;
    let debugUi: ShadowRootContentScriptUi<DebugPanel> | null = null;

    // What the debug panel shows, kept between checks.
    let checks = 0;
    let backend: BackendStatus = { status: "not_asked" };
    let cartHash: string | null = null;
    let trigger: Trigger | null = null;
    let lastClick: { signal: ClickSignal; at: Date } | null = null;
    let pendingPurchase: string | null = null;
    const events: Array<{ action: UserAction; decisionId: string; at: Date }> = [];

    const refreshDebug = () => {
      if (!debugUi?.mounted) return;
      const url = new URL(location.href);
      debugUi.mounted.update({
        url: url.href,
        inspection: inspectAmazonPage(document, url),
        cartHash,
        backend,
        checkedAt: new Date(),
        checks,
        trigger,
        lastClick,
        events,
        pendingPurchase,
      });
    };

    const removeOverlay = () => {
      ui?.remove(); // onRemove calls destroy(), which clears timers and listeners
      ui = null;
    };

    const sendEvent = (event: DecisionEvent) => {
      events.unshift({ action: event.action, decisionId: event.decision_id, at: new Date(event.occurred_at) });
      refreshDebug();
      void browser.runtime
        .sendMessage<EventMessage, EventResult>({ type: "auxo:event", event })
        .then((result) => {
          if (!result.ok) console.info(`[Auxo] ${event.action} event not recorded:`, result.reason);
        })
        .catch(() => console.info(`[Auxo] ${event.action} event not recorded: worker unavailable`));
    };

    // Every exit is logged (design invariant: every override is recorded).
    const onExit = (verdict: Verdict, action: ExitAction) => {
      removeOverlay();
      sendEvent(buildExitEvent(verdict.decision_id, action));
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

    const record = (outcome: CartFlowOutcome) => {
      // A product page re-render after an add-to-cart answer shouldn't wipe it.
      if (outcome.status === "skipped" && outcome.reason === "product_without_click") return;
      switch (outcome.status) {
        case "skipped":
        case "unreadable":
          backend = { status: "not_asked" };
          cartHash = null;
          break;
        case "unchanged":
          cartHash = outcome.cartHash; // keep showing the last answer
          break;
        case "failed_open":
          console.info("[Auxo] failed open:", outcome.reason);
          backend = { status: "failed", reason: outcome.reason };
          cartHash = outcome.cartHash;
          trigger = outcome.trigger;
          break;
        case "shown":
          backend = {
            status: "verdict",
            lane: outcome.verdict.lane,
            decisionId: outcome.verdict.decision_id,
            templateId: outcome.verdict.template_id,
          };
          cartHash = outcome.cartHash;
          trigger = outcome.trigger;
          break;
      }
    };

    const flow = createCartFlow({
      inspect: () => inspectAmazonPage(document, new URL(location.href)),
      hash: hashCart,
      requestVerdict: (cart, t) =>
        browser.runtime.sendMessage<DecideMessage, DecideResult>({ type: "auxo:decide", cart, trigger: t }),
      show: (verdict) => void show(verdict),
    });

    const tracker = createTracker({
      flow,
      pending: createPendingStore(sessionStorageOrNull()),
      inspect: () => inspectAmazonPage(document, new URL(location.href)),
      sendEvent,
      note: (n) => {
        if (n.kind === "click") lastClick = { signal: n.signal, at: n.at };
        if (n.kind === "outcome") record(n.outcome);
        if (n.kind === "purchase_pending") pendingPurchase = n.decisionId;
        refreshDebug();
      },
    });

    const step = (run: () => Promise<unknown>) => () => {
      if (ctx.isInvalid) return;
      checks += 1;
      refreshDebug();
      void run();
    };

    step(() => tracker.onLoad())();
    const stopWatching = watchForChanges(document.body, step(() => tracker.onPageChange()), {
      debounceMs: RECHECK_DEBOUNCE_MS,
      ignore: () => [ui?.shadowHost, debugUi?.shadowHost],
    });
    const stopListening = listenForBuyIntents(document, { classifyClick, classifySubmit }, (signal) => {
      if (ctx.isInvalid) return;
      void tracker.onBuyIntent(signal);
    });

    ctx.onInvalidated(() => {
      stopWatching();
      stopListening();
      removeOverlay();
      debugUi?.remove();
    });
  },
});
