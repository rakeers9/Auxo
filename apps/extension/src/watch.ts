// Calls `run` once things settle after the page changes. Amazon updates the
// cart in place (quantity changes, save for later), so the cart is re-read
// after each burst of DOM mutations. Mutations inside the `ignore` nodes (our
// own overlay and debug panel) don't count. Returns a function that stops watching.
export function watchForChanges(
  target: Node,
  run: () => void,
  options: { debounceMs: number; ignore?: () => Array<Node | null | undefined> },
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const observer = new MutationObserver((mutations) => {
    const ignored = (options.ignore?.() ?? []).filter((node): node is Node => node != null);
    const isOurs = (target: Node) => ignored.some((node) => node.contains(target));
    if (ignored.length > 0 && mutations.every((mutation) => isOurs(mutation.target))) return;

    clearTimeout(timer);
    timer = setTimeout(run, options.debounceMs);
  });
  observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });

  return () => {
    observer.disconnect();
    clearTimeout(timer);
  };
}
