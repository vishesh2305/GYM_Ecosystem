import type { EventHandler } from "../platform/events";

/** Every production event handler. Modules add theirs here as they are built. */
export const handlers: EventHandler[] = [];
