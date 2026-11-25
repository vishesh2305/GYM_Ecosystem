# 018. Personal data rights, retention, platform admin and support access

- Status: accepted
- Date: 2026-11-25

## Decision

**Registry.** `packages/db/src/personal-data.ts` classifies every table: personal data (what it holds, whether
it is tied to the person's account or to their member record at a gym, and whether erasure deletes, anonymises
or retains it, with the legal or security reason for retaining) or no personal data. A test fails when a table
is missing, and another checks the privacy role can read every personal-data table, so export and erasure keep
up with new tables.

**Privacy role.** Export, erasure and retention must cross gyms, which RLS forbids for request handling. They run
in the worker as `app_privacy` through `withPrivacy()`: it bypasses RLS, may read the tables, and is granted
exactly the deletes and updates erasure and retention make. Request handlers only queue `privacy_requests` (no
foreign key to users, so the record outlives an erased account).

**Export (right to access).** One JSON document: every registry table, rows found through the account and its
member records in every gym; credential columns (`*Hash`, `*Secret`, `*Enc`) removed; four short-lived system
tables listed as not included with the reason. Ready within a minute, downloadable for 7 days, one per day.

**Erasure.** Refused while the person is a gym's only owner. Otherwise all sessions are revoked at once and the
worker erases: deleting the user cascades to sign-ins, consents, devices, staff jobs and training data; member
records are anonymised and soft-deleted, messages, passes and preferences deleted, enquiries anonymised and
closed, AutoPay mandates cancelled; invoices, payments, memberships, visits and bookings are kept (tax and
accounting law), tied only to the anonymised member. An audit entry records the counts.

**Consent withdrawal.** Workouts and body data are health data: saving them needs the latest `health_data`
consent to be granted, and withdrawing it erases them at once.

**Retention.** An hourly job clears sign-in codes after a day, ended sessions and closed staff invites after 30
days, uploaded import files after 30 days, member messages after a year, and contact details of enquiries
closed a year ago. Legal records and the append-only audit log are not on the list.

**Platform admin console.** `platform_admins` is filled only by hand in the database; RLS shows a person only
their own row and nothing can insert through the API. Admins (with two-step verification) list gyms with size,
owners and KYC status, record KYC reviews, and set feature flags; this runs as `app_admin` through
`withAdmin()`, which may read what the console shows and change only KYC columns and flags. Every change is in
the audit log under the admin's id.

**Support access (impersonation with consent).** A gym owner grants the support team 1–72 hours of access with
a reason, and can revoke it. While it lasts, a platform admin with two-step verification passes the tenant
guard as a read-only owner: only GET requests, each counted on the grant (shown to the owner) and written to the
gym's audit log. Without a grant the gym does not exist for them (404).

**Checklist.** `docs/compliance/dpdp-checklist.md` maps each DPDP obligation to the test that proves it, or to
the process and owner when it is not code.

## Not yet done

- Children's data (s.9): age at sign-up and verifiable parental consent (Stage C); until then accounts are 18+.
- Disputes and chargebacks in the admin console, platform subscription plans for gyms, admin-issued refunds.
- Export files with invoice PDFs attached (object storage arrives in A17); cancelling AutoPay tokens at the
  gateway on erasure (they are cancelled locally, so no further charges are made).
- Breach runbook and alerting (A17), grievance officer and processor agreements (before launch).
