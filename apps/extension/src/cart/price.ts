// Currencies we can parse, with the symbols a page may prefix and the number of
// minor-unit digits. Only USD for now (amazon.com).
const CURRENCIES: Record<string, { symbols: readonly string[]; decimals: number }> = {
  USD: { symbols: ["US$", "$"], decimals: 2 },
};

// Parse a displayed price ("$1,234.56", "9.99") into integer minor units
// (123456, 999). Returns null for anything that isn't exactly one price in the
// given currency, so callers never act on a guess. No float math: the digits
// are joined as a string and converted once.
export function parsePriceToMinor(text: string, currency: string): number | null {
  const spec = CURRENCIES[currency];
  if (!spec) return null;

  let value = text.replace(/\s+/g, "");
  for (const symbol of spec.symbols) {
    if (value.startsWith(symbol)) {
      value = value.slice(symbol.length);
      break;
    }
  }

  // Whole part: plain digits, or digits grouped by commas in threes.
  const match = new RegExp(`^(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,${spec.decimals}}))?$`).exec(value);
  if (!match) return null;

  const whole = (match[1] ?? "").replaceAll(",", "");
  const fraction = (match[2] ?? "").padEnd(spec.decimals, "0");
  const minor = Number(whole + fraction);
  return Number.isSafeInteger(minor) ? minor : null;
}
