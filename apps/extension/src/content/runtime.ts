import { REDUCING_INTENTS, type Cart, type DecisionEvent, type StoreOverrides, type Trigger, type UserAction, type Verdict } from "@auxo/shared";
import { browser } from "wxt/browser";
import {
  createShadowRootUi,
  type ShadowRootContentScriptUi,
} from "wxt/utils/content-script-ui/shadow-root";
import type { ContentScriptContext } from "wxt/utils/content-script-context";

import { buildExitEvent } from "../api/events";
import { hashCart } from "../cart";
import { createDebugPanel, type BackendStatus, type DebugPanel } from "../debug/panel";
import { CONTENT_TIMEOUT_MS, createCartFlow, type CartFlowOutcome } from "../flow";
import type {
  AckMessage,
  CartDraft,
  CartLoadMessage,
  CartLoadResult,
  CartRecordMessage,
  ClaimMessage,
  ClaimResult,
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
  PageInspection,
  PageType,
  WishlistSaveMessage,
} from "../messages";
import { renderClickAgainHint, renderOverlay, type OverlayHandle } from "../overlay";
import { createClickGate } from "../tracking/gate";
import { listenForBuyIntents } from "../tracking/listener";
import { createMiniCartHandler } from "../tracking/minicart-handler";
import type { MiniCartDiff } from "../tracking/sidesheet";
import { createPendingStore } from "../tracking/pending";
import { createTracker } from "../tracking/tracker";

// Dev builds (`wxt` or `wxt build --mode development`) show the always-on
// debug panel instead of the overlay, to check what the extension reads, and
// block every known buy click so the click-again flow can be tried.
export const DEBUG = import.meta.env.MODE === "development";

// Dev only: the answer used to block a click when the page has none yet.
// Never sent to the backend.
const DEV_VERDICT: Verdict = {
  decision_id: "00000000-0000-4000-8000-000000000000",
  lane: "L3",
  action: "block",
  template_id: "l3-block",
  cooldown_seconds: 5,
};

export interface WatchApi {
  // Re-check the page through the tracker (re-decide on change, removals).
  onPageChange(): void;
  // A full cart (sidebar or network) changed: removals and adds are asked
  // about, and the new cart is recorded for other tabs.
  reportChange(before: CartDraft, after: CartDraft, diff: MiniCartDiff): void;
  overrides: StoreOverrides | null;
  loadedAs: PageType;
  // Our own UI, which must never count as a page change.
  ignore(): Array<Node | null | undefined>;
}

// What differs between stores. Everything else (decisions, the overlay, the
// click gate, events, the wishlist, the debug panel) is shared.
export interface StoreAdapter {
  inspect(overrides: StoreOverrides | null): PageInspection | Promise<PageInspection>;
  // A synchronous reading for the debug panel, if the store can do one.
  panelInspection?(overrides: StoreOverrides | null): PageInspection;
  // The store's cart sidebar, for the debug panel (null when there's none).
  panelSidebar?(overrides: StoreOverrides | null): { draft: CartDraft | null; problems: string[] } | null;
  classifyClick(target: EventTarget | null, url: URL, overrides: StoreOverrides | null): ClickSignal | null;
  classifySubmit(form: HTMLFormElement, submitter: Element | null, url: URL, overrides: StoreOverrides | null): ClickSignal | null;
  // Quantity boxes and dropdowns change without a click.
  classifyChange?(target: EventTarget | null, url: URL, overrides: StoreOverrides | null): ClickSignal | null;
  // Start noticing page and cart changes; returns a function that stops.
  watch(api: WatchApi): () => void;
  // The whole cart as this page shows it (not one product), if it can tell.
  // Compared at load with the last cart any tab saw, to catch changes made
  // elsewhere (another tab, the app).
  fullCart?(overrides: StoreOverrides | null): CartDraft | null | Promise<CartDraft | null>;
}

// Clicks whose effect shows up as a cart change (sidebar or /cart.js).
const EDIT_CLICK_INTENTS = new Set<ClickSignal["intent"]>([
  "add_to_cart",
  "increase_qty",
  "decrease_qty",
  "remove_item",
  "save_for_later",
]);
const REDUCING = new Set<string>(REDUCING_INTENTS);

