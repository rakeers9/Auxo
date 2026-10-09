import { describe, it, expect, vi } from "vitest";
import { requestPass } from "./passes";
const decisionId = "00000000-0000-4000-8000-000000000001";
const pass = { pass_id: decisionId, decision_id: decisionId, merchant: "amazon.com", cart_hash: "a".repeat(64), expires_at: "2099-01-01T00:00:00Z" };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
describe("checkout pass connector", () => {
  it("checks the issued pass against the active endpoint", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response(pass)).mockResolvedValueOnce(response({ pass }));
    expect(await requestPass(decisionId, "https://example.com", fetchFn)).toBe(true);
    expect(String(fetchFn.mock.calls[1]?.[0])).toContain(`cart_hash=${pass.cart_hash}`);
  });
  it("does not unlock on cooldown denial", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response({}, 403));
    expect(await requestPass(decisionId, "https://example.com", fetchFn)).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("rejects an expired or different decision's pass", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response(pass)).mockResolvedValueOnce(response({ pass: { ...pass, expires_at: "2000-01-01T00:00:00Z" } }));
    expect(await requestPass(decisionId, "https://example.com", fetchFn)).toBe(false);
  });
});
