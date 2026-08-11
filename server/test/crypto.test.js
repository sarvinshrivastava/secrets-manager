import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { CryptoManager } from "../src/crypto.js";
import { cryptoManager } from "./helpers.js";

describe("CryptoManager encryption", () => {
  it("round-trips a value", () => {
    const enc = cryptoManager.encryptValue("hunter2");
    expect(cryptoManager.decryptValue(enc.nonce, enc.ciphertext)).toBe(
      "hunter2",
    );
  });

  it("round-trips unicode and empty strings", () => {
    for (const v of ["", "🔐 pÄss", "a\nb\tc"]) {
      const enc = cryptoManager.encryptValue(v);
      expect(cryptoManager.decryptValue(enc.nonce, enc.ciphertext)).toBe(v);
    }
  });

  it("uses a fresh nonce per encryption", () => {
    const a = cryptoManager.encryptValue("same");
    const b = cryptoManager.encryptValue("same");
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("rejects a tampered ciphertext (GCM auth tag)", () => {
    const enc = cryptoManager.encryptValue("tamper-me");
    const bad = Buffer.from(enc.ciphertext);
    bad[0] ^= 0xff;
    expect(() => cryptoManager.decryptValue(enc.nonce, bad)).toThrow();
  });

  it("rejects too-short ciphertext", () => {
    expect(() =>
      cryptoManager.decryptValue(Buffer.alloc(12), Buffer.alloc(4)),
    ).toThrow();
  });

  it("migrates a legacy SHA256-encrypted value", () => {
    // Simulate a value encrypted under the OLD sha256-derived key.
    const legacyKey = crypto
      .createHash("sha256")
      .update("test-master-key-do-not-use-in-prod", "utf8")
      .digest();
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", legacyKey, nonce);
    const ct = Buffer.concat([
      cipher.update("legacy-secret", "utf8"),
      cipher.final(),
    ]);
    const withTag = Buffer.concat([ct, cipher.getAuthTag()]);

    expect(cryptoManager.decryptWithLegacyKey(nonce, withTag)).toBe(
      "legacy-secret",
    );
    // New key must NOT decrypt it (proves migration is actually needed).
    expect(() => cryptoManager.decryptValue(nonce, withTag)).toThrow();
  });
});

describe("CryptoManager token hashing", () => {
  it("verifyToken accepts the correct token", () => {
    const { salt, digest } = cryptoManager.hashToken("abc123");
    expect(cryptoManager.verifyToken("abc123", salt, digest)).toBe(true);
    expect(cryptoManager.verifyToken("wrong", salt, digest)).toBe(false);
  });

  it("verifyToken returns false (not throw) on digest length mismatch", () => {
    const { salt, digest } = cryptoManager.hashToken("abc123");
    const truncated = digest.subarray(0, 16); // corrupt/truncated stored hash
    expect(() =>
      cryptoManager.verifyToken("abc123", salt, truncated),
    ).not.toThrow();
    expect(cryptoManager.verifyToken("abc123", salt, truncated)).toBe(false);
  });

  it("verifyTokenAsync matches and guards length", async () => {
    const { salt, digest } = cryptoManager.hashToken("async-tok");
    await expect(
      cryptoManager.verifyTokenAsync("async-tok", salt, digest),
    ).resolves.toBe(true);
    await expect(
      cryptoManager.verifyTokenAsync("async-tok", salt, digest.subarray(0, 8)),
    ).resolves.toBe(false);
  });

  it("uses a distinct random salt each hash", () => {
    const a = cryptoManager.hashToken("x");
    const b = cryptoManager.hashToken("x");
    expect(a.salt.equals(b.salt)).toBe(false);
  });

  it("constructor derives a 32-byte key", () => {
    const cm = new CryptoManager("another-key");
    expect(cm.key.length).toBe(32);
  });
});
