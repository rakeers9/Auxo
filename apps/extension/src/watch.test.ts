import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { watchForChanges } from "./watch";

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="cart"></div><div id="ours"></div>';
});

afterEach(() => {
  vi.useRealTimers();
});

// MutationObserver callbacks run as microtasks, so let them flush first.
async function flush(ms: number): Promise<void> {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(ms);
}

describe("watchForChanges", () => {
  it("runs once after a burst of changes settles", async () => {
    const run = vi.fn();
    const stop = watchForChanges(document.body, run, { debounceMs: 500 });

    const cart = document.getElementById("cart")!;
    cart.textContent = "1";
    await flush(200);
    cart.textContent = "2";
    await flush(200);
    expect(run).not.toHaveBeenCalled();

    await flush(500);
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });

  it("ignores changes inside our own overlay", async () => {
    const run = vi.fn();
    const ours = document.getElementById("ours")!;
    const stop = watchForChanges(document.body, run, { debounceMs: 500, ignore: () => [null, ours] });

    ours.textContent = "overlay tick";
    await flush(1_000);
    expect(run).not.toHaveBeenCalled();
    stop();
  });

  it("only counts changes inside the given regions", async () => {
    const run = vi.fn();
    document.body.innerHTML += '<div id="ad"></div>';
    const cart = document.getElementById("cart")!;
    const stop = watchForChanges(document.body, run, { debounceMs: 500, only: () => [cart] });

    document.getElementById("ad")!.textContent = "new ad";
    await flush(1_000);
    expect(run).not.toHaveBeenCalled();

    cart.textContent = "qty 2";
    await flush(1_000);
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });

  it("watches the whole page when the regions are null", async () => {
    const run = vi.fn();
    const stop = watchForChanges(document.body, run, { debounceMs: 500, only: () => null });

    document.getElementById("ours")!.textContent = "anything";
    await flush(1_000);
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops watching after stop()", async () => {
    const run = vi.fn();
    const stop = watchForChanges(document.body, run, { debounceMs: 500 });

    document.getElementById("cart")!.textContent = "1";
    stop();
    await flush(1_000);
    expect(run).not.toHaveBeenCalled();
  });
});
