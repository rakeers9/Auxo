import { describe, expect, it } from "vitest";

import { parsePriceToMinor } from "./price";

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
