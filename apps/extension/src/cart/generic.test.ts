import { beforeAll, describe, expect, it } from "vitest";

import { CHECKOUT_THRESHOLD, isCheckoutCandidate, scoreCheckout } from "./generic";

// These fixtures contain real payment iframes; happy-dom would otherwise try to
// load their src over the network. Tests must stay offline.
beforeAll(() => {
  const settings = (globalThis as { happyDOM?: { settings: { navigation: { disableChildFrameNavigation: boolean } } } }).happyDOM?.settings;
  if (settings) settings.navigation.disableChildFrameNavigation = true;
});
// Real rendered pages (headless Chrome), sanitized: structure, form fields,
// iframe origin + path, button and link labels, and money amounts only.
import stripeDemoHtml from "./__fixtures__/generic/stripe-payments-demo-checkout.html?raw";
import stripeDocsHtml from "./__fixtures__/generic/stripe-docs-accept-a-payment.html?raw";
import adyenDocsHtml from "./__fixtures__/generic/adyen-docs-integration.html?raw";
import githubLoginHtml from "./__fixtures__/generic/github-login.html?raw";
import baymardBlogHtml from "./__fixtures__/generic/baymard-blog-checkout.html?raw";
import wikimediaDonateHtml from "./__fixtures__/generic/wikimedia-donate.html?raw";
// Earlier real fixtures, as more negatives.
import amazonCartHtml from "./__fixtures__/amazon-cart.html?raw";
import amazonProductHtml from "./__fixtures__/amazon-product.html?raw";
import shopifyHintsHtml from "./__fixtures__/shopify/allbirds-product-hints.html?raw";

const DEMO_URL = new URL("https://stripe-payments-demo.appspot.com/");

function parse(html: string, url?: URL): Document {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (url) {
    const base = doc.createElement("base");
    base.href = url.href;
    doc.head.prepend(base);
  }
  return doc;
}

describe("scoreCheckout on a real checkout", () => {
  it("detects the Stripe Payments Demo: card frame + address fields + Pay button", () => {
    const result = scoreCheckout(parse(stripeDemoHtml, DEMO_URL), DEMO_URL);
    expect(result).toEqual({
      pageType: "checkout",
      score: 7,
      signals: ["payment_frame", "address_fields", "place_order_button"],
    });
  });

  it("passes the cheap gate there", () => {
    expect(isCheckoutCandidate(parse(stripeDemoHtml, DEMO_URL), DEMO_URL)).toBe(true);
  });
});

describe("scoreCheckout never flags real non-checkout pages", () => {
  it.each<[string, string, string]>([
    ["Stripe docs (loads Stripe's controller frames, talks about payments)", stripeDocsHtml, "https://docs.stripe.com/payments/accept-a-payment"],
    ["Adyen docs (checkout API pages)", adyenDocsHtml, "https://docs.adyen.com/online-payments/build-your-integration/"],
    ["a login page with a password field", githubLoginHtml, "https://github.com/login"],
    ["a blog post about checkout, with checkout in its URL", baymardBlogHtml, "https://baymard.com/blog/checkout-flow-average-form-fields"],
    ["a donation page", wikimediaDonateHtml, "https://donate.wikimedia.org/w/index.php"],
    ["an Amazon cart page (Proceed to checkout, /cart URL)", amazonCartHtml, "https://www.amazon.com/gp/cart/view.html"],
    ["an Amazon product page", amazonProductHtml, "https://www.amazon.com/dp/B0TEST0005"],
    ["a Shopify product page", shopifyHintsHtml, "https://www.allbirds.com/products/x"],
  ])("%s", (_label, html, href) => {
    const url = new URL(href);
    expect(scoreCheckout(parse(html, url), url).pageType).toBe("other");
  });

  it("Stripe's docs page has Stripe frames, but none are payment fields", () => {
    const url = new URL("https://docs.stripe.com/payments/accept-a-payment");
    const doc = parse(stripeDocsHtml, url);
    expect(doc.querySelectorAll('iframe[src*="js.stripe.com"]').length).toBeGreaterThan(0);
    expect(scoreCheckout(doc, url).signals).not.toContain("payment_frame");
  });

  it("the cheap gate already stops the login, docs, donation, and product pages", () => {
    for (const [html, href] of [
      [githubLoginHtml, "https://github.com/login"],
      [adyenDocsHtml, "https://docs.adyen.com/online-payments/build-your-integration/"],
      [wikimediaDonateHtml, "https://donate.wikimedia.org/w/index.php"],
      [amazonProductHtml, "https://www.amazon.com/dp/B0TEST0005"],
    ] as const) {
      const url = new URL(href);
      expect(isCheckoutCandidate(parse(html, url), url)).toBe(false);
    }
  });
});

