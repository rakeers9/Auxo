import type { Lane } from "@auxo/shared";
import type { Trigger, UserAction } from "@auxo/shared";

import type { ClickSignal, DecideFailureReason, PageInspection } from "../messages";

export type BackendStatus =
  | { status: "not_asked" }
  | { status: "pending" }
  | { status: "verdict"; lane: Lane; decisionId: string; templateId: string }
  | { status: "failed"; reason: DecideFailureReason };

export interface DebugSnapshot {
  url: string;
  inspection: PageInspection;
  cartHash: string | null;
  backend: BackendStatus;
  checkedAt: Date;
  checks: number;
  // The trigger sent with the last decision request, if any.
  trigger?: Trigger | null;
  lastClick?: { signal: ClickSignal; at: Date } | null;
  // Most recent first.
  events?: Array<{ action: UserAction; decisionId: string; at: Date }>;
  pendingPurchase?: string | null;
  // Anything else worth knowing about this page's answer.
  note?: string | null;
}

export interface DebugPanel {
  update(snapshot: DebugSnapshot): void;
  destroy(): void;
}

const CSS = `
.auxo-debug { position: fixed; right: 12px; bottom: 12px; z-index: 2147483646; width: 360px;
  max-height: 60vh; overflow: auto; background: #111; color: #eee; border: 1px solid #444;
  border-radius: 8px; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  box-shadow: 0 6px 24px rgba(0,0,0,.4); }
.auxo-debug header { display: flex; justify-content: space-between; align-items: center;
  padding: 6px 10px; background: #222; border-bottom: 1px solid #444; position: sticky; top: 0; }
.auxo-debug button { font: inherit; color: #eee; background: #333; border: 1px solid #555;
  border-radius: 4px; padding: 1px 8px; cursor: pointer; }
.auxo-debug .body { padding: 8px 10px; }
.auxo-debug .collapsed .body { display: none; }
.auxo-debug dl { display: grid; grid-template-columns: 90px 1fr; gap: 2px 8px; margin: 0; }
.auxo-debug dt { color: #999; }
.auxo-debug dd { margin: 0; word-break: break-all; }
.auxo-debug h3 { font-size: 12px; margin: 10px 0 4px; color: #9cf; }
.auxo-debug table { width: 100%; border-collapse: collapse; }
.auxo-debug td { border-top: 1px solid #333; padding: 2px 4px; vertical-align: top; }
.auxo-debug td.num { text-align: right; white-space: nowrap; }
.auxo-debug .page-cart, .auxo-debug .page-checkout { color: #6f6; }
.auxo-debug .page-other { color: #aaa; }
.auxo-debug .problem { color: #f99; }
`;

// Always-on panel for dev builds: shows what the extension read from the page
// and what the backend said. All text goes through textContent.
export function createDebugPanel(root: ShadowRoot | HTMLElement): DebugPanel {
  const doc = root.ownerDocument ?? document;
  const style = doc.createElement("style");
  style.textContent = CSS;
  const panel = doc.createElement("section");
  panel.className = "auxo-debug";
  panel.setAttribute("aria-label", "Auxo debug panel");

  const header = doc.createElement("header");
  const title = doc.createElement("strong");
  title.textContent = "Auxo debug";
  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.textContent = "hide";
  toggle.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed");
    toggle.textContent = collapsed ? "show" : "hide";
  });
  header.append(title, toggle);

  const body = doc.createElement("div");
  body.className = "body";
  body.textContent = "Waiting for first check…";
  panel.append(header, body);
  root.append(style, panel);

  return {
    update(snapshot) {
      body.replaceChildren(...renderBody(doc, snapshot));
    },
    destroy() {
      style.remove();
      panel.remove();
    },
  };
}

