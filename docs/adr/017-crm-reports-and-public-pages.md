# 017. Leads, owner reports and public gym pages

- Status: accepted
- Date: 2026-11-25

## Decision

**Leads.** A lead is someone who might join, per branch, with a source (walk-in, phone, website, referral,
social, other) and a stage: new → contacted → trial_booked → trial_done → won | lost. Losing needs a reason;
`won` is reached only through convert, which links the member who already has the lead's phone or creates one,
and is idempotent; a won lead cannot be edited. A partial unique index keeps one open lead per phone per gym,
so a repeated enquiry updates it. Booking a trial adds a follow-up task for the next day. Tasks are listed
soonest first (`mine=true` for the caller's). Owners, managers and front desk use leads; branch-limited staff
see their branches' leads only; trainers do not.

**Reports.** Five read-only endpoints under `/reports`, for owners and gym-wide managers (branch-limited staff
get 403, since the numbers cover the whole gym): summary (today's key numbers), revenue (captured payments and
refunds per day and method), dues (unpaid invoices by days past due), attendance (visits by weekday and hour)
and retention (members by the month they first started, and how many still had a membership k months later; a
membership counts unless pending or cancelled). Dates are the gym's calendar dates in its time zone; ranges
default to 30 days and are capped at 366. They are plain SQL over the live tables in the gym's RLS scope, read
through `READ_DB`: the replica at `DATABASE_READ_URL` when set, otherwise the primary. Materialised views wait
until these queries are measured slow on real data.

**Public gym pages.** An owner sets `slug`, `about` and `published` on the organisation (a slug is unique and
needed before publishing). `/v1/public/gyms/{slug}` and `/schedule` need no sign-in; the gym is found with
`app.published_gym(slug)`, a SECURITY DEFINER lookup owned by `app_member_directory` that returns only the id of
a published gym, and everything else is read in that gym's RLS scope with explicit column lists. Responses carry
`Cache-Control: public, max-age=60, s-maxage=300`. The enquiry form (`POST …/enquiries`) needs consent, is
limited to 5 per minute per visitor, always answers 202 (so it reveals nothing about who has been in touch) and
creates or updates a `website` lead. Tests pin the exact public response shape and check that private values
never appear.

## Not yet done

- Reviews on the public page (there is no reviews feature yet), trainer names and photos, a CDN in front (A17).
- Lead sources from ads (UTM tags), automatic assignment rules, WhatsApp follow-ups from the lead screen.
- Report exports (CSV/PDF), per-branch reports for branch managers, materialised views once data volume needs
  them.
