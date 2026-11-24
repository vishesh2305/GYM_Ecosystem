# 009. Identity and sign-in

- Status: accepted (supersedes the details of ADR 005)
- Date: 2026-11-25

## Decision

**Accounts.** One `users` row per person across all gyms. Phone (E.164) and email (lower-case) are unique and
only stored once proven (OTP or a verified provider email). Gym membership and staff roles arrive in A8.

**Ways to sign in** (all create the account on first use and return a token pair + `isNewUser`):

- One-time code by SMS or email: 6 digits, HMAC-SHA256 (`AUTH_SECRET`) bound to the challenge id, 5-minute
  expiry, single use (atomic claim), 5 wrong attempts then locked, at most 3 codes per destination per 15 minutes,
  10 requests/min per address. Email codes replace the magic links of ADR 005 (no deep links needed on mobile).
- Google / Apple ID tokens: verified against the provider JWKS (RS256, issuer, any configured client id, expiry).
  A nonce is required (Google: raw, Apple: SHA-256). Linking: known (provider, subject) → that user; else a user
  who already proved the same verified email; else a new user. Unverified emails are never linked or stored.

**Sessions.** A session is one signed-in device; its id is the refresh-token family and the `sid` claim.
Access tokens: Ed25519 JWT (`JWT_PRIVATE_JWK`), 15 minutes, claims `sub`, `sid`, `amr`. Refresh tokens: 32 random
bytes, stored as SHA-256, 30-day expiry, rotated on every use; presenting a used refresh token revokes the whole
session and is audited. Sessions end after 90 days regardless. Sign-out writes a Redis revocation key (TTL = access
token lifetime) checked on every request, with a database fallback if Redis is down. Clients must not refresh in
parallel (single-flight), because a parallel refresh looks like token theft.

**Two-step verification.** TOTP (authenticator app, ±1 step), secret encrypted with AES-256-GCM
(`AUTH_ENCRYPTION_KEY`), a code's step can never be reused, 10 single-use recovery codes (HMAC). Five wrong
answers in 15 minutes pause verification; the counter lives in Redis and fails closed. A successful check adds
`mfa` to the session's `amr`; `@RequireMfa()` returns 403 without it. A8 applies it to staff and owner actions.

**Authorisation default.** A global guard requires a valid, unrevoked access token on every route unless the
route is `@Public()`. Public routes still recognise a valid token. Request limits and Idempotency-Key scopes
use the signed-in user, else the client address.

**Consents.** Append-only history per purpose with policy version, time, IP and user agent (DPDP Act 2023).

**Least privilege.** `app_user` has no access to any identity table.

**Senders.** `SmsSender` / `EmailSender` ports. Development uses console senders (refused in production by env
validation); email also has an SMTP adapter (Mailpit locally, SES in production). Real SMS providers come in A14.