function renderBody(doc: Document, s: DebugSnapshot): Node[] {
  const nodes: Node[] = [];
  const url = new URL(s.url);
  const { pageType, draft, problems, details } = s.inspection;

  nodes.push(
    list(doc, [
      ["page", pageType, `page-${pageType}`],
      ["site", url.hostname],
      ["path", url.pathname],
      ["checked", `${s.checkedAt.toLocaleTimeString()} (#${s.checks})`],
      ["backend", backendText(s.backend)],
      ["trigger", s.trigger ? triggerText(s.trigger) : "none"],
      ["last click", s.lastClick ? clickText(s.lastClick.signal, s.lastClick.at) : "none"],
      ...(s.pendingPurchase ? ([["purchase", `pending confirmation (decision ${s.pendingPurchase})`]] as Array<[string, string]>) : []),
      ...(s.note ? ([["note", s.note]] as Array<[string, string]>) : []),
    ]),
  );

  if (draft) {
    nodes.push(heading(doc, `Read ${draft.items.length} item(s)`));
    const table = doc.createElement("table");
    for (const item of draft.items) {
      const row = table.insertRow();
      cell(row, item.name);
      cell(row, `×${item.qty}`, "num");
      cell(row, money(item.price_minor, draft.currency), "num");
    }
    nodes.push(table);
    nodes.push(
      list(doc, [
        ["total", money(draft.total_minor, draft.currency)],
        ["merchant", draft.merchant],
        ["cart url", draft.url],
        ["cart_hash", s.cartHash ?? "…"],
      ]),
    );
  } else if (pageType !== "other") {
    nodes.push(heading(doc, `Could not read the ${pageType}`));
  }

  if (problems.length > 0) {
    const ul = doc.createElement("ul");
    for (const problem of problems) {
      const li = doc.createElement("li");
      li.className = "problem";
      li.textContent = problem;
      ul.append(li);
    }
    nodes.push(ul);
  }

  if (s.events && s.events.length > 0) {
    nodes.push(heading(doc, "Events sent"));
    nodes.push(
      list(
        doc,
        s.events.slice(0, 5).map((e): [string, string] => [e.action, `${e.at.toLocaleTimeString()} ${e.decisionId}`]),
      ),
    );
  }

  if (details && Object.keys(details).length > 0) {
    nodes.push(heading(doc, "Details"));
    nodes.push(list(doc, Object.entries(details).map(([k, v]) => [k, v])));
  }

  return nodes;
}

function backendText(b: BackendStatus): string {
  switch (b.status) {
    case "not_asked":
      return "not asked";
    case "pending":
      return "asking…";
    case "verdict":
      return `${b.lane} (${b.templateId}) ${b.decisionId}`;
    case "failed":
      return `failed open: ${b.reason}`;
  }
}

function triggerText(t: Trigger): string {
  return `${t.intent} (${t.source}${t.label ? `: "${t.label}"` : ""})`;
}

function clickText(signal: ClickSignal, at: Date): string {
  return `${signal.intent} (${signal.source}${signal.label ? `: "${signal.label}"` : ""}) at ${at.toLocaleTimeString()}`;
}

// Display only. Money stays in integer minor units everywhere else.
export function money(minor: number, currency: string): string {
  const whole = Math.trunc(minor / 100);
  const cents = String(minor % 100).padStart(2, "0");
  return `${currency === "USD" ? "$" : `${currency} `}${whole.toLocaleString("en-US")}.${cents}`;
}

function list(doc: Document, rows: Array<[string, string, string?]>): HTMLElement {
  const dl = doc.createElement("dl");
  for (const [key, value, className] of rows) {
    const dt = doc.createElement("dt");
    dt.textContent = key;
    const dd = doc.createElement("dd");
    dd.textContent = value;
    if (className) dd.className = className;
    dl.append(dt, dd);
  }
  return dl;
}

function heading(doc: Document, text: string): HTMLElement {
  const h = doc.createElement("h3");
  h.textContent = text;
  return h;
}

function cell(row: HTMLTableRowElement, text: string, className?: string): void {
  const td = row.insertCell();
  td.textContent = text;
  if (className) td.className = className;
}
