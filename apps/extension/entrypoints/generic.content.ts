import { defineContentScript } from "wxt/utils/define-content-script";
import {
  createShadowRootUi,
  type ShadowRootContentScriptUi,
} from "wxt/utils/content-script-ui/shadow-root";

import { isCheckoutCandidate, isLikelyShopify, scoreCheckout } from "../src/cart";
import { createGenericCheckout, GENERIC_PAUSE_VERDICT, type GenericCheckoutReport } from "../src/content/generic";
import { createDebugPanel, type DebugPanel } from "../src/debug/panel";
import { renderOverlay, type OverlayHandle } from "../src/overlay";
import { watchForChanges } from "../src/watch";

const RECHECK_DEBOUNCE_MS = 500;

// Tier 2 (AUX-26): checkout detection on sites without a dedicated reader.
// DEV BUILDS ONLY (DEV_ONLY_ENTRYPOINTS in wxt.config.ts). Sreekar's
// decision: a detected checkout gets a local pause; nothing is sent to the
// backend. Amazon and Shopify stores have their own scripts.
export default defineContentScript({
  matches: ["https://*/*"],
  excludeMatches: ["https://www.amazon.com/*"],
  async main(ctx) {
    if (isLikelyShopify(document)) return;

    let pauseUi: ShadowRootContentScriptUi<OverlayHandle | null> | null = null;
    let debugUi: ShadowRootContentScriptUi<DebugPanel> | null = null;
    let checks = 0;

    const hidePause = () => {
      pauseUi?.remove();
      pauseUi = null;
    };

    const generic = createGenericCheckout({
      gate: isCheckoutCandidate,
      score: scoreCheckout,
      showPause: () => {
        void createShadowRootUi(ctx, {
          name: "auxo-overlay",
          position: "inline",
          anchor: "body",
          onMount: (container) =>
            renderOverlay(container, GENERIC_PAUSE_VERDICT, {
              onExit: (action) => {
                // Logged locally only: there's no backend decision to attach it to.
                console.info("[Auxo] generic checkout pause:", action);
                hidePause();
                generic.dismissed();
              },
            }),
          onRemove: (handle) => handle?.destroy(),
        }).then((ui) => {
          if (ctx.isInvalid) return;
          ui.mount();
          pauseUi = ui;
        });
      },
      hidePause,
      report: (report) => void showReport(report),
    });

    // The debug panel only appears on pages worth scoring, not on every site.
    const showReport = async (report: GenericCheckoutReport) => {
      if (!report.result && !debugUi) return;
      if (report.result) console.info("[Auxo] generic checkout score:", report.result);
      if (!debugUi) {
        debugUi = await createShadowRootUi(ctx, {
          name: "auxo-debug",
          position: "inline",
          anchor: "body",
          onMount: (container) => createDebugPanel(container),
          onRemove: (panel) => panel?.destroy(),
        });
        if (ctx.isInvalid) return;
        debugUi.mount();
      }
      debugUi.mounted?.update({
        url: report.url,
        inspection: {
          pageType: report.result?.pageType === "checkout" ? "checkout" : "other",
          draft: null,
          problems: [],
          details: {
            tier: "2 (generic checkout detector)",
            score: report.result ? String(report.result.score) : "not scored (gate said no)",
            signals: report.result?.signals.join(", ") || "none",
          },
        },
        cartHash: null,
        backend: { status: "not_asked" },
        checkedAt: new Date(),
        checks,
        note: report.paused ? "local pause shown; not sent to the backend (Tier 2)" : null,
      });
    };

    const check = () => {
      if (ctx.isInvalid) return;
      checks += 1;
      generic.check(document, new URL(location.href));
    };

    check();
    // Payment iframes are injected after load, so re-check as the page settles,
    // and on in-page navigation in single-page checkouts.
    const stop = watchForChanges(document.body, check, {
      debounceMs: RECHECK_DEBOUNCE_MS,
      ignore: () => [pauseUi?.shadowHost, debugUi?.shadowHost],
    });
    ctx.addEventListener(window, "wxt:locationchange", check);
    ctx.onInvalidated(() => {
      stop();
      hidePause();
      debugUi?.remove();
    });
  },
});
