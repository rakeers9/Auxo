import { ActivePassResponseSchema, PassSchema, type Pass } from "@auxo/shared";

export async function requestPass(decisionId: string, baseUrl: string, fetchFn: typeof fetch, verified?: (pass: Pass) => void): Promise<boolean> {
  try {
    const signal = AbortSignal.timeout(5000);
    const response = await fetchFn(new URL("/v1/passes", baseUrl), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision_id: decisionId }), signal,
    });
    if (!response.ok) return false;
    const issued = PassSchema.safeParse(await response.json());
    if (!issued.success || issued.data.decision_id !== decisionId) return false;
    const url = new URL("/v1/passes/active", baseUrl);
    url.searchParams.set("cart_hash", issued.data.cart_hash);
    const active = await fetchFn(url, { signal });
    if (!active.ok) return false;
    const parsed = ActivePassResponseSchema.safeParse(await active.json());
    const valid = parsed.success && parsed.data.pass?.decision_id === decisionId &&
      parsed.data.pass.merchant === issued.data.merchant &&
      parsed.data.pass.cart_hash === issued.data.cart_hash &&
      Date.parse(parsed.data.pass.expires_at) > Date.now();
    if (valid && parsed.success && parsed.data.pass) verified?.(parsed.data.pass);
    return valid;
  } catch { return false; }
}
