import { describe, it, expect } from "vitest";
import { loadSettings } from "../src/config.js";

// Pass an explicit env object so process.env / .env files don't leak in.
function base(extra = {}) {
  return { SECRET_MANAGER_MASTER_KEY: "k", ...extra };
}

describe("loadSettings", () => {
  it("throws without a master key", () => {
    expect(() => loadSettings({})).toThrow(/MASTER_KEY/);
  });

  it("applies sane defaults", () => {
    const s = loadSettings(base());
    expect(s.rateLimitPerMinute).toBe(120);
    expect(s.publicRateLimitPerMinute).toBe(60);
    expect(s.auditLogRetentionDays).toBe(90);
    expect(s.host).toBe("0.0.0.0");
    expect(s.port).toBe(8000);
    expect(s.trustedProxyIps).toEqual(["127.0.0.1", "::1"]);
  });

  it("parses a trusted proxy list", () => {
    const s = loadSettings(
      base({ SECRET_MANAGER_TRUSTED_PROXY_IPS: "10.0.0.1, 10.0.0.2" }),
    );
    expect(s.trustedProxyIps).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  it("rejects a non-positive integer setting", () => {
    expect(() => loadSettings(base({ SECRET_MANAGER_PORT: "0" }))).toThrow(
      /> 0/,
    );
    expect(() =>
      loadSettings(base({ SECRET_MANAGER_RATE_LIMIT_PER_MINUTE: "abc" })),
    ).toThrow(/integer/);
  });
});
