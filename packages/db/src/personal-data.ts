/**
 * Where personal data lives (DPDP Act 2023): every table in the schema is listed here, either as holding
 * personal data (with whose it is and what erasure does to it) or as holding none. A test fails when a table is
 * missing, so a new table cannot be forgotten by the export and erasure jobs.
 */

/** What erasing a person does to a table's rows about them. */
export type Erasure =
  | "delete"
  | "anonymise"
  /** Kept, with the reason the law or security requires it; the person's identifying fields are cleared elsewhere. */
  | "retain";

export interface PersonalTable {
  /** What personal data the rows hold. */
  holds: string;
  /** How rows are tied to the person: their user account, or their member record at a gym. */
  subject: "user" | "member";
  erasure: Erasure;
  /** Required for "retain": why the rows are kept. */
  reason?: string;
}

export const PERSONAL_DATA = {
  users: { holds: "name, phone, email", subject: "user", erasure: "delete" },
  sessions: { holds: "device, IP address", subject: "user", erasure: "delete" },
  refresh_tokens: { holds: "sign-in token hashes", subject: "user", erasure: "delete" },
  otp_challenges: { holds: "phone or email, IP address", subject: "user", erasure: "delete" },
  auth_identities: {
    holds: "Google / Apple account id, email",
    subject: "user",
    erasure: "delete",
  },
  user_mfa: { holds: "two-step verification secret", subject: "user", erasure: "delete" },
  recovery_codes: { holds: "recovery code hashes", subject: "user", erasure: "delete" },
  consents: { holds: "consent decisions, IP address, device", subject: "user", erasure: "delete" },
  push_devices: { holds: "phone push tokens", subject: "user", erasure: "delete" },
  staff_members: { holds: "the person's jobs at gyms", subject: "user", erasure: "delete" },
  staff_invites: { holds: "invited phone or email", subject: "user", erasure: "delete" },
  exercises: { holds: "the person's own exercises", subject: "user", erasure: "delete" },
  workouts: { holds: "workouts (health data)", subject: "user", erasure: "delete" },
  workout_sets: { holds: "sets (health data)", subject: "user", erasure: "delete" },
  workout_templates: { holds: "workout plans", subject: "user", erasure: "delete" },
  personal_records: { holds: "personal bests (health data)", subject: "user", erasure: "delete" },
  body_metrics: { holds: "body measurements (health data)", subject: "user", erasure: "delete" },
  members: {
    holds: "name, phone, email, date of birth, emergency contact, notes",
    subject: "member",
    erasure: "anonymise",
  },
  member_passes: { holds: "gym pass secret", subject: "member", erasure: "delete" },
  membership_freezes: { holds: "freeze reasons", subject: "member", erasure: "anonymise" },
  notifications: { holds: "messages sent, with names", subject: "member", erasure: "delete" },
  notification_preferences: { holds: "message preferences", subject: "member", erasure: "delete" },
  leads: { holds: "name, phone, email, interests", subject: "member", erasure: "anonymise" },
  lead_tasks: { holds: "follow-up notes", subject: "member", erasure: "delete" },
  memberships: {
    holds: "plans bought and their dates",
    subject: "member",
    erasure: "retain",
    reason: "contract and tax records (GST: 8 years); tied only to the anonymised member",
  },
  check_ins: {
    holds: "visits",
    subject: "member",
    erasure: "retain",
    reason: "gym occupancy history; tied only to the anonymised member",
  },
  bookings: {
    holds: "class bookings",
    subject: "member",
    erasure: "retain",
    reason: "class history; tied only to the anonymised member",
  },
  invoices: {
    holds: "buyer name",
    subject: "member",
    erasure: "retain",
    reason: "tax invoices must be kept unchanged (CGST Act s.36: 72 months)",
  },
  invoice_lines: {
    holds: "what was sold",
    subject: "member",
    erasure: "retain",
    reason: "part of the tax invoice",
  },
  payments: {
    holds: "payments and gateway references",
    subject: "member",
    erasure: "retain",
    reason: "financial records (Income Tax Act: 8 years)",
  },
  refunds: {
    holds: "refunds and their reasons",
    subject: "member",
    erasure: "retain",
    reason: "financial records",
  },
  ledger_entries: {
    holds: "accounting entries",
    subject: "member",
    erasure: "retain",
    reason: "accounting records",
  },
  autopay_mandates: {
    holds: "AutoPay mandate references",
    subject: "member",
    erasure: "retain",
    reason: "payment records; active mandates are cancelled on erasure",
  },
  member_imports: {
    holds: "uploaded member lists (many people)",
    subject: "member",
    erasure: "retain",
    reason: "uploaded files are emptied 30 days after import by the retention job",
  },
  audit_log: {
    holds: "who did what (ids, IP addresses)",
    subject: "user",
    erasure: "retain",
    reason: "security record, append-only",
  },
  outbox_events: {
    holds: "event payloads with ids and names",
    subject: "member",
    erasure: "retain",
    reason: "deleted 7 days after delivery by the maintenance job",
  },
  idempotency_keys: {
    holds: "stored API responses",
    subject: "user",
    erasure: "retain",
    reason: "deleted after 24 hours by the maintenance job",
  },
} as const satisfies Record<string, PersonalTable>;

/** Tables with no personal data: the gym's own business data and system tables. */
export const NO_PERSONAL_DATA = [
  "organisations",
  "branches",
  "plans",
  "classes",
  "class_sessions",
  "invoice_series",
  "kiosks",
  "feature_flags",
  "handled_events",
] as const;
