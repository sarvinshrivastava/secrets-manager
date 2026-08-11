import { describe, it, expect } from "vitest";
import {
  getClientIp,
  parseEnvValue,
  formatEnvValue,
  scopeAllowsFolder,
  parseNamedToken,
  isValidFolderName,
} from "../src/utils.js";

function fakeReq(remoteAddress, xff) {
  return {
    socket: { remoteAddress },
    header(name) {
      if (name === "x-forwarded-for") return xff;
      return undefined;
    },
  };
}

describe("getClientIp (XFF handling)", () => {
  const trusted = ["127.0.0.1", "::1", "10.0.0.1"];

  it("returns remote address when peer is not a trusted proxy", () => {
    const req = fakeReq("203.0.113.9", "1.2.3.4");
    expect(getClientIp(req, trusted)).toBe("203.0.113.9");
  });

  it("takes the RIGHTMOST non-proxy entry (spoof-resistant)", () => {
    // Attacker prepends spoofed IPs; nginx appends the real client on the right.
    const req = fakeReq("127.0.0.1", "9.9.9.9, 8.8.8.8, 203.0.113.7");
    expect(getClientIp(req, trusted)).toBe("203.0.113.7");
  });

  it("skips trailing trusted-proxy hops to find the real client", () => {
    const req = fakeReq("127.0.0.1", "203.0.113.7, 10.0.0.1, 127.0.0.1");
    expect(getClientIp(req, trusted)).toBe("203.0.113.7");
  });

  it("does not trust XFF at all from an untrusted peer", () => {
    const req = fakeReq("203.0.113.50", "1.1.1.1, 2.2.2.2");
    expect(getClientIp(req, trusted)).toBe("203.0.113.50");
  });
});

describe("env value round-trip", () => {
  it("survives export -> import identically for tricky values", () => {
    for (const value of [
      "C:\\path\\new",
      `a"b'c\nd`,
      "line1\nline2\ttab",
      "plain",
      "trailing\\",
    ]) {
      const roundTripped = parseEnvValue(formatEnvValue(value));
      expect(roundTripped).toBe(value);
    }
  });

  it("does not corrupt a literal backslash-n (single-pass)", () => {
    // The bug: `\\`->`\` then `\n`->newline double-scans `C:\new` into `C:<newline>ew`.
    const value = "C:\\new";
    expect(parseEnvValue(formatEnvValue(value))).toBe(value);
    // Explicit wire form check.
    expect(formatEnvValue("C:\\new")).toBe('"C:\\\\new"');
  });

  it("parses single-quoted values literally", () => {
    expect(parseEnvValue("'raw\\nvalue'")).toBe("raw\\nvalue");
  });

  it("parses unquoted values as-is", () => {
    expect(parseEnvValue("  bare  ")).toBe("bare");
  });
});

describe("scopeAllowsFolder", () => {
  it("wildcard allows everything", () => {
    expect(scopeAllowsFolder("*", "Anything")).toBe(true);
    expect(scopeAllowsFolder(null, "Anything")).toBe(true);
  });

  it("CSV scope allows only listed folders", () => {
    expect(scopeAllowsFolder("A,B", "A")).toBe(true);
    expect(scopeAllowsFolder("A,B", "C")).toBe(false);
  });
});

describe("parseNamedToken", () => {
  it("parses <name>.<secret>", () => {
    expect(parseNamedToken("admin.deadbeef")).toEqual({
      name: "admin",
      secret: "deadbeef",
    });
  });

  it("returns null for a bare token", () => {
    expect(parseNamedToken("deadbeefonly")).toBeNull();
  });

  it("returns null when name is invalid or missing", () => {
    expect(parseNamedToken(".secret")).toBeNull();
    expect(parseNamedToken("name.")).toBeNull();
    expect(parseNamedToken("bad name.secret")).toBeNull();
  });

  it("keeps dots inside the secret half", () => {
    expect(parseNamedToken("admin.a.b.c")).toEqual({
      name: "admin",
      secret: "a.b.c",
    });
  });
});

describe("isValidFolderName", () => {
  it("accepts allowed characters", () => {
    expect(isValidFolderName("My_Folder.1-2")).toBe(true);
  });
  it("rejects empty and illegal characters", () => {
    expect(isValidFolderName("")).toBe(false);
    expect(isValidFolderName("bad/slash")).toBe(false);
  });
});
