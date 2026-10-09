import type { WishlistEntry } from "./store";

// What the popup needs from the wishlist store.
export interface WishlistSource {
  list(): Promise<WishlistEntry[]>;
  remove(id: string): Promise<WishlistEntry[]>;
}

export interface WishlistView {
  // Re-read the store and redraw if the list changed (e.g. the worker saved an item).
  refresh(): Promise<void>;
  destroy(): void;
}

const TITLE_ID = "auxo-wishlist-title";

// Renders the saved-items list into `root`. Text goes in with textContent
// only, so page-supplied names can never become markup.
export function renderWishlist(
  root: HTMLElement,
  store: WishlistSource,
  options: { now?: () => Date } = {},
): WishlistView {
  const now = options.now ?? (() => new Date());
  const doc = root.ownerDocument;
  let destroyed = false;
  // What's on screen, so a refresh that finds the same list leaves focus alone.
  let shown: string | null = null;

  const header = el(doc, "header", "auxo-header");
  header.append(el(doc, "h1", "auxo-brand", "Auxo"));

  const main = el(doc, "main", "auxo-main");
  const title = el(doc, "h2", "auxo-title", "Saved for later");
  title.id = TITLE_ID;
  title.tabIndex = -1; // focus target when the last item is removed
  const status = el(doc, "p", "auxo-status");
  status.setAttribute("role", "status");
  const body = el(doc, "div", "auxo-body");
  main.append(title, status, body);
  root.replaceChildren(header, main);

  const draw = (entries: WishlistEntry[]) => {
    shown = JSON.stringify(entries);
    if (entries.length === 0) {
      body.replaceChildren(
        el(doc, "p", "auxo-empty", "Nothing saved yet. Items you save for later instead of buying show up here."),
      );
      return;
    }
    const list = el(doc, "ul", "auxo-list");
    list.setAttribute("aria-labelledby", TITLE_ID);
    list.append(...entries.map((entry) => drawItem(entry)));
    body.replaceChildren(list);
  };

  const drawItem = (entry: WishlistEntry): HTMLLIElement => {
    const li = el(doc, "li", "auxo-item");
    li.dataset.id = entry.id;

    const href = safeHref(entry.url);
    let name: HTMLElement;
    if (href) {
      const link = el(doc, "a", "auxo-name", entry.name);
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      name = link;
    } else {
      name = el(doc, "span", "auxo-name", entry.name);
    }

    const meta = el(doc, "p", "auxo-meta");
    const price = formatMoney(entry.price_minor, entry.currency);
    const time = el(doc, "time", "auxo-saved", formatSavedAt(entry.saved_at, now()));
    time.dateTime = entry.saved_at;
    meta.append(
      el(doc, "span", "auxo-store", entry.merchant),
      " · ",
      el(doc, "span", "auxo-price", entry.qty > 1 ? `${price} × ${entry.qty}` : price),
      " · ",
      time,
    );

    const remove = el(doc, "button", "auxo-remove", "Remove");
    remove.type = "button";
    remove.dataset.action = "remove";
    remove.setAttribute("aria-label", `Remove ${entry.name}`);
    remove.addEventListener("click", () => void onRemove(entry, remove));

    li.append(name, meta, remove);
    return li;
  };

  const onRemove = async (entry: WishlistEntry, button: HTMLButtonElement) => {
    button.disabled = true;
    // Where focus goes once this item is gone: the next item's button, else the previous one's.
    const buttons = [...body.querySelectorAll<HTMLButtonElement>('button[data-action="remove"]')];
    const index = buttons.indexOf(button);
    const neighborId = (buttons[index + 1] ?? buttons[index - 1])?.closest("li")?.dataset.id;

    // The store never throws; a failed write returns the list unchanged.
    const entries = await store.remove(entry.id).catch(() => null);
    if (destroyed) return;
    if (!entries || entries.some((saved) => saved.id === entry.id)) {
      button.disabled = false;
      status.textContent = `Couldn't remove ${entry.name}. Try again.`;
      return;
    }
    draw(entries);
    status.textContent = `Removed ${entry.name}.`;
    const next = neighborId
      ? [...body.querySelectorAll<HTMLLIElement>("li")].find((li) => li.dataset.id === neighborId)
      : undefined;
    (next?.querySelector<HTMLButtonElement>('button[data-action="remove"]') ?? title).focus();
  };

  const refresh = async () => {
    let entries: WishlistEntry[];
    try {
      entries = await store.list();
    } catch {
      entries = [];
    }
    if (!destroyed && JSON.stringify(entries) !== shown) draw(entries);
  };

  body.replaceChildren(el(doc, "p", "auxo-loading", "Loading…"));
  void refresh();

  return {
    refresh,
    destroy() {
      destroyed = true;
      root.replaceChildren();
    },
  };
}

// 999, "USD" → "$9.99". Uses the currency's own number of minor digits
// (e.g. none for JPY). For display only, never for money math.
export function formatMoney(minor: number, currency: string): string {
  try {
    const format = new Intl.NumberFormat("en-US", { style: "currency", currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(minor / 10 ** digits);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

// "just now", "5 minutes ago", "yesterday", "3 days ago"; a date after 30 days.
export function formatSavedAt(savedAt: string, now: Date): string {
  const then = new Date(savedAt);
  if (Number.isNaN(then.getTime())) return "";
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return RELATIVE.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return RELATIVE.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 30) return RELATIVE.format(-days, "day");
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Only http(s) links are shown as links; anything else (javascript:, data:)
// is shown as plain text.
export function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
