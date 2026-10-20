import { describe, it, expect, beforeAll } from "vitest";
import {
  generateIdentity,
  generateHybridIdentity,
  identityToRecipient,
} from "age-encryption";
import { parseBackupSettings, loadSettings } from "../src/config.js";

// Pure-input tests only: every call passes an explicit env object, so a
// developer's .env or process.env can never leak in.
let R1;
let R2;
let RPQ;
const TOKEN = "github_pat_test_value_never_logged";
const PUSH = "https://kuma.example/api/push/abcPUSHSECRET";

beforeAll(async () => {
  R1 = await identityToRecipient(await generateIdentity());
  R2 = await identityToRecipient(await generateIdentity());
  RPQ = await identityToRecipient(await generateHybridIdentity());
});

function offsiteEnv(extra = {}) {
  return {
    NODE_ENV: "production",
    SECRET_MANAGER_BACKUP_DIR: "/app/backups",
    SECRET_MANAGER_BACKUP_AGE_RECIPIENT: R1,
    SECRET_MANAGER_BACKUP_GITHUB_REPO: "someone/vault-backups",
    SECRET_MANAGER_BACKUP_GITHUB_TOKEN: TOKEN,
    SECRET_MANAGER_BACKUP_PUSH_URL: PUSH,
    ...extra,
  };
}

function expectNoValuesIn(s, env) {
  const text = JSON.stringify([s.localErrors, s.offsiteErrors]);
  for (const v of Object.values(env)) {
    if (v && v.length > 3) expect(text).not.toContain(v);
  }
}

