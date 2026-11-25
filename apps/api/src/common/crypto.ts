import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Bearer secrets (refresh tokens, invites, kiosks) are stored only as their SHA-256. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// AES-256-GCM. Output: base64(iv[12] | tag[16] | ciphertext). Tampering or a wrong key throws on decrypt.
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function decrypt(sealed: string, key: Buffer): string {
  const raw = Buffer.from(sealed, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("sealed value is too short");
  // Pin the tag length: otherwise a forged, shorter tag could be accepted.
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
}
