import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../src/common/crypto";

const key = randomBytes(32);

describe("encrypt / decrypt (AES-256-GCM)", () => {
  it("round-trips and produces a different ciphertext each time", () => {
    const a = encrypt("JBSWY3DPEHPK3PXP", key);
    const b = encrypt("JBSWY3DPEHPK3PXP", key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("detects tampering and wrong keys", () => {
    const sealed = Buffer.from(encrypt("secret", key), "base64");
    sealed.writeUInt8(sealed.readUInt8(sealed.length - 1) ^ 1, sealed.length - 1);
    expect(() => decrypt(sealed.toString("base64"), key)).toThrow();
    expect(() => decrypt(encrypt("secret", key), randomBytes(32))).toThrow();
  });
});
