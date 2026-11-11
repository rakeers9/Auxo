import type { AlternativeStrategy, Verdict } from "@auxo/shared";

import type { ExitAction } from "../messages";
import { OVERLAY_CSS } from "./styles";
import { CLICK_PAUSE_COPY, MODEL_BLOCK_COPY, resolveTemplate, type OverlayTemplate } from "./templates";

export interface OverlayHandlers {
  onExit(action: ExitAction): void;
}

export interface OverlayOptions {
  // The label of a buy button whose click was stopped (e.g. "Place your
  // order"). Shows the block screen, whatever the verdict's action, naming what
  // was paused. The click is never replayed: after Continue the user clicks the
  // real button again themselves.
  clicked?: string;
}

export interface ClickAgainHandlers {
  onDismiss(): void;
}

export interface OverlayHandle {
  destroy(): void;
}

// How often the countdown re-reads the clock. The remaining time comes from a
// fixed deadline, so throttled timers in background tabs only delay the update,
// never shorten the cooldown.
const TICK_MS = 250;

const MAX_LABEL_LENGTH = 200;

let idCounter = 0;

// Renders the overlay for a verdict into `root` (a shadow root in production).
// Returns null for L0, which shows nothing, unless a click was stopped.
export function renderOverlay(
  root: ShadowRoot | HTMLElement,
  verdict: Verdict,
  handlers: OverlayHandlers,
  options: OverlayOptions = {},
): OverlayHandle | null {
  const template = withModelCopy(resolveTemplate(verdict), verdict);
  const clicked = options.clicked === undefined ? undefined : cleanLabel(options.clicked);
  if (clicked === undefined && template.kind === "none") return null;

  const dataset: Record<string, string> = { lane: template.lane, template: template.id };
  if (clicked !== undefined) dataset.clicked = clicked;

  const why = reasonLine(verdict);
  const idea = ideaFor(verdict);
  return mount(root, dataset, (ctx) => {
    if (clicked !== undefined) {
      // A non-block lane has no block copy of its own; an empty one (L0) borrows a generic line.
      const copy = template.title ? template : { ...template, ...CLICK_PAUSE_COPY };
      renderBlock({ ...ctx, template: copy, handlers, why, idea }, verdict.cooldown_seconds, clicked);
    } else if (template.kind === "banner") renderBanner({ ...ctx, template, handlers, why, idea });
    else if (template.kind === "pause") renderPause({ ...ctx, template, handlers, why, idea }, verdict.cooldown_seconds);
    else renderBlock({ ...ctx, template, handlers, why, idea }, verdict.cooldown_seconds);
  });
}

// A small non-modal banner shown after Continue on a stopped click, telling the
// user they can click the real button now. Dismissible by button or Escape;
// never traps focus. Dismissing removes it and calls onDismiss.
export function renderClickAgainHint(
  root: ShadowRoot | HTMLElement,
  label: string,
  handlers: ClickAgainHandlers,
): OverlayHandle {
  const clean = cleanLabel(label);
  return mount(root, { hint: "click-again" }, (ctx) => {
    const text = clean ? `You can click “${clean}” now.` : "You can click it now.";
    showBanner(ctx, [el(ctx.doc, "p", "auxo-body", text)], () => {
      ctx.destroy();
      handlers.onDismiss();
    });
  });
}

// What every overlay piece gets while it builds.
interface MountContext {
  doc: Document;
  container: HTMLElement;
  stops: Array<() => void>;
  destroy(): void;
}

interface View extends MountContext {
  template: OverlayTemplate;
  handlers: OverlayHandlers;
  // Why the overlay showed up, from the decision context (AUX-50).
  why?: string | undefined;
  // A kind of alternative that could still satisfy the want.
  idea?: Idea | undefined;
}

export interface Idea {
  text: string;
  // A search for the alternative on the same store, when there is one.
  link?: { href: string; text: string };
}

const IDEAS: Record<Exclude<AlternativeStrategy, "none">, { text: string; linkText?: string; suffix?: string }> = {
  renewed: { text: "Idea: a renewed or used one could do the same job for less.", linkText: "See renewed options", suffix: " renewed" },
  cheaper_version: { text: "Idea: a less expensive version might give you the same thing.", linkText: "Compare similar items" },
  wait_for_deal: { text: "Idea: this may not be urgent. Save it and see if the price drops." },
  already_own: { text: "Idea: you might already have something that does this, or could borrow it." },
  fewer: { text: "Idea: a smaller size or quantity might be enough." },
};

// Amazon's own hosts only: the search link is built for them.
const AMAZON_HOST = /^(?:www\.)?amazon\.(?:com|ca|co\.uk|de|fr|it|es|in|com\.au|co\.jp|com\.mx)$/;

