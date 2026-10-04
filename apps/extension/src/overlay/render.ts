import type { Verdict } from "@auxo/shared";

import type { ExitAction } from "../messages";
import { OVERLAY_CSS } from "./styles";
import { resolveTemplate, type OverlayTemplate } from "./templates";

export interface OverlayHandlers {
  onExit(action: ExitAction): void;
}

export interface OverlayHandle {
  destroy(): void;
}

// How often the countdown re-reads the clock. The remaining time comes from a
// fixed deadline, so throttled timers in background tabs only delay the update,
// never shorten the cooldown.
const TICK_MS = 250;

let idCounter = 0;

// Renders the overlay for a verdict into `root` (a shadow root in production).
// Returns null for L0, which shows nothing.
export function renderOverlay(
  root: ShadowRoot | HTMLElement,
  verdict: Verdict,
  handlers: OverlayHandlers,
): OverlayHandle | null {
  const template = resolveTemplate(verdict);
  if (template.kind === "none") return null;

  const doc = root.ownerDocument ?? document;
  const style = doc.createElement("style");
  style.textContent = OVERLAY_CSS;
  const container = doc.createElement("div");
  container.className = "auxo-overlay";
  container.dataset.lane = template.lane;
  container.dataset.template = template.id;

  const stops: Array<() => void> = [];
  const view: View = { doc, container, template, handlers, stops };

  if (template.kind === "banner") renderBanner(view);
  else if (template.kind === "pause") renderPause(view, verdict.cooldown_seconds);
  else renderBlock(view, verdict.cooldown_seconds);

  root.append(style, container);
  container.querySelector<HTMLElement>("[data-autofocus]")?.focus();

  let destroyed = false;
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const stop of stops) stop();
      style.remove();
      container.remove();
    },
  };
}

interface View {
  doc: Document;
  container: HTMLElement;
  template: OverlayTemplate;
  handlers: OverlayHandlers;
  stops: Array<() => void>;
}

// L1: a small banner. Dismissing it (button or Escape) is not an exit, so onExit
// is never called.
function renderBanner({ doc, container, template, stops }: View): void {
  const banner = el(doc, "div", "auxo-banner");
  banner.setAttribute("role", "status");

  const text = el(doc, "div");
  text.append(el(doc, "p", "auxo-title", template.title), el(doc, "p", "auxo-body", template.body));

  const dismiss = button(doc, "×", "dismiss", "auxo-dismiss");
  dismiss.setAttribute("aria-label", "Dismiss");

  // The banner is non-modal, so focus is usually on the page. Escape is heard at
  // the document but not swallowed, so the page's own Escape handling still runs.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") dismissBanner();
  };
  const dismissBanner = () => {
    banner.remove();
    doc.removeEventListener("keydown", onKeyDown);
  };
  dismiss.addEventListener("click", dismissBanner);
  doc.addEventListener("keydown", onKeyDown);
  stops.push(() => doc.removeEventListener("keydown", onKeyDown));

  banner.append(text, dismiss);
  container.append(banner);
}

// L2: a pause screen. Continue unlocks when the cooldown ends.
function renderPause(view: View, cooldownSeconds: number): void {
  const { doc, stops } = view;
  const { dialog, countdown, actions } = dialogShell(view);
  const exit = exitOnce(view, actions);

  const cont = button(doc, "Continue to checkout", "continue", "auxo-button-primary");
  cont.addEventListener("click", () => exit("overrode"));
  actions.append(cont);

  stops.push(
    startCooldown(cooldownSeconds, cont, countdown, (s) => `You can continue in ${formatSeconds(s)}`, "You can continue now."),
  );
  dialog.dataset.autofocus = "";
}

