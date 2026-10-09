import { beforeAll, describe, expect, it, vi } from "vitest";

import { isCheckoutCandidate, scoreCheckout, type CheckoutScore } from "../cart";
import { createGenericCheckout, GENERIC_PAUSE_VERDICT, type GenericCheckoutDeps } from "./generic";
// Real rendered pages, sanitized (see src/cart/generic.test.ts).
import stripeDemoHtml from "../cart/__fixtures__/generic/stripe-payments-demo-checkout.html?raw";
import stripeDocsHtml from "../cart/__fixtures__/generic/stripe-docs-accept-a-payment.html?raw";
import baymardBlogHtml from "../cart/__fixtures__/generic/baymard-blog-checkout.html?raw";
import wikimediaDonateHtml from "../cart/__fixtures__/generic/wikimedia-donate.html?raw";
import githubLoginHtml from "../cart/__fixtures__/generic/github-login.html?raw";

// The fixtures hold real payment iframes; keep happy-dom from loading them.
beforeAll(() => {
  const settings = (globalThis as { happyDOM?: { settings: { navigation: { disableChildFrameNavigation: boolean } } } }).happyDOM?.settings;
  if (settings) settings.navigation.disableChildFrameNavigation = true;
});

const checkout: CheckoutScore = { pageType: "checkout", score: 7, signals: ["payment_frame", "address_fields", "place_order_button"] };
const other: CheckoutScore = { pageType: "other", score: 1, signals: [] };

function setup(score: (url: URL) => CheckoutScore = () => checkout, gate: (url: URL) => boolean = () => true) {
  const deps = {
    gate: vi.fn((_doc: Document, url: URL) => gate(url)),
    score: vi.fn((_doc: Document, url: URL) => score(url)),
    showPause: vi.fn(),
    hidePause: vi.fn(),
    report: vi.fn(),
  } satisfies GenericCheckoutDeps;
  return { deps, g: createGenericCheckout(deps) };
}

const at = (href: string) => new URL(href);

describe("createGenericCheckout", () => {
  it("pauses a page that scores as a checkout, once per checkout path", () => {
    const { deps, g } = setup();
    g.check(document, at("https://shop.example/checkout?step=1"));
    g.check(document, at("https://shop.example/checkout?step=2"));

    expect(deps.showPause).toHaveBeenCalledTimes(1);
    expect(deps.report).toHaveBeenLastCalledWith({ url: "https://shop.example/checkout?step=2", result: checkout, paused: true });
  });

  it("never scores when the cheap gate says no, and never pauses", () => {
    const { deps, g } = setup(() => checkout, () => false);
    g.check(document, at("https://blog.example/post"));

    expect(deps.score).not.toHaveBeenCalled();
    expect(deps.showPause).not.toHaveBeenCalled();
    expect(deps.report).toHaveBeenCalledWith({ url: "https://blog.example/post", result: null, paused: false });
  });

  it("doesn't pause pages that score as other", () => {
    const { deps, g } = setup(() => other);
    g.check(document, at("https://shop.example/account"));
    expect(deps.showPause).not.toHaveBeenCalled();
  });

  it("closes the pause when a single-page app leaves the checkout", () => {
    const { deps, g } = setup((url) => (url.pathname === "/checkout" ? checkout : other));
    g.check(document, at("https://shop.example/checkout"));
    g.check(document, at("https://shop.example/thanks"));

    expect(deps.hidePause).toHaveBeenCalledTimes(1);
  });

  it("doesn't re-open a pause the user answered for that checkout", () => {
    const { deps, g } = setup();
    g.check(document, at("https://shop.example/checkout"));
    g.dismissed();
    g.check(document, at("https://shop.example/checkout"));

    expect(deps.showPause).toHaveBeenCalledTimes(1);
  });

  it("a detector error never pauses", () => {
    const { deps, g } = setup(() => {
      throw new Error("bug");
    });
    g.check(document, at("https://shop.example/checkout"));

    expect(deps.showPause).not.toHaveBeenCalled();
    expect(deps.report).toHaveBeenCalledWith(expect.objectContaining({ result: null, paused: false }));
  });

  it("uses a local pause answer that is never a backend decision", () => {
    expect(GENERIC_PAUSE_VERDICT).toMatchObject({ lane: "L2", action: "pause", cooldown_seconds: 15 });
  });
});

// The controller wired to the real detector, the way the dev content script
// wires it (gate: isCheckoutCandidate, score: scoreCheckout).
describe("createGenericCheckout with the real detector", () => {
  function parse(html: string, url: URL): Document {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const base = doc.createElement("base");
    base.href = url.href;
    doc.head.prepend(base);
    return doc;
  }

  function real() {
    const deps = {
      gate: isCheckoutCandidate,
      score: scoreCheckout,
      showPause: vi.fn(),
      hidePause: vi.fn(),
      report: vi.fn(),
    } satisfies GenericCheckoutDeps;
    return { deps, g: createGenericCheckout(deps) };
  }

  it("pauses the real Stripe Payments Demo checkout, and reports why", () => {
    const { deps, g } = real();
    const url = new URL("https://stripe-payments-demo.appspot.com/");
    g.check(parse(stripeDemoHtml, url), url);

    expect(deps.showPause).toHaveBeenCalledTimes(1);
    const report = deps.report.mock.calls[0]?.[0];
    expect(report).toMatchObject({ paused: true, result: { pageType: "checkout" } });
    expect(report?.result?.signals).toContain("payment_frame");
  });

  it.each([
    ["Stripe's docs (Stripe frames, no payment fields)", stripeDocsHtml, "https://docs.stripe.com/payments/accept-a-payment"],
    ["a blog post with checkout in its URL", baymardBlogHtml, "https://baymard.com/blog/checkout-flow-average-form-fields"],
    ["a donation page", wikimediaDonateHtml, "https://donate.wikimedia.org/w/index.php"],
    ["a login page", githubLoginHtml, "https://github.com/login"],
  ])("never pauses %s", (_label, html, href) => {
    const { deps, g } = real();
    const url = new URL(href);
    g.check(parse(html, url), url);
    expect(deps.showPause).not.toHaveBeenCalled();
    expect(deps.report.mock.calls[0]?.[0]).toMatchObject({ paused: false });
  });

  it("catches a payment frame injected after load (why the script re-checks on page changes)", () => {
    const { deps, g } = real();
    const url = new URL("https://shop.example.com/order");
    const doc = parse(
      '<!doctype html><html><head></head><body><form><input name="address"><input name="postal_code"><p>Total: $49.99</p><button>Place order</button></form></body></html>',
      url,
    );

    g.check(doc, url);
    expect(deps.report.mock.calls[0]?.[0]).toMatchObject({ result: null, paused: false });

    // The payment provider's script adds its card frame a moment later.
    const frame = doc.createElement("iframe");
    frame.name = "__privateStripeFrame1";
    frame.src = "https://js.stripe.com/v3/elements-inner-card-abc.html";
    doc.querySelector("form")?.prepend(frame);
    g.check(doc, url);

    expect(deps.showPause).toHaveBeenCalledTimes(1);
    expect(deps.report.mock.calls[1]?.[0]).toMatchObject({ paused: true, result: { pageType: "checkout" } });
  });
});
