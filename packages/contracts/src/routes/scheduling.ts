import { z } from "zod";
import { defineRoute } from "../route";

const orgParams = z.object({ orgId: z.uuid() });
const classParams = z.object({ orgId: z.uuid(), classId: z.uuid() });
const sessionParams = z.object({ orgId: z.uuid(), sessionId: z.uuid() });
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM");

export const gymClass = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  room: z.string().nullable(),
  instructorId: z.uuid().nullable(),
  capacity: z.number().int(),
  durationMinutes: z.number().int(),
  weekdays: z.array(z.number().int()),
  startTime: z.string(),
  startsOn: z.iso.date(),
  endsOn: z.iso.date().nullable(),
  cancelWindowMinutes: z.number().int(),
  active: z.boolean(),
});

// Fields staff may change later; weekdays and times are fixed (archive and create a new class instead).
const classEditable = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable(),
  room: z.string().trim().max(60).nullable(),
  instructorId: z.uuid().nullable(),
  capacity: z.number().int().min(1).max(500),
  cancelWindowMinutes: z.number().int().min(0).max(2880),
});

export const createClass = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/branches/{branchId}/classes",
  summary:
    "Add a weekly class to a branch's timetable; sessions for the next 14 days appear at once",
  tag: "classes",
  params: z.object({ orgId: z.uuid(), branchId: z.uuid() }),
  body: classEditable.extend({
    description: classEditable.shape.description.default(null),
    room: classEditable.shape.room.default(null),
    instructorId: classEditable.shape.instructorId.default(null),
    cancelWindowMinutes: classEditable.shape.cancelWindowMinutes.default(120),
    durationMinutes: z.number().int().min(10).max(480),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    startTime: hhmm,
    startsOn: z.iso.date().optional(),
    endsOn: z.iso.date().nullable().default(null),
  }),
  response: gymClass,
  status: 201,
});

export const listClasses = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/classes",
  summary: "The timetable's classes (active ones unless includeArchived=true)",
  tag: "classes",
  params: orgParams,
  query: z.object({ includeArchived: z.stringbool().optional() }),
  response: z.array(gymClass),
});

export const updateClass = defineRoute({
  method: "PATCH",
  path: "/v1/orgs/{orgId}/classes/{classId}",
  summary: "Change a class; upcoming sessions change with it (bookings are kept)",
  tag: "classes",
  params: classParams,
  body: classEditable.partial(),
  response: gymClass,
});

export const archiveClass = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/classes/{classId}/archive",
  summary:
    "Take a class off the timetable; its upcoming sessions are cancelled and booked members told",
  tag: "classes",
  params: classParams,
  response: gymClass,
});

export const classSession = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  classId: z.uuid().nullable(),
  kind: z.enum(["class", "pt"]),
  name: z.string(),
  room: z.string().nullable(),
  instructorId: z.uuid().nullable(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  capacity: z.number().int(),
  cancelWindowMinutes: z.number().int(),
  status: z.enum(["scheduled", "cancelled"]),
  cancelReason: z.string().nullable(),
  booked: z.number().int(),
  waitlisted: z.number().int(),
});

export const listClassSessions = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/sessions",
  summary: "Sessions starting between from and to (default: the next 7 days), with places taken",
  tag: "classes",
  params: orgParams,
  query: z.object({
    branchId: z.uuid().optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  }),
  response: z.array(classSession),
});

export const cancelClassSession = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/sessions/{sessionId}/cancel",
  summary: "Cancel one session (for example the instructor is ill); booked members are told",
  tag: "classes",
  params: sessionParams,
  body: z.object({ reason: z.string().trim().min(1).max(200) }),
  response: classSession,
});

export const booking = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  memberId: z.uuid(),
  status: z.enum(["confirmed", "waitlisted", "cancelled", "late_cancelled", "attended", "no_show"]),
  /** 1 = next in line; null unless waitlisted. */
  waitlistPosition: z.number().int().nullable(),
  promotedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

const bookingParams = z.object({ orgId: z.uuid(), bookingId: z.uuid() });
const mySessionParams = z.object({ orgId: z.uuid(), sessionId: z.uuid() });

export const bookSession = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/sessions/{sessionId}/bookings",
  summary:
    "Book a member into a session: a place if one is free, otherwise the waitlist (booking twice returns the same booking)",
  tag: "classes",
  params: sessionParams,
  body: z.object({ memberId: z.uuid() }),
  response: booking,
  status: 201,
});

export const listSessionBookings = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/sessions/{sessionId}/bookings",
  summary: "Who is booked and waiting for a session, in order",
  tag: "classes",
  params: sessionParams,
  response: z.array(booking.extend({ memberName: z.string() })),
});

export const cancelBooking = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/bookings/{bookingId}/cancel",
  summary:
    "Cancel a booking; the first member waiting gets the place. Inside the cancellation window it counts as late",
  tag: "classes",
  params: bookingParams,
  response: booking,
});

export const listMySessions = defineRoute({
  method: "GET",
  path: "/v1/me/gyms/{orgId}/sessions",
  summary: "Upcoming sessions at my gym (default the next 7 days) with places left and my booking",
  tag: "me",
  params: orgParams,
  query: z.object({
    branchId: z.uuid().optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  }),
  response: z.array(classSession.extend({ myBooking: booking.nullable() })),
});

export const bookMySession = defineRoute({
  method: "POST",
  path: "/v1/me/gyms/{orgId}/sessions/{sessionId}/bookings",
  summary: "Book myself into a session, or join its waitlist when it is full",
  tag: "me",
  params: mySessionParams,
  response: booking,
  status: 201,
});

export const listMyBookings = defineRoute({
  method: "GET",
  path: "/v1/me/gyms/{orgId}/bookings",
  summary: "My latest 50 bookings with their sessions, newest session first",
  tag: "me",
  params: orgParams,
  response: z.array(booking.extend({ session: classSession })),
});

export const cancelMyBooking = defineRoute({
  method: "POST",
  path: "/v1/me/gyms/{orgId}/bookings/{bookingId}/cancel",
  summary: "Cancel my booking (late inside the class's cancellation window)",
  tag: "me",
  params: bookingParams,
  response: booking,
});

export const markAttendance = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/bookings/{bookingId}/attendance",
  summary:
    "Mark whether a booked member came (once the session has started; otherwise it is settled from check-ins after it ends)",
  tag: "classes",
  params: bookingParams,
  body: z.object({ attended: z.boolean() }),
  response: booking,
});
