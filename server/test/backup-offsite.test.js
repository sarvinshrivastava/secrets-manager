import { describe, it, expect } from "vitest";
import { Encrypter, Decrypter, generateIdentity } from "age-encryption";

describe("age-encryption dependency", () => {
  it("exports the encrypt/decrypt API", () => {
    expect(typeof Encrypter).toBe("function");
    expect(typeof Decrypter).toBe("function");
    expect(typeof generateIdentity).toBe("function");
  });
});