function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export async function startStore(ctx: ContentScriptContext, adapter: StoreAdapter): Promise<void> {
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
  let sidebarChange: string | null = null;
  const events: Array<{ action: UserAction; decisionId: string; at: Date }> = [];

  // The backend's overrides for this store (set once the config loads).
  let overrides: StoreOverrides | null = null;
  // The last reading, for the debug panel (network-read stores can't be
  // read synchronously).
  let lastInspection: PageInspection = { pageType: "other", draft: null, problems: ["not read yet"] };
  // Stays synchronous when the store's reader is (Amazon), so the tracker can
  // save a navigating click before the page moves on.
  const inspect = (): PageInspection | Promise<PageInspection> => {
    const result = adapter.inspect(overrides);
    if (result instanceof Promise) {
      return result.then((reading) => {
        lastInspection = reading;
        return reading;
      });
    }
    lastInspection = result;
    return result;
  };

  const refreshDebug = () => {
    if (!debugUi?.mounted) return;
    const url = new URL(location.href);
    debugUi.mounted.update({
      url: url.href,
      inspection: adapter.panelInspection?.(overrides) ?? lastInspection,
      cartHash,
      backend,
      checkedAt: new Date(),
      checks,
      trigger,
      lastClick,
      events,
      pendingPurchase,
      note,
      sidebar: adapter.panelSidebar
        ? { reading: adapter.panelSidebar(overrides), lastChange: sidebarChange }
        : null,
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

  const show = async (verdict: Verdict, trigger?: Trigger) => {
    removeOverlay();
    if (DEBUG) return; // the debug panel shows the verdict instead
    if (verdict.lane === "L0") return; // silent pass
    // Putting things back is recorded, never paused. A repeat of the same
    // cart doesn't re-open a pause the user already answered. A place-order
    // click that got this far already passed the click gate.
    if (trigger && (REDUCING.has(trigger.intent) || trigger.same_cart || trigger.intent === "place_order")) return;

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
  overrides = await Promise.race([
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
    show: (verdict, t) => void show(verdict, t),
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
    decide: async (draft: CartDraft, t: Trigger) => {
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
      // On the cart and checkout pages, the whole-cart check right after the
      // edit is the one shown; the edit itself is recorded only.
      const onCartPage = t.page_type === "cart" || t.page_type === "checkout";
      if (result.ok && !onCartPage) void show(result.verdict, t);
      return result.ok ? result.verdict.decision_id : null;
    },
    pageType: () => lastInspection.pageType,
    report: (r) => {
      const items = (list: typeof r.removed) => list.map((i) => `${i.name} \u00d7${i.qty}`).join(", ");
      const parts: string[] = [];
      if (r.removed.length > 0) {
        parts.push(
          `${r.removeIntent ?? "removed"} ${items(r.removed)}: asked the backend; ${
            r.removedEventDecision ? `"removed" sent (decision ${r.removedEventDecision})` : `"removed" not sent (backend unreachable)`
          }; precursor ${r.linkedDecision ?? "none"}`,
        );
      }
      if (r.added.length > 0) {
        parts.push(
          r.askedAbout.length > 0
            ? `${r.addIntent ?? "added"} ${items(r.askedAbout)}: asked the backend`
            : `added ${items(r.added)}: already decided at the click`,
        );
      }
      sidebarChange = `${new Date().toLocaleTimeString()} ${parts.join("; ")}`;
      refreshDebug();
    },
  });

  // Every change this tab reports goes through here: asked about, then the
  // new cart is recorded so another tab's next load doesn't report it again.
  const reportCartChange = async (
    before: CartDraft,
    after: CartDraft,
    diff: MiniCartDiff,
    options: { source?: string; label?: string } = {},
  ) => {
    await miniCart.onChange(before, after, diff, options);
    void browser.runtime
      .sendMessage<CartRecordMessage>({ type: "auxo:cart-record", merchant: after.merchant, cart: after })
      .catch(() => {});
  };

  // At load: was the cart changed somewhere Auxo didn't see (another tab,
  // the app)? Only fresh page loads are compared; a re-read of an old page
  // would be stale.
  const checkElsewhere = async () => {
    const cart = await Promise.resolve(adapter.fullCart?.(overrides) ?? null).catch(() => null);
    if (!cart || ctx.isInvalid) return;
    const result = await browser.runtime
      .sendMessage<CartLoadMessage, CartLoadResult>({ type: "auxo:cart-load", merchant: cart.merchant, cart })
      .catch(() => null);
    const change = result?.change;
    if (!change) return;
    if (change.diff.repriced.length > 0) {
      note = `prices changed since last seen: ${change.diff.repriced
        .map((r) => `${r.name} ${r.before_minor}\u2192${r.after_minor}`)
        .join(", ")}`;
      refreshDebug();
    }
    if (change.diff.removed.length === 0 && change.diff.added.length === 0) return;
    await miniCart.onChange(
      change.before,
      change.after,
      { removed: change.diff.removed, added: change.diff.added },
      { source: "elsewhere", label: "changed outside this tab" },
    );
  };

  const tracker = createTracker({
    flow,
    pending: createPendingStore(sessionStorageOrNull()),
    inspect: () => inspect(),
    // Cart and checkout page edits are handled like sidebar edits.
    onCartDiff: (before, after, diff) => reportCartChange(before, after, diff, { source: "cart_page" }),
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
    await checkElsewhere();
  })();
  const stopWatching = adapter.watch({
    onPageChange: step(() => tracker.onPageChange()),
    reportChange: (before, after, diff) => void reportCartChange(before, after, diff),
    overrides,
    loadedAs: (await inspect()).pageType,
    ignore: () => [ui?.shadowHost, hintUi?.shadowHost, debugUi?.shadowHost],
  });
  // Known buttons can be overridden per store by the backend config.
  const stopListening = listenForBuyIntents(
    document,
    {
      classifyClick: (target, url) => adapter.classifyClick(target, url, overrides),
      classifySubmit: (form, submitter, url) => adapter.classifySubmit(form, submitter, url, overrides),
      classifyChange: (target, url) => adapter.classifyChange?.(target, url, overrides) ?? null,
    },
    (signal) => {
      if (ctx.isInvalid) return;
      if (EDIT_CLICK_INTENTS.has(signal.intent)) miniCart.noteEditClick(signal);
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
    stopListening();
    removeOverlay();
    removeHint();
    debugUi?.remove();
  });
}
