// Fixed-window rate limiting. The counting lives behind `RateLimitStore` so a
// shared store (e.g. Redis or Postgres) can replace the in-memory one; on
// Vercel each instance has its own memory, so the in-memory store only limits
// per instance.

export interface RateLimitHit {
  // Requests counted in the current window, including this one.
  count: number;
  // Epoch milliseconds when the current window ends.
  resetAt: number;
}

export interface RateLimitStore {
  // Count one request for `key` in a window of `windowMs` starting at the
  // key's first request, and return the window's state after counting it.
  hit(key: string, windowMs: number, now: number): Promise<RateLimitHit>;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  public constructor(private readonly maxKeys = 10_000) {}

  public async hit(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
    if (this.windows.size > this.maxKeys) {
      for (const [storedKey, value] of this.windows) {
        if (now - value.startedAt >= windowMs) this.windows.delete(storedKey);
      }
    }
    const current = this.windows.get(key);
    const window = !current || now - current.startedAt >= windowMs
      ? { startedAt: now, count: 1 }
      : { startedAt: current.startedAt, count: current.count + 1 };
    this.windows.set(key, window);
    return { count: window.count, resetAt: window.startedAt + windowMs };
  }

  public get size(): number {
    return this.windows.size;
  }
}

export interface RateLimitDecision {
  limited: boolean;
  retryAfterSeconds: number;
}

export class RateLimiter {
  public constructor(
    private readonly store: RateLimitStore,
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  public async consume(key: string): Promise<RateLimitDecision> {
    const now = this.now();
    const hit = await this.store.hit(key, this.windowMs, now);
    return {
      limited: hit.count > this.max,
      retryAfterSeconds: Math.max(1, Math.ceil((hit.resetAt - now) / 1_000)),
    };
  }
}

// Authenticated callers get their own bucket, so users behind one proxy or NAT
// don't share a limit; everyone else is limited by IP.
export function rateLimitKey(userId: string | null, ip: string): string {
  return userId ? `user:${userId}` : `ip:${ip}`;
}
