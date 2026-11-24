# 005. Authentication

- Status: accepted
- Date: 2026-11-24

## Decision

- Members: phone OTP (primary), Google and Apple sign-in; email magic link as fallback. Passkeys in Phase 2.
- Owners, staff, admins: same sign-in plus mandatory TOTP MFA.
- Tokens: 15-minute JWT access token; rotating refresh token with reuse detection (reuse revokes the whole session family).
- Tokens on mobile stored in Keychain/Keystore only.

## Consequences

SMS/OTP provider cost and DLT registration (India) needed before launch.
