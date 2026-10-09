import { GUESS_PHRASES, normalize } from "../clicks/guess";

// Tier 2: is this a checkout page on a site no dedicated reader knows?
// Every signal is grounded in a real source (sanitized pages in
// __fixtures__/generic, or the provider's published package):
// - Stripe: card/IBAN fields are iframes from js.stripe.com/v3/elements-inner-*
//   (real Stripe Payments Demo). Stripe's docs pages load only its controller /
//   metrics frames, which are not payment fields.
// - Braintree: hosted fields load assets.braintreegateway.com/web/<v>/html/
//   hosted-fields-frame..., framed as "braintree-hosted-field-<field>"
//   (braintree-web package).
// - Adyen: secured fields load checkoutshopper-<region>[.cdn].adyen.com/
//   checkoutshopper/securedfields/<key>/<v>/securedFields.html (adyen-web package).
// - Card fields: the HTML autofill tokens cc-number / cc-exp / cc-csc.
// - Shopify checkout's own payment frames aren't covered: they couldn't be
//   seen without starting a checkout.
// False positives are far worse than misses (a pause on a non-checkout page),
// so a page only counts with a payment signal plus enough support, and donation
// pages never count.

export type CheckoutSignal =
  | "payment_frame"
  | "card_fields"
  | "address_fields"
  | "place_order_button"
  | "total_near_button"
  | "url_keyword"
  | "donation";

export interface CheckoutScore {
  pageType: "checkout" | "other";
  score: number;
  signals: CheckoutSignal[];
}

const WEIGHTS: Record<Exclude<CheckoutSignal, "donation">, number> = {
  payment_frame: 3,
  card_fields: 3,
  address_fields: 2,
  place_order_button: 2,
  total_near_button: 1,
  url_keyword: 1,
};
// A payment signal (3) plus at least 2 more points from other signals.
export const CHECKOUT_THRESHOLD = 5;

const URL_KEYWORDS = /(?:^|[/_.-])(?:checkout|checkouts|cart|bag|basket)(?:$|[/_.-])/i;
const DONATION_URL = /donat/i;

// Cheap, broad pre-filters for the gate; the scorer then checks precisely.
const FRAME_HINT = 'iframe[src*="js.stripe.com"], iframe[src*="braintreegateway.com"], iframe[src*="adyen.com"]';
const CARD_FIELDS = '[autocomplete~="cc-number"], [autocomplete~="cc-exp"], [autocomplete~="cc-csc"]';
const ADDRESS_AUTOCOMPLETE = '[autocomplete~="street-address"], [autocomplete~="address-line1"], [autocomplete~="postal-code"]';
// Real demo checkout used plain names with no autocomplete (address, postal_code).
const ADDRESS_NAMED = 'input[name*="postal" i], input[name*="zip" i], input[id*="postal" i], input[id*="zip" i]';
const STREET_NAMED = 'input[name*="address" i], input[name*="street" i], input[id*="address" i], input[id*="street" i]';
const BUTTONS = 'button, input[type="submit"], input[type="button"], [role="button"]';

// "Place order"-style labels, matched as whole normalized phrases (same rules
// as the click classifier), plus a bare "Pay" (the real demo's button: "Pay").
const PLACE_ORDER = new Set([...GUESS_PHRASES.place_order, "pay"]);
const MONEY = /(?:[$€£¥]\s?\d[\d,]*(?:\.\d{2})?|\d[\d,]*\.\d{2}\s?(?:USD|EUR|GBP|€))/;

// Runs on every page: the URL and a couple of selector queries, nothing else.
// False means "certainly not checkout"; true means "worth scoring".
export function isCheckoutCandidate(doc: Document, url: URL): boolean {
  if (URL_KEYWORDS.test(url.pathname)) return true;
  return doc.querySelector(`${FRAME_HINT}, ${CARD_FIELDS}`) !== null;
}

export function scoreCheckout(doc: Document, url: URL): CheckoutScore {
  const signals: CheckoutSignal[] = [];

  if (hasPaymentFrame(doc)) signals.push("payment_frame");
  if (doc.querySelector(CARD_FIELDS)) signals.push("card_fields");
  if (doc.querySelector(ADDRESS_AUTOCOMPLETE) || (doc.querySelector(ADDRESS_NAMED) && doc.querySelector(STREET_NAMED))) {
    signals.push("address_fields");
  }
  const button = findPlaceOrderButton(doc);
  if (button) {
    signals.push("place_order_button");
    if (hasTotalNear(button)) signals.push("total_near_button");
  }
  if (URL_KEYWORDS.test(url.pathname)) signals.push("url_keyword");
  const donation = DONATION_URL.test(url.pathname) || hasDonateButton(doc);
  if (donation) signals.push("donation");

  const score = signals.reduce((sum, s) => sum + (s === "donation" ? 0 : WEIGHTS[s]), 0);
  const payment = signals.includes("payment_frame") || signals.includes("card_fields");
  const checkout = payment && !donation && score >= CHECKOUT_THRESHOLD;
  return { pageType: checkout ? "checkout" : "other", score, signals };
}

function hasPaymentFrame(doc: Document): boolean {
  for (const frame of doc.querySelectorAll<HTMLIFrameElement>(FRAME_HINT)) {
    let src: URL;
    try {
      src = new URL(frame.getAttribute("src") ?? "", doc.baseURI);
    } catch {
      continue;
    }
    const host = src.hostname;
    if (host === "js.stripe.com" && src.pathname.includes("/elements-inner-")) return true;
    if (host === "assets.braintreegateway.com" && (src.pathname.includes("/hosted-fields-frame") || frame.name.startsWith("braintree-hosted-field-"))) {
      return true;
    }
    if (/^checkoutshopper-[a-z0-9-]+\.(?:cdn\.)?adyen\.com$/.test(host) && src.pathname.includes("/securedfields/")) return true;
  }
  return false;
}

function labelOf(el: Element): string {
  const raw = el instanceof HTMLInputElement ? el.value : el.textContent;
  return normalize((raw ?? "").slice(0, 80));
}

function findPlaceOrderButton(doc: Document): Element | null {
  for (const el of doc.querySelectorAll(BUTTONS)) if (PLACE_ORDER.has(labelOf(el))) return el;
  return null;
}

function hasDonateButton(doc: Document): boolean {
  for (const el of doc.querySelectorAll(BUTTONS)) if (/\bdonat/.test(labelOf(el))) return true;
  return false;
}

// A money amount on the button itself or within its nearest few containers,
// stopping short of <body> (on the real demo the total is page-wide only).
function hasTotalNear(button: Element): boolean {
  let el: Element | null = button;
  for (let depth = 0; el && depth <= 4; depth++, el = el.parentElement) {
    if (el.tagName === "BODY" || el.tagName === "HTML") return false;
    if (MONEY.test((el.textContent ?? "").slice(0, 2000))) return true;
  }
  return false;
}
