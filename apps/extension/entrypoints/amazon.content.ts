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
  WishlistSaveMessage,
} from "../src/messages";
import { renderClickAgainHint, renderOverlay, type OverlayHandle } from "../src/overlay";
import { createClickGate } from "../src/tracking/gate";
import { listenForBuyIntents } from "../src/tracking/listener";
import { createMiniCartHandler } from "../src/tracking/minicart-handler";
import { createPendingStore } from "../src/tracking/pending";
import { watchMiniCart } from "../src/tracking/sidesheet";
import { createTracker } from "../src/tracking/tracker";
import { watchForChanges } from "../src/watch";

const RECHECK_DEBOUNCE_MS = 500;

// Dev builds (`wxt` or `wxt build --mode development`) show the always-on
// debug panel instead of the overlay, to check what the extension reads, and
// block every known buy click so the click-again flow can be tried.
const DEBUG = import.meta.env.MODE === "development";

// Dev only: the answer used to block a click when the page has none yet.
// Never sent to the backend.
const DEV_VERDICT: Verdict = {
  decision_id: "00000000-0000-4000-8000-000000000000",
  lane: "L3",
  action: "block",
  template_id: "l3-block",
  cooldown_seconds: 5,
};

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
    let hintUi: ShadowRootContentScriptUi<OverlayHandle> | null = null;
    // Stops known buy clicks when this page's answer is "block" (always in dev).
    const gate = createClickGate({ alwaysOn: DEBUG, devVerdict: DEV_VERDICT });
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

    // Reader selector overrides from the backend config (set once it loads).
    let selectorOverrides: Record<string, string> | undefined;
    const inspect = () => inspectAmazonPage(document, new URL(location.href), selectorOverrides);

    const refreshDebug = () => {
      if (!debugUi?.mounted) return;
      const url = new URL(location.href);
      debugUi.mounted.update({
        url: url.href,
        inspection: inspectAmazonPage(document, url, selectorOverrides),
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

    // "Save for later" puts the decision's items on the wishlist (the worker
    // remembers which cart each decision was about).
    const saveForLater = (decisionId: string) => {
      void browser.runtime
        .sendMessage<WishlistSaveMessage>({ type: "auxo:wishlist-save", decisionId })
        .catch(() => console.info("[Auxo] not saved to the wishlist: worker unavailable"));
    };

    // Every exit is logged (design invariant: every override is recorded).
    // Continuing past an answer also lets the user's own next clicks through.
    const onExit = (verdict: Verdict, action: ExitAction) => {
      removeOverlay();
      if (action === "overrode") gate.override(verdict.decision_id);
      if (action === "saved") saveForLater(verdict.decision_id);
      sendEvent(buildExitEvent(verdict.decision_id, action));
    };

    const removeHint = () => {
      hintUi?.remove();
      hintUi = null;
    };

    // A known buy click was stopped. Show the pause for it; after Continue,
    // the user clicks the real button again themselves (never replayed).
    const showBlocked = async (verdict: Verdict, label: string, synthetic: boolean) => {
      removeOverlay();
      removeHint();
      const next = await createShadowRootUi(ctx, {
        name: "auxo-overlay",
        position: "inline",
        anchor: "body",
        onMount: (container) =>
          renderOverlay(
            container,
            verdict,
            {
              onExit: (action) => {
                removeOverlay();
                if (action === "overrode") {
                  gate.override(verdict.decision_id);
                  void showHint(label);
                }
                // The dev placeholder answer isn't a real decision.
                if (!synthetic) {
                  if (action === "saved") saveForLater(verdict.decision_id);
                  sendEvent(buildExitEvent(verdict.decision_id, action));
                }
                note = `click on "${label}" was stopped; user chose ${action}`;
                refreshDebug();
              },
            },
            { clicked: label },
          ),
        onRemove: (handle) => handle?.destroy(),
      });
      if (ctx.isInvalid) return;
      next.mount();
      ui = next;
    };

    const showHint = async (label: string) => {
      removeHint();
      const next = await createShadowRootUi(ctx, {
        name: "auxo-hint",
        position: "inline",
        anchor: "body",
        onMount: (container) => renderClickAgainHint(container, label, { onDismiss: removeHint }),
        onRemove: (handle) => handle?.destroy(),
      });
      if (ctx.isInvalid) return;
      next.mount();
      hintUi = next;
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
    selectorOverrides = overrides?.selectors;
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
          gate.setVerdict(outcome.verdict);
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
      inspect: () => inspect(),
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
      pageType: () => inspect().pageType,
    });

    const tracker = createTracker({
      flow,
      pending: createPendingStore(sessionStorageOrNull()),
      inspect: () => inspect(),
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
      gate.setVerdict(verdict);
      void show(verdict);
      refreshDebug();
    };

    step(async () => {
      await claimHandoff();
      await tracker.onLoad();
    })();
    const stopWatching = watchForChanges(document.body, step(() => tracker.onPageChange()), {
      debounceMs: RECHECK_DEBOUNCE_MS,
      ignore: () => [ui?.shadowHost, hintUi?.shadowHost, debugUi?.shadowHost],
    });
    // The cart and checkout pages track removals themselves (the tracker), so
    // the sidebar is only watched elsewhere, to avoid counting a removal twice.
    const loadedAs = inspect().pageType;
    const stopMiniCart =
      loadedAs === "cart" || loadedAs === "checkout"
        ? () => {}
        : watchMiniCart(document, () => readAmazonMiniCart(document, new URL(location.href), selectorOverrides).draft, {
            onChange: (before, after, diff) => void miniCart.onChange(before, after, diff),
          });
    // Known buttons can be overridden per store by the backend config.
    const stopListening = listenForBuyIntents(
      document,
      {
        classifyClick: (target, url) => classifyClick(target, url, overrides?.buttons),
        classifySubmit: (form, submitter, url) => classifySubmit(form, submitter, url, overrides?.buttons),
      },
      (signal) => {
        if (ctx.isInvalid) return;
        void tracker.onBuyIntent(signal);
      },
      undefined,
      undefined,
      {
        shouldBlock: (signal) => !ctx.isInvalid && gate.check(signal).block,
        onBlocked: (signal) => {
          const result = gate.check(signal);
          lastClick = { signal, at: new Date() };
          if (result.block) void showBlocked(result.verdict, signal.label ?? "", result.synthetic);
          refreshDebug();
        },
      },
    );

    ctx.onInvalidated(() => {
      stopWatching();
      stopMiniCart();
      stopListening();
      removeOverlay();
      removeHint();
      debugUi?.remove();
    });
  },
});
