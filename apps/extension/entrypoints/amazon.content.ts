import type { Cart, DecisionEvent, StoreOverrides, Trigger, UserAction, Verdict } from "@auxo/shared";
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import {
  createShadowRootUi,
  type ShadowRootContentScriptUi,
} from "wxt/utils/content-script-ui/shadow-root";

import { buildExitEvent } from "../src/api/events";
import { hashCart, inspectAmazonPage, readAmazonMiniCart } from "../src/cart";
import { classifyClick, classifySubmit } from "../src/clicks";
import { createDebugPanel, type BackendStatus, type DebugPanel } from "../src/debug/panel";
import { CONTENT_TIMEOUT_MS, createCartFlow, type CartFlowOutcome } from "../src/flow";
import type {
  AckMessage,
  ClaimMessage,
  ClaimResult,
  CartDraft,
  ClickSignal,
  ConfigMessage,
  ConfigResult,
  DecideMessage,
  DecideResult,
  DecisionForMessage,
  DecisionForResult,
  EventMessage,
  EventResult,
  ExitAction,
} from "../src/messages";
import { renderOverlay, type OverlayHandle } from "../src/overlay";
import { listenForBuyIntents } from "../src/tracking/listener";
import { createMiniCartHandler } from "../src/tracking/minicart-handler";
import { createPendingStore } from "../src/tracking/pending";
import { watchMiniCart } from "../src/tracking/sidesheet";
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
    let note: string | null = null;
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
        note,
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

    // The backend's overrides for this store. If it can't be reached in time,
    // the bundled selectors are used. A store switched off does nothing.
    const overrides: StoreOverrides | null = await Promise.race([
      browser.runtime
        .sendMessage<ConfigMessage, ConfigResult>({ type: "auxo:config", host: location.hostname })
        .then((r) => r.overrides)
        .catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CONTENT_TIMEOUT_MS)),
    ]);
    if (overrides?.enabled === false) {
      note = `Auxo is switched off for ${location.hostname} by the backend config`;
      refreshDebug();
      ctx.onInvalidated(() => debugUi?.remove());
      return;
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
          if (outcome.trigger.intent === "add_to_cart") miniCart.noteClickedAdd(outcome.draft);
          console.info("[Auxo] failed open:", outcome.reason);
          backend = { status: "failed", reason: outcome.reason };
          cartHash = outcome.cartHash;
          trigger = outcome.trigger;
          break;
        case "shown":
          if (outcome.trigger.intent === "add_to_cart") miniCart.noteClickedAdd(outcome.draft);
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

    const requestVerdict = async (cart: Cart, t: Trigger): Promise<DecideResult> => {
      const result = await browser.runtime.sendMessage<DecideMessage, DecideResult>({ type: "auxo:decide", cart, trigger: t });
      // This page got its answer, so the worker shouldn't hand it to the next page.
      if (result.ok) {
        void browser.runtime
          .sendMessage<AckMessage>({ type: "auxo:ack", decisionId: result.verdict.decision_id })
          .catch(() => {});
      }
      return result;
    };

    const flow = createCartFlow({
      inspect: () => inspectAmazonPage(document, new URL(location.href)),
      hash: hashCart,
      requestVerdict,
      show: (verdict) => void show(verdict),
    });

    // The cart sidebar on product pages: removals are linked to the decision
    // about the item; + adds get a fresh decision.
    const miniCart = createMiniCartHandler({
      decisionFor: async (items) => {
        const message: DecisionForMessage = {
          type: "auxo:decision-for",
          items: items.map(({ name, price_minor }) => ({ name, price_minor })),
        };
        const result = await browser.runtime
          .sendMessage<DecisionForMessage, DecisionForResult>(message)
          .catch(() => null);
        return result?.decisionId ?? null;
      },
      sendEvent,
      decideAdded: async (draft: CartDraft, t: Trigger) => {
        const cartHash = await hashCart(draft);
        const result = await Promise.race([
          requestVerdict({ ...draft, cart_hash: cartHash }, t).catch((): DecideResult => ({ ok: false, reason: "network" })),
          new Promise<DecideResult>((resolve) => setTimeout(() => resolve({ ok: false, reason: "timeout" }), CONTENT_TIMEOUT_MS)),
        ]);
        record(
          result.ok
            ? { status: "shown", pageType: t.page_type, draft, cartHash, trigger: t, verdict: result.verdict }
            : { status: "failed_open", pageType: t.page_type, draft, cartHash, trigger: t, reason: result.reason },
        );
        refreshDebug();
        if (result.ok) void show(result.verdict);
      },
      pageType: () => inspectAmazonPage(document, new URL(location.href)).pageType,
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

    // An add to cart moves to a new page before it's answered; show that
    // answer here if the page that asked didn't get to.
    const claimHandoff = async () => {
      const claimed = await Promise.race([
        browser.runtime.sendMessage<ClaimMessage, ClaimResult>({ type: "auxo:claim" }).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), CONTENT_TIMEOUT_MS)),
      ]);
      const verdict = claimed?.verdict;
      if (!verdict || ctx.isInvalid) return;
      backend = {
        status: "verdict",
        lane: verdict.lane,
        decisionId: verdict.decision_id,
        templateId: verdict.template_id,
      };
      note = "answer to the add to cart on the previous page (handed over by the worker)";
      void show(verdict);
      refreshDebug();
    };

    step(async () => {
      await claimHandoff();
      await tracker.onLoad();
    })();
    const stopWatching = watchForChanges(document.body, step(() => tracker.onPageChange()), {
      debounceMs: RECHECK_DEBOUNCE_MS,
      ignore: () => [ui?.shadowHost, debugUi?.shadowHost],
    });
    // The cart and checkout pages track removals themselves (the tracker), so
    // the sidebar is only watched elsewhere, to avoid counting a removal twice.
    const loadedAs = inspectAmazonPage(document, new URL(location.href)).pageType;
    const stopMiniCart =
      loadedAs === "cart" || loadedAs === "checkout"
        ? () => {}
        : watchMiniCart(document, () => readAmazonMiniCart(document, new URL(location.href)).draft, {
            onChange: (before, after, diff) => void miniCart.onChange(before, after, diff),
          });
    const stopListening = listenForBuyIntents(document, { classifyClick, classifySubmit }, (signal) => {
      if (ctx.isInvalid) return;
      void tracker.onBuyIntent(signal);
    });

    ctx.onInvalidated(() => {
      stopWatching();
      stopMiniCart();
      stopListening();
      removeOverlay();
      debugUi?.remove();
    });
  },
});
