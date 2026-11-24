# Phase 1 backend backlog

Launch assumption: India (INR, GST, UPI, WhatsApp, DPDP Act). Status of each story lives in the issue tracker; this file holds the acceptance criteria.

## Identity (A7)

- **ID-1 Phone OTP sign-in.** As a member I sign in with my phone number.
  - OTP is 6 digits, valid 5 minutes, stored hashed, single use.
  - Max 5 attempts per code; max 3 codes per number per 15 minutes; then 429.
- **ID-2 Social sign-in.** Google and Apple ID tokens verified server-side; account linked by verified email.
- **ID-3 Sessions.** Access token 15 min; refresh token rotates on every use; reusing an old refresh token revokes all tokens in that family. User can list and revoke devices.
- **ID-4 Staff MFA.** Owner/manager/front-desk/admin roles must complete TOTP before any tenant endpoint; recovery codes issued once.
- **ID-5 Consents.** Each consent stores purpose, policy version, timestamp; withdrawal is recorded, not deleted.

## Tenancy (A8)

- **TN-1 Organisation onboarding.** Owner creates organisation and first branch (name, address, GSTIN optional, time zone).
- **TN-2 Staff invites and roles.** Owner invites staff by phone/email with role + branch scope; invite expires in 7 days.
- **TN-3 Isolation.** Any request with tenant A's token for tenant B's resource returns 404; checked for every endpoint by the cross-tenant test matrix.

## Membership (A9)

- **MB-1 Plans.** Create plans with duration (days/months), price (minor units), GST rate, joining fee, trial flag, branch availability.
- **MB-2 Enrol member.** Staff enrols a member on a plan; start date may be future; invoice created.
- **MB-3 Status machine.** trial → active → frozen → active → expired → cancelled; illegal transitions return 409.
- **MB-4 Freeze.** Freeze for N days extends expiry by N days; max freezes per plan configurable.
- **MB-5 Upgrade with proration.** Unused value of current plan credited using `allocate()`; never loses a paisa.
- **MB-6 Import.** CSV/XLSX up to 10,000 rows processed as a job; report lists each failed row and reason.

## Billing (A10)

- **BL-1 Invoices.** Sequential number per branch per financial year; CGST/SGST or IGST split; PDF available.
- **BL-2 Online payment.** Razorpay order → payment → webhook marks invoice paid; membership activates.
- **BL-3 UPI AutoPay.** Mandate created at enrolment; renewals charged automatically; failure starts dunning.
- **BL-4 Cash/manual payment.** Staff records cash/UPI-to-QR payments with reference; audited.
- **BL-5 Refunds.** Partial or full; cannot exceed captured amount; ledger reversed.
- **BL-6 Ledger.** Every money event writes balanced entries; property test proves balance after any sequence.
- **BL-7 Dunning.** Failed renewals: reminders on day 0, 2, 5; membership set to `expired` after grace days.

## Access (A11)

- **AC-1 Rotating QR.** Member QR changes every 30 s; ±1 window clock skew; each code accepted once.
- **AC-2 Kiosk check-in.** Kiosk device authenticated per branch; check-in denied with reason (expired, unpaid, wrong branch).
- **AC-3 Occupancy.** Live count per branch published within 1 s of check-in/out; auto check-out after configurable hours.

## Scheduling (A12)

- **SC-1 Class schedule.** Recurring classes with capacity, room, instructor.
- **SC-2 Booking and waitlist.** Never overbooked under concurrency; waitlist promoted in order on cancellation.
- **SC-3 Cancellation and no-show rules.** Late cancel / no-show counted; optional booking block after N no-shows.

## Training (A13)

- **TR-1 Exercise library.** Seeded list with muscles, equipment, media reference.
- **TR-2 Workout log.** Sets with reps, weight (grams), RPE; works offline and syncs.
- **TR-3 PRs.** Detect weight, reps and estimated 1RM records per exercise.

## Notifications (A14)

- **NT-1 Templates and channels.** Push, WhatsApp, SMS, email via adapters; per-locale templates.
- **NT-2 Preferences and quiet hours.** Respected for every non-critical message.
- **NT-3 Journeys.** Renewal due (7/3/1 days), payment failed, class reminder (2 h), inactive 7 days.

## CRM and reports (A15)

- **CR-1 Leads.** Capture from public gym page and walk-in; stages; follow-up tasks.
- **CR-2 Owner reports.** Revenue, dues, attendance heatmap, active members, renewals due; numbers match seeded fixtures.
- **CR-3 Public gym page API.** Plans, schedule, address; no private fields; cached.

## Admin and privacy (A16)

- **AD-1 Tenant admin.** Platform staff view tenants, KYC status, feature flags; impersonation requires consent and is audited.
- **PR-1 Data export.** User downloads all their personal data as JSON within 24 h.
- **PR-2 Account deletion.** Personal data deleted or anonymised across all modules within 30 days; financial records kept as legally required, de-identified.
