// Calls `run` once things settle after the page changes. Amazon updates the
// cart in place (quantity changes, save for later), so the cart is re-read
// after each burst of DOM mutations. Mutations inside the `ignore` nodes (our
// own overlay and debug panel) don't count. Returns a function that stops watching.
export function watchForChanges(
  target: Node,
  run: () => void,
  options: {
    debounceMs: number;
    ignore?: () => Array<Node | null | undefined>;
    // When given and non-null, only changes inside these nodes count (e.g. the
    // cart area, so ad and carousel redraws don't re-check the cart). null
    // means "the whole page", e.g. while the cart hasn't rendered yet.
    only?: () => Array<Node | null | undefined> | null;
  },
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const observer = new MutationObserver((mutations) => {
    const ignored = (options.ignore?.() ?? []).filter((node): node is Node => node != null);
    const isOurs = (target: Node) => ignored.some((node) => node.contains(target));
    if (ignored.length > 0 && mutations.every((mutation) => isOurs(mutation.target))) return;
    const regions = options.only?.();
    if (regions) {
      const inside = regions.filter((node): node is Node => node != null);
      if (!mutations.some((mutation) => inside.some((node) => node.contains(mutation.target)))) return;
    }

    clearTimeout(timer);
    timer = setTimeout(run, options.debounceMs);
  });
  observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });

  return () => {
    observer.disconnect();
    clearTimeout(timer);
  };
}
