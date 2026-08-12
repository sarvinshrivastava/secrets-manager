import crypto from "node:crypto";

// Static salt for master key PBKDF2 — not a secret, prevents offline rainbow tables.
// Changing this invalidates all stored secrets (requires re-encryption migration).
const MASTER_KEY_SALT = Buffer.from("secret-manager-master-key-v1");
const MASTER_KEY_ITERATIONS = 210000;

export class CryptoManager {
  constructor(masterKey) {
    // New: PBKDF2 derivation — same iteration count as token hashing
    this.key = crypto.pbkdf2Sync(
      masterKey,
      MASTER_KEY_SALT,
      MASTER_KEY_ITERATIONS,
      32,
      "sha256",
    );
    // Legacy SHA256 key — used only during startup migration of old encrypted secrets
    this.legacyKey = crypto
      .createHash("sha256")
      .update(masterKey, "utf8")
      .digest();
  }

  encryptValue(value) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return { nonce, ciphertext: Buffer.concat([ciphertext, tag]) };
  }

  decryptValue(nonce, ciphertextWithTag) {
    return this._decrypt(this.key, nonce, ciphertextWithTag);
  }

  // Used only during startup migration to re-encrypt legacy SHA256-encrypted secrets
  decryptWithLegacyKey(nonce, ciphertextWithTag) {
    return this._decrypt(this.legacyKey, nonce, ciphertextWithTag);
  }

  _decrypt(key, nonce, ciphertextWithTag) {
    if (!Buffer.isBuffer(nonce) || !Buffer.isBuffer(ciphertextWithTag)) {
      throw new Error("Invalid encrypted payload");
    }
    if (ciphertextWithTag.length < 16) {
      throw new Error("Ciphertext is too short");
    }

    const ciphertext = ciphertextWithTag.subarray(
      0,
      ciphertextWithTag.length - 16,
    );
    const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  }

  hashToken(token, salt = null) {
    const chosenSalt = salt || crypto.randomBytes(16);
    const digest = crypto.pbkdf2Sync(
      token,
      chosenSalt,
      MASTER_KEY_ITERATIONS,
      32,
      "sha256",
    );
    return { salt: chosenSalt, digest };
  }

  // Async variant — runs the 210k-iter PBKDF2 on libuv's threadpool so a single
  // auth attempt does NOT block the event loop (the hot path for every request).
  hashTokenAsync(token, salt) {
    return new Promise((resolve, reject) => {
      crypto.pbkdf2(
        token,
        salt,
        MASTER_KEY_ITERATIONS,
        32,
        "sha256",
        (err, digest) => {
          if (err) reject(err);
          else resolve(digest);
        },
      );
    });
  }

  verifyToken(token, salt, digest) {
    const candidate = this.hashToken(token, salt).digest;
    // timingSafeEqual throws RangeError on length mismatch — a truncated/corrupt
    // stored digest would otherwise 500 every auth attempt. Guard the length first.
    if (candidate.length !== digest.length) return false;
    return crypto.timingSafeEqual(candidate, digest);
  }

  async verifyTokenAsync(token, salt, digest) {
    const candidate = await this.hashTokenAsync(token, salt);
    if (candidate.length !== digest.length) return false;
    return crypto.timingSafeEqual(candidate, digest);
  }
}