describe("the scoring rules", () => {
  // Minimal pages built from the grounded signal shapes, to pin each rule.
  const page = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;
  const STRIPE_CARD = '<iframe name="__privateStripeFrame1" src="https://js.stripe.com/v3/elements-inner-card-abc.html" title="Secure card payment input frame"></iframe>';
  const BRAINTREE = '<iframe name="braintree-hosted-field-number" src="https://assets.braintreegateway.com/web/3.100.0/html/hosted-fields-frame.min.html"></iframe>';
  const ADYEN = '<iframe src="https://checkoutshopper-live.cdn.adyen.com/checkoutshopper/securedfields/live_KEY/6.3.0/securedFields.html"></iframe>';
  const ADDRESS = '<input name="address"><input name="postal_code">';
  const PLACE = "<button>Place your order</button>";
  const SHOP = new URL("https://shop.example.com/checkout");

  it.each([
    ["Stripe card frame", STRIPE_CARD],
    ["Braintree hosted field", BRAINTREE],
    ["Adyen secured field", ADYEN],
    ["card autocomplete fields", '<input autocomplete="cc-number"><input autocomplete="cc-exp">'],
  ])("counts a %s as a payment signal", (_label, payment) => {
    const result = scoreCheckout(parse(page(payment + ADDRESS + PLACE)), SHOP);
    expect(result.pageType).toBe("checkout");
  });

  it("ignores Stripe's controller and metrics frames", () => {
    const frames = '<iframe name="__privateStripeController1" src="https://js.stripe.com/v3/controller-with-preconnect-x.html"></iframe><iframe name="__privateStripeMetricsController1" src="https://js.stripe.com/v3/m-outer-x.html"></iframe>';
    expect(scoreCheckout(parse(page(frames + ADDRESS + PLACE)), SHOP).pageType).toBe("other");
  });

  it("never flags a page without a payment signal, however checkout-like", () => {
    const result = scoreCheckout(parse(page(`${ADDRESS}<input autocomplete="street-address">${PLACE} <span>$49.99</span>`)), SHOP);
    expect(result.pageType).toBe("other");
    expect(result.score).toBeGreaterThanOrEqual(CHECKOUT_THRESHOLD);
  });

  it("needs more than a payment signal alone", () => {
    expect(scoreCheckout(parse(page(STRIPE_CARD)), new URL("https://shop.example.com/")).pageType).toBe("other");
    // Payment + URL keyword is still only 4.
    expect(scoreCheckout(parse(page(STRIPE_CARD)), SHOP)).toMatchObject({ pageType: "other", score: 4 });
  });

  it("never flags a donation form, even with card fields", () => {
    const body = STRIPE_CARD + ADDRESS + "<button>Donate $25</button>";
    expect(scoreCheckout(parse(page(body)), new URL("https://charity.example.org/give")).pageType).toBe("other");
    expect(scoreCheckout(parse(page(STRIPE_CARD + ADDRESS + PLACE)), new URL("https://charity.example.org/donate")).pageType).toBe("other");
  });

  it("adds a point for a total near the button, but not one only elsewhere on the page", () => {
    const near = scoreCheckout(parse(page(`${STRIPE_CARD}<form><p>Total: $49.99</p>${PLACE}</form>`)), SHOP);
    expect(near.signals).toContain("total_near_button");
    const far = scoreCheckout(parse(page(`<p>Total: $49.99</p><div><div><div><div><div>${STRIPE_CARD}${PLACE}</div></div></div></div></div>`)), SHOP);
    expect(far.signals).not.toContain("total_near_button");
  });

  it("matches place-order labels as whole phrases", () => {
    for (const label of ["Pay", "Pay €15.98", "Place order", "Complete purchase", "Submit order"]) {
      expect(scoreCheckout(parse(page(`${STRIPE_CARD}<button>${label}</button>`)), SHOP).signals).toContain("place_order_button");
    }
    for (const label of ["Payment methods", "Pay later options", "Order history", "Repay loan"]) {
      expect(scoreCheckout(parse(page(`${STRIPE_CARD}<button>${label}</button>`)), SHOP).signals).not.toContain("place_order_button");
    }
  });

  it("reads URL keywords as path segments only", () => {
    const blank = parse(page(""));
    for (const path of ["/checkout", "/checkouts/c/123", "/cart", "/shop/basket", "/bag/", "/en/checkout.html"]) {
      expect(isCheckoutCandidate(blank, new URL(`https://shop.example.com${path}`))).toBe(true);
    }
    for (const path of ["/", "/blog/cartography", "/products/handbag", "/search", "/carts-and-wagons-guide"]) {
      expect(isCheckoutCandidate(blank, new URL(`https://shop.example.com${path}`))).toBe(false);
    }
  });
});

describe("the cheap gate's cost", () => {
  it("rejects a large real page in well under a millisecond on average", () => {
    const url = new URL("https://docs.adyen.com/online-payments/build-your-integration/");
    const doc = parse(adyenDocsHtml, url);
    const runs = 500;
    const start = performance.now();
    for (let i = 0; i < runs; i++) isCheckoutCandidate(doc, url);
    const perRun = (performance.now() - start) / runs;
    // Generous bound for slow CI; typical is a few microseconds.
    expect(perRun).toBeLessThan(1);
  });
});
