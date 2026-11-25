# 014. Classes, bookings, waitlists and personal training

- Status: accepted
- Date: 2026-11-25

## Decision

**Timetable.** A class is a weekly pattern (weekdays, "HH:MM" in the gym's time zone, start and optional end
date, capacity, duration, room, instructor, cancellation window). Concrete `class_sessions` are generated 14
days ahead, at once on creation and hourly after that; they are unique per class and start time, so generation
is idempotent. Wall-clock times are turned into instants with `zonedTime` (daylight-saving gaps take the later
instant, repeated times the first). Editing a class changes its upcoming sessions; days and times cannot be
edited (archive and create a new class). Archiving cancels upcoming sessions.

**Bookings.** Every change to a session's places locks the session row (`SELECT … FOR UPDATE`): a booking is
confirmed while confirmed < capacity, otherwise waitlisted. The waitlist is served in booking id order (UUIDv7,
created under the lock). One live booking per member per session (partial unique index); booking again returns
it. Cancelling a confirmed booking promotes the first waiting member (`booking.promoted`); raising capacity does
the same. Cancelling a confirmed booking later than `cancel_window_minutes` before the start is
`late_cancelled`. Booking applies the check-in rules (`entryDenialFor`) on the session's date: a running
membership whose plan covers the branch and no overdue dues. Cancelling a session releases all its bookings and
emits `class_session.cancelled` with the members concerned.

**Attendance.** Hourly, each ended session is settled once: a confirmed booking is `attended` if the member
checked in at that branch from an hour before the start until the end, else `no_show`; waiting members are
released. Staff and trainers can mark attendance once a session has started. `NO_SHOW_LIMIT` (0 = off) pauses
app booking after that many no-shows in 30 days; staff can still book.

**Personal training.** A `pt` session with one place, booked by staff (trainers only for themselves) for a
member. Overlapping sessions of the same trainer are refused under a per-trainer advisory lock. Cancelling the
booking cancels the session, freeing the trainer's time.

## Not yet done

- Members booking personal training themselves (needs trainer availability) and recurring PT packages/credits.
- Sending the reminders and notices (`booking.promoted`, `class_session.cancelled`, class reminders): A14.
- A per-gym no-show limit instead of the `NO_SHOW_LIMIT` setting, and late-cancellation fees.