// L3/L4: a full block with three exits. Go anyway unlocks when the cooldown ends.
function renderBlock(view: View, cooldownSeconds: number): void {
  const { doc, stops } = view;
  const { countdown, actions } = dialogShell(view);
  const exit = exitOnce(view, actions);

  const leave = button(doc, "Leave", "leave", "auxo-button-primary");
  leave.addEventListener("click", () => exit("left"));
  const save = button(doc, "Save for later", "save");
  save.addEventListener("click", () => exit("saved"));
  const goAnyway = button(doc, "Go anyway", "go-anyway");
  goAnyway.addEventListener("click", () => exit("overrode"));
  actions.append(leave, save, goAnyway);

  stops.push(
    startCooldown(cooldownSeconds, goAnyway, countdown, (s) => `Go anyway unlocks in ${formatSeconds(s)}`, "You can go ahead if you still want to."),
  );
  leave.dataset.autofocus = "";
}

// Backdrop + modal dialog with title, body, countdown line, and an actions row.
function dialogShell(view: View) {
  const { doc, container, template } = view;
  const id = `auxo-${++idCounter}`;
  const backdrop = el(doc, "div", "auxo-backdrop");
  const dialog = el(doc, "div", "auxo-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", `${id}-title`);
  dialog.setAttribute("aria-describedby", `${id}-body`);
  dialog.tabIndex = -1;

  const title = el(doc, "h2", "auxo-title", template.title);
  title.id = `${id}-title`;
  const body = el(doc, "p", "auxo-body", template.body);
  body.id = `${id}-body`;
  const countdown = el(doc, "p", "auxo-countdown");
  countdown.dataset.role = "countdown";
  const actions = el(doc, "div", "auxo-actions");

  dialog.append(title, body, countdown, actions);
  backdrop.append(dialog);
  container.append(backdrop);
  trapFocus(view, dialog);
  return { dialog, countdown, actions };
}

// Keeps keyboard focus inside an open dialog. Tab and Shift+Tab cycle through
// its enabled buttons, focus that lands on the page is pulled back, and Escape
// does nothing: the friction can't be skipped, only waited out.
function trapFocus({ doc, stops }: View, dialog: HTMLElement): void {
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key !== "Tab") return;
    event.preventDefault();

    const buttons = [...dialog.querySelectorAll("button")].filter((b) => !b.disabled);
    if (buttons.length === 0) {
      dialog.focus();
      return;
    }
    const active = (dialog.getRootNode() as Document | ShadowRoot).activeElement;
    const current = buttons.findIndex((b) => b === active);
    const step = event.shiftKey ? -1 : 1;
    const next =
      current === -1 ? (event.shiftKey ? buttons.length - 1 : 0) : (current + step + buttons.length) % buttons.length;
    buttons[next]?.focus();
  });

  // composedPath() sees through the shadow root, where event.target would be
  // retargeted to the host element.
  const onFocusIn = (event: FocusEvent) => {
    if (!event.composedPath().includes(dialog)) dialog.focus();
  };
  doc.addEventListener("focusin", onFocusIn);
  stops.push(() => doc.removeEventListener("focusin", onFocusIn));
}

// Each overlay reports at most one exit; after that every button is disabled.
function exitOnce({ handlers }: View, actions: HTMLElement): (action: ExitAction) => void {
  let exited = false;
  return (action) => {
    if (exited) return;
    exited = true;
    for (const b of actions.querySelectorAll("button")) b.disabled = true;
    handlers.onExit(action);
  };
}

// Keeps `target` disabled until the cooldown passes, updating the countdown
// line as it goes. Returns a function that clears the timer.
function startCooldown(
  seconds: number,
  target: HTMLButtonElement,
  line: HTMLElement,
  pending: (remaining: number) => string,
  done: string,
): () => void {
  if (seconds <= 0) {
    line.textContent = done;
    return () => {};
  }
  const deadline = Date.now() + seconds * 1000;
  target.disabled = true;
  line.textContent = pending(seconds);

  const timer = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (remaining > 0) {
      line.textContent = pending(remaining);
      return;
    }
    clearInterval(timer);
    target.disabled = false;
    line.textContent = done;
  }, TICK_MS);
  return () => clearInterval(timer);
}

export function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function el(doc: Document, tag: string, className?: string, text?: string): HTMLElement {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(doc: Document, label: string, action: string, extraClass?: string): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.className = extraClass ? `auxo-button ${extraClass}` : "auxo-button";
  b.dataset.action = action;
  b.textContent = label;
  return b;
}
