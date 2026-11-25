import { z } from "zod";
import { defineRoute } from "../route";

const stage = z.enum(["new", "contacted", "trial_booked", "trial_done", "won", "lost"]);
const source = z.enum(["walk_in", "phone", "website", "referral", "social", "other"]);
const orgParams = z.object({ orgId: z.uuid() });
const leadParams = z.object({ orgId: z.uuid(), leadId: z.uuid() });

export const leadTask = z.object({
  id: z.uuid(),
  leadId: z.uuid(),
  title: z.string(),
  dueAt: z.iso.datetime(),
  assignedTo: z.uuid().nullable(),
  doneAt: z.iso.datetime().nullable(),
});

export const lead = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  source,
  stage,
  assignedTo: z.uuid().nullable(),
  interest: z.string().nullable(),
  trialAt: z.iso.datetime().nullable(),
  lostReason: z.string().nullable(),
  memberId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

const contact = {
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(6).max(20).optional(),
  email: z.email().max(200).optional(),
  interest: z.string().trim().max(500).optional(),
};

export const createLead = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/leads",
  summary: "Add a lead (a phone number or an email is needed to follow up)",
  tag: "crm",
  params: orgParams,
  body: z
    .object({ ...contact, branchId: z.uuid(), source, assignedTo: z.uuid().optional() })
    .refine((b) => b.phone || b.email, "Give a phone number or an email"),
  response: lead,
  status: 201,
});

export const listLeads = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/leads",
  summary: "Leads, newest first, optionally by stage, branch or name / phone search",
  tag: "crm",
  params: orgParams,
  query: z.object({
    stage: stage.optional(),
    branchId: z.uuid().optional(),
    q: z.string().trim().min(1).max(60).optional(),
  }),
  response: z.array(lead),
});

export const getLead = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/leads/{leadId}",
  summary: "A lead with its follow-up tasks",
  tag: "crm",
  params: leadParams,
  response: lead.extend({ tasks: z.array(leadTask) }),
});

export const updateLead = defineRoute({
  method: "PATCH",
  path: "/v1/orgs/{orgId}/leads/{leadId}",
  summary:
    "Change a lead's details or move it along the pipeline. Losing a lead needs a reason; joining is done with convert",
  tag: "crm",
  params: leadParams,
  body: z.object({
    name: contact.name.optional(),
    phone: contact.phone,
    email: contact.email,
    interest: contact.interest,
    assignedTo: z.uuid().nullable().optional(),
    stage: stage.exclude(["won"]).optional(),
    lostReason: z.string().trim().min(1).max(300).optional(),
  }),
  response: lead,
});

export const bookLeadTrial = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/leads/{leadId}/trial",
  summary:
    "Book a trial visit; a follow-up task for the day after is added for the assigned staff member",
  tag: "crm",
  params: leadParams,
  body: z.object({ startsAt: z.iso.datetime() }),
  response: lead,
});

export const convertLead = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/leads/{leadId}/convert",
  summary:
    "The lead joins: they become a member (or are linked to the member with their phone number) and the lead is won",
  tag: "crm",
  params: leadParams,
  response: lead,
});

export const createLeadTask = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/leads/{leadId}/tasks",
  summary: "Add a follow-up for a lead",
  tag: "crm",
  params: leadParams,
  body: z.object({
    title: z.string().trim().min(1).max(200),
    dueAt: z.iso.datetime(),
    assignedTo: z.uuid().optional(),
  }),
  response: leadTask,
  status: 201,
});

export const listLeadTasks = defineRoute({
  method: "GET",
  path: "/v1/orgs/{orgId}/tasks",
  summary: "Open follow-ups, soonest first; mine=true for those assigned to me",
  tag: "crm",
  params: orgParams,
  query: z.object({ mine: z.stringbool().optional() }),
  response: z.array(leadTask.extend({ leadName: z.string() })),
});

export const completeLeadTask = defineRoute({
  method: "POST",
  path: "/v1/orgs/{orgId}/tasks/{taskId}/complete",
  summary: "Mark a follow-up as done",
  tag: "crm",
  params: z.object({ orgId: z.uuid(), taskId: z.uuid() }),
  response: leadTask,
});
