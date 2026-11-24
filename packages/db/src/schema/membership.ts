import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, smallint, text, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "../columns";
import { organisations } from "./tenancy";

/** What a gym sells. Prices are in paise, before GST; a membership copies them when it is sold. */
export const plans = pgTable(
  "plans",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    durationUnit: text("duration_unit", { enum: ["day", "month"] }).notNull(),
    durationCount: smallint("duration_count").notNull(),
    pricePaise: integer("price_paise").notNull(),
    gstRateBps: smallint("gst_rate_bps").notNull().default(1800),
    joiningFeePaise: integer("joining_fee_paise").notNull().default(0),
    isTrial: boolean("is_trial").notNull().default(false),
    /** Branches that sell this plan; empty = all branches. */
    branchIds: uuid("branch_ids")
      .array()
      .notNull()
      .default(sql`'{}'`),
    maxFreezes: smallint("max_freezes").notNull().default(0),
    maxFreezeDays: smallint("max_freeze_days").notNull().default(0),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("plans_tenant_idx").on(t.tenantId),
    check("plans_price_non_negative", sql`${t.pricePaise} >= 0 and ${t.joiningFeePaise} >= 0`),
    check("plans_duration_positive", sql`${t.durationCount} > 0`),
    check("plans_gst_slab", sql`${t.gstRateBps} in (0, 500, 1200, 1800, 2800)`),
  ],
);