// The suggestion from the decision context, if the API sent one. The search
// link is only built for Amazon and only when the API gave a query.
export function ideaFor(verdict: Verdict): Idea | undefined {
  const alternative = verdict.context?.alternative;
  if (!alternative) return undefined;
  const copy = IDEAS[alternative.strategy];
  const merchant = verdict.context?.cart_summary.merchant.toLowerCase() ?? "";
  if (!copy.linkText || !alternative.query || !AMAZON_HOST.test(merchant)) return { text: copy.text };
  const host = merchant.startsWith("www.") ? merchant : `www.${merchant}`;
  const href = `https://${host}/s?k=${encodeURIComponent(`${alternative.query}${copy.suffix ?? ""}`)}`;
  return { text: copy.text, link: { href, text: copy.linkText } };
}

const BUDGET_REASONS: Partial<Record<string, string>> = {
  "budget.exceeded": "This would put you over your spending limit.",
  "budget.critical": "This would bring you close to your spending limit.",
  "budget.warning": "This would use most of your spending limit.",
};

// True when the context shows the user's own rules or budgets didn't set the
// lane (the decision model raised it). Unknown without a context.
export function setByModel(verdict: Verdict): boolean {
  const factors = verdict.context?.decisive_factors;
  if (!factors) return false;
  return !factors.some((factor) => (factor.source === "rule" || factor.source === "budget") && factor.lane === verdict.lane);
}

function withModelCopy(template: OverlayTemplate, verdict: Verdict): OverlayTemplate {
  const copy = setByModel(verdict) ? MODEL_BLOCK_COPY[template.lane] : undefined;
  return copy ? { ...template, ...copy } : template;
}

// One line saying what set the lane: the user's own rule, else their budget.
// Undefined when neither did (the model's own pick, the stub, no context).
export function reasonLine(verdict: Verdict): string | undefined {
  const context = verdict.context;
  if (!context) return undefined;
  const rules = context.matched_rules.filter((rule) => rule.lane === verdict.lane);
  const first = rules[0];
  if (first) {
    const more = rules.length - 1;
    return more > 0 ? `Your rules: “${first.name}” and ${more} more.` : `Your rule: “${first.name}”.`;
  }
  for (const factor of context.decisive_factors) {
    const reason = factor.source === "budget" && factor.lane === verdict.lane ? BUDGET_REASONS[factor.code] : undefined;
    if (reason) return reason;
  }
  return undefined;
}

// Adds a <style> and a container to `root`, lets `build` fill the container,
// focuses any [data-autofocus], and returns a handle whose destroy() runs every
// cleanup and removes both nodes.
function mount(
  root: ShadowRoot | HTMLElement,
  dataset: Record<string, string>,
  build: (ctx: MountContext) => void,
): OverlayHandle {
  const doc = root.ownerDocument ?? document;
  const style = doc.createElement("style");
  style.textContent = OVERLAY_CSS;
  const container = doc.createElement("div");
  container.className = "auxo-overlay";
  Object.assign(container.dataset, dataset);

  const stops: Array<() => void> = [];
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    for (const stop of stops) stop();
    style.remove();
    container.remove();
  };

  build({ doc, container, stops, destroy });
  root.append(style, container);
  container.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  return { destroy };
}

// L1: a small banner. Dismissing it (button or Escape) is not an exit, so onExit
// is never called.
function renderBanner(view: View): void {
  const { doc, template } = view;
  const text = el(doc, "div");
  text.append(el(doc, "p", "auxo-title", template.title), el(doc, "p", "auxo-body", template.body));
  if (view.why) text.append(whyLine(doc, view.why));
  if (view.idea) text.append(ideaLine(doc, view.idea));
  showBanner(view, [text], () => {});
}

// A non-modal banner with a dismiss button. The banner is removed on dismiss,
// then `onDismiss` runs, once. Focus is usually on the page, so Escape is heard
// at the document but not swallowed: the page's own Escape handling still runs.
function showBanner({ doc, container, stops }: MountContext, content: HTMLElement[], onDismiss: () => void): void {
  const banner = el(doc, "div", "auxo-banner");
  banner.setAttribute("role", "status");

  const dismiss = button(doc, "×", "dismiss", "auxo-dismiss");
  dismiss.setAttribute("aria-label", "Dismiss");

  let dismissed = false;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") dismissBanner();
  };
  const dismissBanner = () => {
    if (dismissed) return;
    dismissed = true;
    banner.remove();
    doc.removeEventListener("keydown", onKeyDown);
    onDismiss();
  };
  dismiss.addEventListener("click", dismissBanner);
  doc.addEventListener("keydown", onKeyDown);
  stops.push(() => doc.removeEventListener("keydown", onKeyDown));

  banner.append(...content, dismiss);
  container.append(banner);
}

