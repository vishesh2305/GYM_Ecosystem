import type { Tx } from "@gym/db";
import { and, eq, sql } from "@gym/db/orm";
import {
  branches,
  invoiceLines,
  invoiceSeries,
  invoices,
  members,
  memberships,
  organisations,
} from "@gym/db/schema";
import { applyBasisPoints, documentNumber, fiscalYear, splitGst } from "@gym/domain";
import type { z } from "zod";
import type { membershipCreated, membershipPlanChanged } from "../membership/events";
import { orgToday } from "../membership/memberships.service";
import { postJournal } from "./ledger";

/** SAC for fitness-centre services. Confirm with the gym's accountant before going live. */
export const FITNESS_SAC = "999723";

/** Next gap-free number for this gym, kind and financial year (the series row is locked until commit). */
async function nextNumber(
  tx: Tx,
  tenantId: string,
  kind: "invoice" | "credit_note",
  fy: string,
): Promise<string> {
  const [row] = await tx
    .insert(invoiceSeries)
    .values({ tenantId, kind, fiscalYear: fy, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [invoiceSeries.tenantId, invoiceSeries.kind, invoiceSeries.fiscalYear],
      set: { lastNumber: sql`${invoiceSeries.lastNumber} + 1` },
    })
    .returning({ n: invoiceSeries.lastNumber });
  return documentNumber(kind, fy, row?.n ?? 1);
}

async function parties(tx: Tx, memberId: string) {
  const [org] = await tx.select().from(organisations);
  const [member] = await tx.select().from(members).where(eq(members.id, memberId));
  if (!org || !member) throw new Error("organisation or member not found for invoice");
  const [branch] = await tx.select().from(branches).where(eq(branches.id, member.homeBranchId));
  return { org, member, branch };
}

type Sale = z.output<(typeof membershipCreated)["schema"]>;

/** Tax invoice for a membership sale, with its ledger journal. Free memberships get no invoice. */
export async function issueMembershipInvoice(
  tx: Tx,
  tenantId: string,
  sale: Sale,
): Promise<typeof invoices.$inferSelect | null> {
  if (sale.totalPaise === 0) return null;
  const { org, member, branch } = await parties(tx, sale.memberId);
  const [membership] = await tx
    .select()
    .from(memberships)
    .where(eq(memberships.id, sale.membershipId));
  const today = await orgToday(tx);
  const { cgstPaise, sgstPaise } = splitGst(sale.gstPaise);
  const taxablePaise = sale.pricePaise + sale.joiningFeePaise;

  const [invoice] = await tx
    .insert(invoices)
    .values({
      tenantId,
      kind: "invoice",
      number: await nextNumber(tx, tenantId, "invoice", fiscalYear(today)),
      memberId: member.id,
      membershipId: sale.membershipId,
      branchId: member.homeBranchId,
      issueDate: today,
      dueDate: sale.startDate > today ? sale.startDate : today,
      sellerName: org.name,
      sellerGstin: org.gstin,
      buyerName: member.name,
      placeOfSupply: branch?.state ?? null,
      taxablePaise,
      cgstPaise,
      sgstPaise,
      totalPaise: taxablePaise + cgstPaise + sgstPaise,
    })
    .returning();
  if (!invoice) throw new Error("invoice insert returned nothing");

  const lines = [
    {
      description: `${membership?.planName ?? "Membership"}, ${sale.startDate} to ${sale.endDate}`,
      taxablePaise: sale.pricePaise,
    },
    ...(sale.joiningFeePaise > 0
      ? [{ description: "Joining fee", taxablePaise: sale.joiningFeePaise }]
      : []),
  ];
  await tx.insert(invoiceLines).values(
    lines.map((l) => ({
      tenantId,
      invoiceId: invoice.id,
      sacCode: FITNESS_SAC,
      gstRateBps: sale.gstRateBps,
      ...l,
    })),
  );

  await postJournal(tx, {
    tenantId,
    sourceType: "invoice",
    sourceId: invoice.id,
    memo: invoice.number,
    lines: [
      { account: "receivable", debitPaise: invoice.totalPaise, memberId: member.id },
      { account: "revenue", creditPaise: taxablePaise },
      ...(cgstPaise ? [{ account: "gst_cgst" as const, creditPaise: cgstPaise }] : []),
      ...(sgstPaise ? [{ account: "gst_sgst" as const, creditPaise: sgstPaise }] : []),
    ],
  });
  return invoice;
}

type PlanChange = z.output<(typeof membershipPlanChanged)["schema"]>;

/** Credit note for the unused part of the old plan (plus the GST charged on it), with its ledger journal. */
export async function issuePlanChangeCreditNote(tx: Tx, tenantId: string, change: PlanChange) {
  if (change.creditPaise === 0) return null;
  const [old] = await tx
    .select()
    .from(memberships)
    .where(eq(memberships.id, change.oldMembershipId));
  if (!old) throw new Error("old membership not found for credit note");
  const [original] = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.membershipId, old.id), eq(invoices.kind, "invoice")));
  const { org, member, branch } = await parties(tx, change.memberId);
  const today = await orgToday(tx);
  const { cgstPaise, sgstPaise } = splitGst(applyBasisPoints(change.creditPaise, old.gstRateBps));

  const [note] = await tx
    .insert(invoices)
    .values({
      tenantId,
      kind: "credit_note",
      number: await nextNumber(tx, tenantId, "credit_note", fiscalYear(today)),
      memberId: member.id,
      membershipId: old.id,
      branchId: member.homeBranchId,
      relatedInvoiceId: original?.id ?? null,
      issueDate: today,
      dueDate: today,
      sellerName: org.name,
      sellerGstin: org.gstin,
      buyerName: member.name,
      placeOfSupply: branch?.state ?? null,
      taxablePaise: change.creditPaise,
      cgstPaise,
      sgstPaise,
      totalPaise: change.creditPaise + cgstPaise + sgstPaise,
    })
    .returning();
  if (!note) throw new Error("credit note insert returned nothing");
  await tx.insert(invoiceLines).values({
    tenantId,
    invoiceId: note.id,
    description: `Unused part of ${old.planName} (plan changed)`,
    sacCode: FITNESS_SAC,
    taxablePaise: change.creditPaise,
    gstRateBps: old.gstRateBps,
  });

  await postJournal(tx, {
    tenantId,
    sourceType: "credit_note",
    sourceId: note.id,
    memo: note.number,
    lines: [
      { account: "revenue", debitPaise: change.creditPaise },
      ...(cgstPaise ? [{ account: "gst_cgst" as const, debitPaise: cgstPaise }] : []),
      ...(sgstPaise ? [{ account: "gst_sgst" as const, debitPaise: sgstPaise }] : []),
      { account: "receivable", creditPaise: note.totalPaise, memberId: member.id },
    ],
  });
  return note;
}