describe("parseBackupSettings", () => {
  it("is disabled when the dir is unset", () => {
    expect(parseBackupSettings({})).toEqual({ enabled: false });
    expect(
      parseBackupSettings({ SECRET_MANAGER_BACKUP_GITHUB_TOKEN: TOKEN }),
    ).toEqual({ enabled: false });
  });

  it("parses local-only settings with defaults", () => {
    const s = parseBackupSettings({ SECRET_MANAGER_BACKUP_DIR: "/app/backups" });
    expect(s).toMatchObject({
      enabled: true,
      dir: "/app/backups",
      time: { hour: 22, minute: 30 },
      keepDays: 14,
      offsite: null,
      pushUrl: null,
      localErrors: [],
      offsiteErrors: [],
      offsiteDisabledReason: null,
    });
  });

  it("resolves a relative dir to an absolute path", () => {
    const s = parseBackupSettings({ SECRET_MANAGER_BACKUP_DIR: "backups" });
    expect(s.dir.startsWith("/")).toBe(true);
    expect(s.dir.endsWith("/backups")).toBe(true);
  });

  it("parses a full off-site config in production", () => {
    const s = parseBackupSettings(offsiteEnv());
    expect(s.offsiteErrors).toEqual([]);
    expect(s.pushUrl).toBe(PUSH);
    expect(s.offsite).toEqual({
      recipients: [R1],
      owner: "someone",
      repo: "vault-backups",
      tag: "daily",
      token: TOKEN,
      keepDaily: 30,
      keepMonthly: 12,
    });
  });

  it("disables off-site and Kuma outside production, with no error code", () => {
    const env = offsiteEnv();
    delete env.NODE_ENV;
    const s = parseBackupSettings(env);
    expect(s.offsite).toBeNull();
    expect(s.pushUrl).toBeNull();
    expect(s.offsiteDisabledReason).toBe("nonprod");
    expect(s.offsiteErrors).toEqual([]);
    expect(s.localErrors).toEqual([]);
  });

  it("allows off-site outside production with the explicit override", () => {
    const env = offsiteEnv({ SECRET_MANAGER_BACKUP_ALLOW_NONPROD: "1" });
    delete env.NODE_ENV;
    expect(parseBackupSettings(env).offsite).not.toBeNull();
  });

  for (const key of [
    "SECRET_MANAGER_BACKUP_AGE_RECIPIENT",
    "SECRET_MANAGER_BACKUP_GITHUB_REPO",
    "SECRET_MANAGER_BACKUP_GITHUB_TOKEN",
  ]) {
    it(`missing ${key} → config_invalid, push URL kept`, () => {
      const env = offsiteEnv();
      delete env[key];
      const s = parseBackupSettings(env);
      expect(s.offsite).toBeNull();
      expect(s.offsiteErrors).toEqual(["config_invalid"]);
      expect(s.pushUrl).toBe(PUSH);
      expectNoValuesIn(s, env);
    });
  }

  it("missing push URL → config_invalid (no off-site without a dead-man)", () => {
    const env = offsiteEnv();
    delete env.SECRET_MANAGER_BACKUP_PUSH_URL;
    const s = parseBackupSettings(env);
    expect(s.offsite).toBeNull();
    expect(s.pushUrl).toBeNull();
    expect(s.offsiteErrors).toEqual(["config_invalid"]);
  });

  it("parses a custom tag and two comma-separated recipients", () => {
    const s = parseBackupSettings(
      offsiteEnv({
        SECRET_MANAGER_BACKUP_GITHUB_RELEASE_TAG: "nightly",
        SECRET_MANAGER_BACKUP_AGE_RECIPIENT: `${R1}, ${R2}`,
      }),
    );
    expect(s.offsite.tag).toBe("nightly");
    expect(s.offsite.recipients).toEqual([R1, R2]);
  });

  it("accepts a hybrid post-quantum recipient", () => {
    const s = parseBackupSettings(
      offsiteEnv({ SECRET_MANAGER_BACKUP_AGE_RECIPIENT: RPQ }),
    );
    expect(RPQ.startsWith("age1pq1")).toBe(true);
    expect(s.offsite.recipients).toEqual([RPQ]);
  });

  for (const bad of [
    "age1tag1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    "age1tagpq1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    "age1notavalidbech32string",
    "ssh-ed25519 AAAAC3Nza",
    "garbage",
  ]) {
    it(`rejects recipient ${bad.slice(0, 12)}… as config_invalid`, () => {
      const env = offsiteEnv({ SECRET_MANAGER_BACKUP_AGE_RECIPIENT: bad });
      const s = parseBackupSettings(env);
      expect(s.offsite).toBeNull();
      expect(s.offsiteErrors).toEqual(["config_invalid"]);
      expectNoValuesIn(s, env);
    });
  }

  for (const [key, value] of [
    ["SECRET_MANAGER_BACKUP_AGE_RECIPIENT", "AGE-SECRET-KEY-1QQQQ"],
    ["SECRET_MANAGER_BACKUP_GITHUB_TOKEN", "age-secret-key-1qqqq"],
    ["FOO", "AGE-SECRET-KEY-1QQQQ"],
    ["BAR", "AGE-PLUGIN-YUBIKEY-1QQQ"],
  ]) {
    it(`private key marker in ${key} → private_key_on_vps`, () => {
      const env = offsiteEnv({ [key]: value });
      const s = parseBackupSettings(env);
      expect(s.offsite).toBeNull();
      expect(s.offsiteErrors).toEqual(["private_key_on_vps"]);
      expect(JSON.stringify(s.offsiteErrors)).not.toContain(value);
    });
  }

  for (const bad of ["24:00", "7:5", "ab", "-1:00", "12:60"]) {
    it(`bad UTC_TIME ${bad} → 22:30 and localErrors config_invalid`, () => {
      const s = parseBackupSettings({
        SECRET_MANAGER_BACKUP_DIR: "/b",
        SECRET_MANAGER_BACKUP_UTC_TIME: bad,
      });
      expect(s.time).toEqual({ hour: 22, minute: 30 });
      expect(s.localErrors).toEqual(["config_invalid"]);
    });
  }

  it("accepts a custom UTC_TIME", () => {
    const s = parseBackupSettings({
      SECRET_MANAGER_BACKUP_DIR: "/b",
      SECRET_MANAGER_BACKUP_UTC_TIME: "00:00",
    });
    expect(s.time).toEqual({ hour: 0, minute: 0 });
    expect(s.localErrors).toEqual([]);
  });

  for (const bad of ["0", "-3", "abc", "1.5"]) {
    it(`bad KEEP_DAYS ${bad} → 14 and localErrors config_invalid`, () => {
      const s = parseBackupSettings({
        SECRET_MANAGER_BACKUP_DIR: "/b",
        SECRET_MANAGER_BACKUP_KEEP_DAYS: bad,
      });
      expect(s.keepDays).toBe(14);
      expect(s.localErrors).toEqual(["config_invalid"]);
    });
  }

  it("bad local keys do not block a valid off-site config", () => {
    const s = parseBackupSettings(
      offsiteEnv({ SECRET_MANAGER_BACKUP_UTC_TIME: "99:99" }),
    );
    expect(s.localErrors).toEqual(["config_invalid"]);
    expect(s.offsite).not.toBeNull();
  });

  for (const [key, value] of [
    ["SECRET_MANAGER_BACKUP_GITHUB_REPO", "no-slash"],
    ["SECRET_MANAGER_BACKUP_GITHUB_REPO", "a/b/c"],
    ["SECRET_MANAGER_BACKUP_GITHUB_REPO", "a b/c"],
    ["SECRET_MANAGER_BACKUP_PUSH_URL", "http://kuma.example/api/push/x"],
    ["SECRET_MANAGER_BACKUP_PUSH_URL", "not a url"],
    ["SECRET_MANAGER_BACKUP_REMOTE_KEEP_DAILY", "0"],
    ["SECRET_MANAGER_BACKUP_REMOTE_KEEP_MONTHLY", "x"],
  ]) {
    it(`invalid ${key}=${value} → config_invalid`, () => {
      const env = offsiteEnv({ [key]: value });
      const s = parseBackupSettings(env);
      expect(s.offsite).toBeNull();
      expect(s.offsiteErrors).toEqual(["config_invalid"]);
      expectNoValuesIn(s, env);
    });
  }

  it("never throws on odd input", () => {
    expect(() =>
      parseBackupSettings({
        NODE_ENV: "production",
        SECRET_MANAGER_BACKUP_DIR: "/b",
        SECRET_MANAGER_BACKUP_AGE_RECIPIENT: ",,,",
        SECRET_MANAGER_BACKUP_UTC_TIME: "",
        SECRET_MANAGER_BACKUP_KEEP_DAYS: "",
        SECRET_MANAGER_BACKUP_PUSH_URL: "https://",
      }),
    ).not.toThrow();
  });
});

describe("loadSettings backup wiring", () => {
  it("still throws without a master key", () => {
    expect(() => loadSettings({ SECRET_MANAGER_BACKUP_DIR: "/b" })).toThrow(
      /MASTER_KEY/,
    );
  });

  it("returns a backup object", () => {
    const s = loadSettings({
      SECRET_MANAGER_MASTER_KEY: "k",
      SECRET_MANAGER_BACKUP_DIR: "/b",
    });
    expect(s.backup.enabled).toBe(true);
    expect(s.backup.dir).toBe("/b");
  });
});