// L2: a pause screen. Leave and Save for later work right away; Continue
// unlocks when the cooldown ends. The pause covers the page, so it must never
// leave the user with nothing to do but wait.
function renderPause(view: View, cooldownSeconds: number): void {
  const { doc, stops } = view;
  const { countdown, actions } = dialogShell(view);
  const exit = exitOnce(view, actions);

  const leave = button(doc, "Leave", "leave");
  leave.addEventListener("click", () => exit("left"));
  const save = button(doc, "Save for later", "save");
  save.addEventListener("click", () => exit("saved"));
  const cont = button(doc, "Continue to checkout", "continue", "auxo-button-primary");
  cont.addEventListener("click", () => exit("overrode"));
  actions.append(leave, save, cont);

  stops.push(
    startCooldown(cooldownSeconds, cont, countdown, (s) => `You can continue in ${formatSeconds(s)}`, "You can continue now."),
  );
  leave.dataset.autofocus = "";
}

// L3/L4, or any lane when a click was stopped: a full block with three exits.
// Go anyway (Continue, for a stopped click) unlocks when the cooldown ends.
function renderBlock(view: View, cooldownSeconds: number, clicked?: string): void {
  const { doc, stops } = view;
  const stopped =
    clicked === undefined ? undefined : clicked ? `We paused “${clicked}”.` : "We paused that click.";
  const { countdown, actions } = dialogShell(view, stopped);
  const exit = exitOnce(view, actions);

  const goLabel = clicked === undefined ? "Go anyway" : "Continue";
  const leave = button(doc, "Leave", "leave", "auxo-button-primary");
  leave.addEventListener("click", () => exit("left"));
  const save = button(doc, "Save for later", "save");
  save.addEventListener("click", () => exit("saved"));
  const goAnyway = button(doc, goLabel, "go-anyway");
  goAnyway.addEventListener("click", () => exit("overrode"));
  actions.append(leave, save, goAnyway);

  const done = clicked === undefined ? "You can go ahead if you still want to." : "You can continue now.";
  stops.push(startCooldown(cooldownSeconds, goAnyway, countdown, (s) => `${goLabel} unlocks in ${formatSeconds(s)}`, done));
  leave.dataset.autofocus = "";
}

// Text only (textContent): a rule's name is the user's own words.
function whyLine(doc: Document, text: string): HTMLElement {
  const line = el(doc, "p", "auxo-why", text);
  line.dataset.role = "why";
  return line;
}

// The suggestion line, with its search link opening in a new tab. Text only
// (textContent): the query is the store's item name.
function ideaLine(doc: Document, idea: Idea): HTMLElement {
  const line = el(doc, "p", "auxo-idea", idea.text);
  line.dataset.role = "idea";
  if (idea.link) {
    const link = doc.createElement("a");
    link.className = "auxo-idea-link";
    link.href = idea.link.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = idea.link.text;
    line.append(" ", link);
  }
  return line;
}

// Backdrop + modal dialog with title, an optional "what was stopped" line,
// body, countdown line, and an actions row.
function dialogShell(view: View, stoppedText?: string) {
  const { doc, container, template } = view;
  const id = `auxo-${++idCounter}`;
  const backdrop = el(doc, "div", "auxo-backdrop");
  const dialog = el(doc, "div", "auxo-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", `${id}-title`);
  dialog.setAttribute("aria-describedby", stoppedText === undefined ? `${id}-body` : `${id}-stopped ${id}-body`);
  dialog.tabIndex = -1;

  const title = el(doc, "h2", "auxo-title", template.title);
  title.id = `${id}-title`;
  const body = el(doc, "p", "auxo-body", template.body);
  body.id = `${id}-body`;
  const countdown = el(doc, "p", "auxo-countdown");
  countdown.dataset.role = "countdown";
  const actions = el(doc, "div", "auxo-actions");

  const why = view.why ? [whyLine(doc, view.why)] : [];
  if (view.idea) why.push(ideaLine(doc, view.idea));
  if (stoppedText === undefined) {
    dialog.append(title, body, ...why, countdown, actions);
  } else {
    const stopped = el(doc, "p", "auxo-stopped", stoppedText);
    stopped.id = `${id}-stopped`;
    stopped.dataset.role = "stopped";
    dialog.append(title, stopped, body, ...why, countdown, actions);
  }
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

    // Buttons and the suggestion's link.
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>("button, a[href]")].filter(
      (b) => !(b.tagName === "BUTTON" && (b as HTMLButtonElement).disabled),
    );
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

// Labels come from the page: collapse whitespace, trim, and cap the length.
function cleanLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH).trim();
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
