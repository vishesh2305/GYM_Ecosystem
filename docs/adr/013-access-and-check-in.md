# 013. Member accounts, gym passes and check-in

- Status: accepted
- Date: 2026-11-25

## Decision

**Member accounts.** A member record belongs to the app user whose verified phone matches the phone the gym has
on file. `app.my_gyms()` (SECURITY DEFINER) links such records and lists them across gyms. It is owned by the
`app_member_directory` role (BYPASSRLS, column grants only: user phone, member id/tenant/name/phone/user/deleted,
organisation id/name/deleted); `app_user` may only execute it, and the background-job role `app_system` gains
nothing. Member routes live under `/v1/me/gyms/{orgId}` and resolve the member through this function.

**Gym pass.** Each member has a TOTP secret (AES-256-GCM, same key as staff two-step codes): SHA-1, 8 digits,
30 s. The app shows `gp1.<memberId>.<code>` as a QR code; it works offline. Codes are checked with one step of
clock difference either way and used up with a conditional update on `last_counter`, so a code works once and an
older code never works after a newer one, even under simultaneous scans.

**Kiosks.** Owners and managers register devices per branch. The token `kio.<orgId>.<secret>` is shown once and
stored as SHA-256; the org id selects the tenant scope before the lookup. Devices send `x-kiosk-token`; revoked
devices are refused at once.

**Check-in rules** (`entryDenial` in `@gym/domain`): a membership running today (active, trial, or pending from
its start date) whose plan covers the branch, and no unpaid invoice past its due date. Refusals are normal
answers with a reason: invalid_code, code_already_used, no_active_membership, membership_paused, wrong_branch,
dues_unpaid. Front desk applies the same rules and may check in members of any branch the plan covers.

**Visits and occupancy.** `check_ins` has one open visit per member (partial unique index; inserts are
`ON CONFLICT DO NOTHING`). Walking into another branch ends the open visit there. The head count is computed in
Postgres from open visits younger than `CHECKIN_AUTO_OUT_HOURS` (default 3) instead of a Redis counter, so it
cannot drift; 1,000 simultaneous check-ins are counted exactly. Each change writes `branch.occupancy_changed`
to the outbox in the same transaction, for the realtime channel `branch:{id}:occupancy`. An hourly job ends
forgotten visits at check-in + `CHECKIN_AUTO_OUT_HOURS`.

## Not yet done

- Guest passes and day visitors: with leads (A15).
- Delivering `branch.occupancy_changed` to apps over a realtime channel: with notifications/realtime (A14).
- Linking by verified email for members without a phone; resetting a member's pass secret.
- Load test with k6 (p95 < 300 ms): with hardening (A18).
- Plan branches are read from the plan at check-in time, so a later plan edit applies to existing members.
