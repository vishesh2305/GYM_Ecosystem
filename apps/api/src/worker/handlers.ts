import { creditNoteForPlanChange, invoiceMembershipSale } from "../billing/handlers";
import { importMembersHandler } from "../membership/import.handler";
import { notificationHandlers } from "../notifications/journeys";
import type { EventHandler } from "../platform/events";

/** Every production event handler. Modules add theirs here as they are built. */
export const handlers: EventHandler[] = [
  importMembersHandler,
  invoiceMembershipSale,
  creditNoteForPlanChange,
  ...notificationHandlers,
];
