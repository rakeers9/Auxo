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
    const stop = watchForChanges(document.body, run, { debounceMs: 500, ignore: () => ours });

    ours.textContent = "overlay tick";
    await flush(1_000);
    expect(run).not.toHaveBeenCalled();
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
