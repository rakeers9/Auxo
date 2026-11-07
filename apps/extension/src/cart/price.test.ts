import { describe, expect, it } from "vitest";

import { parsePriceToMinor, parseShownPriceNear } from "./price";

describe("parsePriceToMinor", () => {
  it.each([
    ["$1,234.56", 123456],
    ["$9.99", 999],
    ["9.99", 999], // data-price attributes have no symbol
    ["52.89", 5289],
    ["$126.84", 12684],
    ["$0.42", 42],
    ["$0.03", 3],
    ["$5", 500],
    ["52.8", 5280],
    ["$1,000", 100000],
    ["1000.00", 100000],
    ["US$9.99", 999],
    [" $9.99 ", 999],
    [" $9.99\n", 999],
    ["$1,234,567.89", 123456789],
  ])("parses %j as %i", (text, expected) => {
    expect(parsePriceToMinor(text, "USD")).toBe(expected);
  });

  it.each([
    "",
    "$",
    "abc",
    "-$5.00",
    "$1.999",
    "$1,23.45",
    "$12,34",
    "9,99",
    "$.99",
    "$9.",
    "$9.99 - $19.99",
    "€9.99",
    "1e3",
    "$99999999999999999.99",
  ])("rejects %j", (text) => {
    expect(parsePriceToMinor(text, "USD")).toBeNull();
  });

  it("rejects currencies it has no rules for", () => {
    expect(parsePriceToMinor("9.99", "EUR")).toBeNull();
  });
});

describe("parseShownPriceNear", () => {
  it.each([
    ["8.982", "8.98", 898], // real Subscribe & Save item: $9.98 less 10%
    ["8.985", "8.98", 898],
    ["8.985", "8.99", 899],
    ["8.989", "8.99", 899],
    ["17.9640", "17.96", 1796],
    [" 8.982 ", "$8.98", 898],
  ])("reads %j shown as %j as %i", (exact, shown, expected) => {
    expect(parseShownPriceNear(exact, shown, "USD")).toBe(expected);
  });

  it.each([
    ["8.982", "8.97"], // more than a cent apart
    ["8.982", "9.98"],
    ["8.98", "8.98"], // nothing past the cent: parsePriceToMinor's job
    ["8.9", "8.90"],
    ["8.982", ""],
    ["8.982", "n/a"],
    ["", "8.98"],
    ["$8.982", "8.98"],
    ["8,982", "8.98"],
    ["-8.982", "8.98"],
    ["see price in cart", "8.98"],
  ])("rejects %j shown as %j", (exact, shown) => {
    expect(parseShownPriceNear(exact, shown, "USD")).toBeNull();
  });

  it("rejects currencies it has no rules for", () => {
    expect(parseShownPriceNear("8.982", "8.98", "EUR")).toBeNull();
  });
});
