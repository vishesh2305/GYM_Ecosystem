# 016. Member messages: channels, preferences and journeys

- Status: accepted
- Date: 2026-11-25

## Decision

**Queue.** Every message to a member is a row in `notifications` (tenant RLS), queued with `notify(tx, …)` in
the same transaction as its cause. `dedupe_key` is unique per gym, so each trigger sends at most once however
often it fires (retried events, repeated job runs): `renewal_due:<membership>:<days>`,
`class_reminder:<booking>`, `class_cancelled:<session>:<member>`, `waitlist_promoted:<booking>`,
`payment_due:<invoice>:<attempt>`, `payment_failed:<payment>`, `inactive:<member>:<last visit>`. Variables are
stored raw and formatted when sent, in the member's language and the gym's time zone.

**Templates.** Code, not data: `MESSAGE_TEMPLATES` in the domain package, English and Hindi, each with a
category (service, reminders, engagement), an urgent flag and its variables in order. The same key names the
WhatsApp template registered with Meta and the DLT SMS template (`MSG91_TEMPLATE_IDS`), whose variables take
the same order. Per-gym wording is not supported yet.

**Channels.** A `ChannelAdapter` port with adapters for Expo push (FCM and APNs), the WhatsApp Business Cloud
API, DLT SMS through MSG91 and email (SMTP/SES); console adapters log in development and are refused in
production (WhatsApp may be "off"). The order tried is push → WhatsApp → SMS → email, keeping the channels the
member can be reached on and has not switched off. A provider error moves on to the next channel; when all
fail, the message is retried `NOTIFY_RETRY_MINUTES` later, up to `NOTIFY_MAX_ATTEMPTS`, then marked failed
with every reason. Messages are skipped when expired (class messages expire at the class start), muted,
unreachable or for a removed member. The front desk sees each member's messages.

**Push tokens.** `push_devices` belongs to the person (user RLS). Gyms reach tokens only through SECURITY
DEFINER functions owned by `app_member_directory`: `app.member_push_tokens(member)` returns the tokens of the
person linked to one of the current gym's members, `app.disable_push_tokens` turns off tokens Expo reports as
`DeviceNotRegistered`, and `app.register_push_device` moves a token to whoever registers it last (a shared or
handed-down phone). The app removes its device on sign-out.

**Delivery.** The worker runs `runNotificationDelivery` every `NOTIFY_POLL_MS` (30 s): per gym, due rows are
claimed with `FOR UPDATE SKIP LOCKED`, at most `NOTIFY_PER_GYM_PER_RUN` per run, so one gym's burst cannot
starve the others. Providers are called inside the claiming transaction (fine at this volume; claim-then-send
if runs get long).

**Preferences and quiet hours.** `notification_preferences` (one row per member, defaults when absent):
language, channels switched off, muted categories (reminders, engagement; service messages about payments and
cancellations cannot be muted) and quiet hours in the gym's time zone, 21:00–08:00 by default. A non-urgent
message due in quiet hours is held until they end without counting an attempt; urgent ones (class cancelled,
waitlist place) go at once.

**Journeys.** Events: `booking.promoted`, `class_session.cancelled`, `invoice.payment_reminder` and the new
`payment.failed` (AutoPay charge refused, gateway webhook `payment.failed`) each queue a message from a worker
handler. Every 15 minutes `runJourneys` looks at the data per gym: renewals 7, 3 and 1 days before the end
(not when a later membership exists or AutoPay is active), class reminders for confirmed places starting
within 2 hours, and members with a running membership absent for 7 days.

**SMS for sign-in.** `SmsSender` now takes a DLT template key and values; one-time codes (`otp`) and staff
invites (`staff_invite`) use it too, so `SMS_PROVIDER=msg91` serves them in production.

## Not yet done

- Running the journeys in staging with sandbox providers (A17); registering the WhatsApp and DLT templates.
- Expo push receipts (only send tickets are checked), WhatsApp delivery and read webhooks.
- Per-gym template wording and on/off switches per journey, staff editing a member's preferences, marketing
  broadcasts (which need explicit consent).
- Celebrating personal records (`training.personal_record_set`) with a push, since those are per person, not
  per gym.
