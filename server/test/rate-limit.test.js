import { describe, it, expect, vi, afterEach } from "vitest";
import { RateLimiter } from "../src/rate-limit.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("RateLimiter (fixed window)", () => {
  it("allows up to the limit then blocks", () => {
    const rl = new RateLimiter(3, 60, { autoSweep: false });
    expect(rl.allow("ip").allowed).toBe(true);
    expect(rl.allow("ip").allowed).toBe(true);
    expect(rl.allow("ip").allowed).toBe(true);
    const blocked = rl.allow("ip");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("isolates identities", () => {
    const rl = new RateLimiter(1, 60, { autoSweep: false });
    expect(rl.allow("a").allowed).toBe(true);
    expect(rl.allow("a").allowed).toBe(false);
    expect(rl.allow("b").allowed).toBe(true);
  });

  it("resets after the window rolls over", () => {
    vi.useFakeTimers();
    const rl = new RateLimiter(2, 60, { autoSweep: false });
    expect(rl.allow("ip").allowed).toBe(true);
    expect(rl.allow("ip").allowed).toBe(true);
    expect(rl.allow("ip").allowed).toBe(false);

    vi.setSystemTime(Date.now() + 61_000);
    expect(rl.allow("ip").allowed).toBe(true);
  });

  it("sweep() evicts stale buckets so idle identities do not leak", () => {
    vi.useFakeTimers();
    const rl = new RateLimiter(5, 60, { autoSweep: false });
    rl.allow("ip1");
    rl.allow("ip2");
    expect(rl.buckets.size).toBe(2);

    vi.setSystemTime(Date.now() + 61_000);
    rl.sweep();
    expect(rl.buckets.size).toBe(0);
  });

  it("retryAfter counts down within the window", () => {
    vi.useFakeTimers();
    const rl = new RateLimiter(1, 60, { autoSweep: false });
    rl.allow("ip");
    const first = rl.allow("ip");
    expect(first.retryAfter).toBeLessThanOrEqual(60);
    expect(first.retryAfter).toBeGreaterThan(0);
  });
});
