import { describe, expect, it, vi } from "vitest";

import { createGenericCheckout, GENERIC_PAUSE_VERDICT, type CheckoutScore, type GenericCheckoutDeps } from "./generic";

const checkout: CheckoutScore = { pageType: "checkout", score: 9, signals: ["payment iframe", "place order near total"] };
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
