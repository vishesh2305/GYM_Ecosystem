import { eq, isNull } from "@gym/db/orm";
import { branches, memberImports, members, memberships, plans } from "@gym/db/schema";
import {
  initialStatus,
  normalizePhone,
  planEndDate,
  priceBreakdown,
  type CountryCode,
} from "@gym/domain";
import { z } from "zod";
import { defineEvent, defineHandler } from "../platform/events";
import { parseImportDate, parseMemberCsv } from "./csv-import";
import { orgToday } from "./memberships.service";

export const memberImportRequested = defineEvent(
  "member_import.requested",
  z.object({ importId: z.uuid(), phoneRegion: z.string().length(2) }),
);

const GENDERS = new Set(["female", "male", "other", "unspecified"]);
const MAX_REPORTED_ERRORS = 500;

class RowError extends Error {}

/**
 * Processes an import in the background. Each row runs in its own savepoint: a bad row is rolled back and
 * reported, the rest carry on. Imported memberships were paid for elsewhere, so no billing event is published.
 */
export const importMembersHandler = defineHandler({
  name: "membership.import-members",
  event: memberImportRequested,
  async handle({ importId, phoneRegion }, { tx }) {
    const [job] = await tx.select().from(memberImports).where(eq(memberImports.id, importId));
    if (!job?.content) return;
    await tx
      .update(memberImports)
      .set({ status: "processing" })
      .where(eq(memberImports.id, importId));

    const today = await orgToday(tx);
    const branchByName = new Map(
      (await tx.select().from(branches).where(isNull(branches.deletedAt))).map((b) => [
        b.name.trim().toLowerCase(),
        b.id,
      ]),
    );
    const planByName = new Map(
      (await tx.select().from(plans).where(eq(plans.active, true))).map((p) => [
        p.name.trim().toLowerCase(),
        p,
      ]),
    );

    const rows = parseMemberCsv(job.content);
    const errors: { row: number; message: string }[] = [];
    let created = 0;

    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 2; // the header is row 1
      try {
        await tx.transaction(async (sp) => {
          if (!row.name) throw new RowError("Name is missing");
          const phone = row.phone ? normalizePhone(row.phone, phoneRegion as CountryCode) : null;
          if (row.phone && !phone) throw new RowError(`"${row.phone}" is not a valid phone number`);
          const dateOfBirth = row.date_of_birth ? parseImportDate(row.date_of_birth) : null;
          if (row.date_of_birth && !dateOfBirth)
            throw new RowError(`"${row.date_of_birth}" is not a valid date of birth`);
          const homeBranchId = row.branch
            ? branchByName.get(row.branch.toLowerCase())
            : job.defaultBranchId;
          if (!homeBranchId) throw new RowError(`There is no branch called "${row.branch}"`);
          const gender = row.gender?.toLowerCase();

          const [member] = await sp
            .insert(members)
            .values({
              tenantId: job.tenantId,
              name: row.name,
              phone,
              email: row.email?.toLowerCase() || null,
              gender: gender && GENDERS.has(gender) ? (gender as "female") : null,
              dateOfBirth,
              homeBranchId,
              source: "import",
            })
            .onConflictDoNothing()
            .returning({ id: members.id });
          if (!member) throw new RowError("A member with this phone number already exists");

          if (row.plan) {
            const plan = planByName.get(row.plan.toLowerCase());
            if (!plan) throw new RowError(`There is no active plan called "${row.plan}"`);
            const startDate = row.start_date ? parseImportDate(row.start_date) : today;
            if (!startDate) throw new RowError(`"${row.start_date}" is not a valid start date`);
            const endDate = row.end_date
              ? parseImportDate(row.end_date)
              : planEndDate(startDate, { unit: plan.durationUnit, count: plan.durationCount });
            if (!endDate || endDate < startDate)
              throw new RowError("The end date must be a valid date after the start date");
            const price = priceBreakdown({
              pricePaise: plan.pricePaise,
              joiningFeePaise: 0,
              gstRateBps: plan.gstRateBps,
            });
            const status =
              endDate < today
                ? "expired"
                : initialStatus({ startDate, today, isTrial: plan.isTrial });
            await sp.insert(memberships).values({
              tenantId: job.tenantId,
              memberId: member.id,
              planId: plan.id,
              planName: plan.name,
              status,
              startDate,
              endDate,
              isTrial: plan.isTrial,
              pricePaise: price.pricePaise,
              joiningFeePaise: 0,
              gstRateBps: plan.gstRateBps,
              gstPaise: price.gstPaise,
              totalPaise: price.totalPaise,
              maxFreezes: plan.maxFreezes,
              maxFreezeDays: plan.maxFreezeDays,
            });
          }
          created += 1;
        });
      } catch (error) {
        if (!(error instanceof RowError)) throw error; // unexpected: let the job retry
        if (errors.length < MAX_REPORTED_ERRORS)
          errors.push({ row: rowNumber, message: error.message });
      }
    }

    await tx
      .update(memberImports)
      .set({
        status: "done",
        content: null, // do not keep personal data longer than needed
        createdCount: created,
        failedCount: rows.length - created,
        errors,
        finishedAt: new Date(),
      })
      .where(eq(memberImports.id, importId));
  },
});
