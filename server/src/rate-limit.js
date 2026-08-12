// Fixed-window per-identity rate limiter.
//
// Each identity maps to a single { windowStart, count } bucket (O(1) memory per
// identity, no per-request timestamp arrays). A periodic sweep evicts buckets
// whose window has fully elapsed so idle identities do not leak memory on a
// long-running server. allow() returns { allowed, retryAfter } so callers can
// emit a correct Retry-After header on 429.
export class RateLimiter {
  constructor(
    maxRequestsPerWindow,
    windowSeconds = 60,
    { autoSweep = true } = {},
  ) {
    this.maxRequests = maxRequestsPerWindow;
    this.windowMs = windowSeconds * 1000;
    this.buckets = new Map();
    this.sweepTimer = null;

    if (autoSweep) {
      // Sweep once per window. unref() so this timer never keeps the process
      // alive (important for tests and graceful shutdown).
      this.sweepTimer = setInterval(() => this.sweep(), this.windowMs);
      if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
    }
  }

  allow(identity) {
    const now = Date.now();
    const bucket = this.buckets.get(identity);

    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      // New identity or window rolled over — start a fresh window.
      this.buckets.set(identity, { windowStart: now, count: 1 });
      return { allowed: true, retryAfter: 0 };
    }

    if (bucket.count >= this.maxRequests) {
      const retryAfter = Math.max(
        1,
        Math.ceil((bucket.windowStart + this.windowMs - now) / 1000),
      );
      return { allowed: false, retryAfter };
    }

    bucket.count += 1;
    return { allowed: true, retryAfter: 0 };
  }

  sweep() {
    const now = Date.now();
    for (const [identity, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs) {
        this.buckets.delete(identity);
      }
    }
  }

  stop() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}
