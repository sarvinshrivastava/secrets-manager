export class RateLimiter {
  constructor(maxRequestsPerWindow, windowSeconds = 60) {
    this.maxRequests = maxRequestsPerWindow;
    this.windowMs = windowSeconds * 1000;
    this.buckets = new Map();
  }

  allow(identity) {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    const bucket = this.buckets.get(identity) || [];
    while (bucket.length > 0 && bucket[0] < cutoff) {
      bucket.shift();
    }

    // Evict empty buckets to prevent memory leak on long-running servers
    if (bucket.length === 0) {
      this.buckets.delete(identity);
      this.buckets.set(identity, [now]);
      return true;
    }

    if (bucket.length >= this.maxRequests) {
      this.buckets.set(identity, bucket);
      return false;
    }

    bucket.push(now);
    this.buckets.set(identity, bucket);
    return true;
  }
}
