import { describe, it, expect } from "vitest";
import { parseEnvText } from "./parseEnv.js";

// Convenience: index rows by key for terse assertions.
function byKey(rows) {
  const map = {};
  rows.forEach((r) => {
    map[r.key] = r;
  });
  return map;
}

describe("parseEnvText", () => {
  it("ignores blank lines and comments", () => {
    const rows = parseEnvText("\n\n  \n# a comment\n#another\n", new Set());
    expect(rows).toHaveLength(0);
  });

  it("parses a simple key=value as add", () => {
    const rows = parseEnvText("API_KEY=abc123", new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      line: 1,
      key: "API_KEY",
      value: "abc123",
      status: "add",
    });
  });

  it("strips a leading `export `", () => {
    const rows = parseEnvText("export TOKEN=xyz", new Set());
    expect(rows[0]).toMatchObject({
      key: "TOKEN",
      value: "xyz",
      status: "add",
    });
  });

  it("supports `:` as a separator", () => {
    const rows = parseEnvText("HOST: localhost", new Set());
    expect(rows[0]).toMatchObject({
      key: "HOST",
      value: "localhost",
      status: "add",
    });
  });

  it("trims spaces around the separator", () => {
    const rows = parseEnvText("KEY   =   value  ", new Set());
    expect(rows[0]).toMatchObject({ key: "KEY", value: "value" });
  });

  it("splits on the FIRST separator only", () => {
    const rows = parseEnvText("DB_URL=postgres://u:p@host:5432/db", new Set());
    expect(rows[0]).toMatchObject({
      key: "DB_URL",
      value: "postgres://u:p@host:5432/db",
      status: "add",
    });
  });

  it("strips matching double quotes", () => {
    const rows = parseEnvText('NAME="hello world"', new Set());
    expect(rows[0].value).toBe("hello world");
  });

  it("strips matching single quotes", () => {
    const rows = parseEnvText("NAME='hello world'", new Set());
    expect(rows[0].value).toBe("hello world");
  });

  it("keeps a `#` inside a quoted value but drops the trailing comment", () => {
    const rows = parseEnvText('PASS="p#ss" # my password', new Set());
    expect(rows[0].value).toBe("p#ss");
  });

  it("strips an inline comment from an unquoted value", () => {
    const rows = parseEnvText("PORT=8080 # the port", new Set());
    expect(rows[0].value).toBe("8080");
  });

  it("does not treat a bare `#` (no leading space) as a comment", () => {
    const rows = parseEnvText("HASH=ab#cd", new Set());
    expect(rows[0].value).toBe("ab#cd");
  });

  it("flags an empty value as empty (still addable)", () => {
    const rows = parseEnvText("EMPTY=", new Set());
    expect(rows[0]).toMatchObject({ key: "EMPTY", value: "", status: "empty" });
  });

  it("flags a key already in the vault as exists", () => {
    const rows = parseEnvText("API_KEY=new", new Set(["API_KEY"]));
    expect(rows[0]).toMatchObject({ key: "API_KEY", status: "exists" });
    expect(rows[0].reason).toBe("already in vault");
  });

  it("marks an invalid key with a bad character", () => {
    const rows = parseEnvText("bad-key=value", new Set());
    expect(rows[0].status).toBe("invalid");
    expect(rows[0].reason).toMatch(/must match/);
  });

  it("marks a key starting with a digit as invalid", () => {
    const rows = parseEnvText("1KEY=value", new Set());
    expect(rows[0].status).toBe("invalid");
  });

  it("marks a line with no separator as invalid", () => {
    const rows = parseEnvText("JUST_A_LINE", new Set());
    expect(rows[0]).toMatchObject({ status: "invalid" });
    expect(rows[0].reason).toBe("no key=value separator");
  });

  it("shadows an earlier duplicate; last one wins", () => {
    const rows = parseEnvText("K=first\nK=second", new Set());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ value: "first", status: "shadowed" });
    expect(rows[0].reason).toBe("overridden by line 2");
    expect(rows[1]).toMatchObject({ value: "second", status: "add" });
  });

  it("normalises CRLF line endings", () => {
    const rows = parseEnvText("A=1\r\nB=2\r\n", new Set());
    expect(rows.map((r) => r.key)).toEqual(["A", "B"]);
  });

  it("strips a leading BOM", () => {
    const rows = parseEnvText("﻿A=1", new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "A", value: "1", status: "add" });
  });

  it("flags a multi-line quoted value (PEM) as invalid", () => {
    const rows = parseEnvText('PRIVATE_KEY="-----BEGIN KEY-----', new Set());
    expect(rows[0].status).toBe("invalid");
    expect(rows[0].reason).toBe("multi-line values not supported (v2)");
  });

  it("does not let an invalid row block a valid one", () => {
    const rows = parseEnvText("bad-key=x\nGOOD=y", new Set());
    const map = byKey(rows);
    expect(map["bad-key"].status).toBe("invalid");
    expect(map.GOOD.status).toBe("add");
  });

  it("handles a realistic mixed paste", () => {
    const text = [
      "# database",
      "export DB_HOST=localhost",
      "DB_PORT = 5432 # default",
      'DB_PASS="s3cr#t"',
      "EXISTS=whatever",
      "EXISTS=override",
      "EMPTY=",
      "bad key here",
    ].join("\n");
    const rows = parseEnvText(text, new Set(["OTHER"]));
    const map = byKey(rows);
    expect(map.DB_HOST).toMatchObject({ value: "localhost", status: "add" });
    expect(map.DB_PORT).toMatchObject({ value: "5432", status: "add" });
    expect(map.DB_PASS).toMatchObject({ value: "s3cr#t", status: "add" });
    // First EXISTS is shadowed, second wins.
    expect(rows.filter((r) => r.key === "EXISTS")[0].status).toBe("shadowed");
    expect(map.EXISTS.status).toBe("add");
    expect(map.EMPTY.status).toBe("empty");
    expect(rows.find((r) => r.status === "invalid")).toBeTruthy();
  });

  it("accepts array or Set for existingKeys, and null text", () => {
    expect(parseEnvText(null, ["X"])).toEqual([]);
    const rows = parseEnvText("X=1", ["X"]);
    expect(rows[0].status).toBe("exists");
  });
});
