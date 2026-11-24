import PDFDocument from "pdfkit";
import type { InvoiceOut } from "./invoices.controller";

const rupees = (paise: number) =>
  `Rs. ${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A printable GST tax invoice / credit note. Built-in fonts have no ₹ sign, so amounts use "Rs.". */
export function renderInvoicePdf(invoice: InvoiceOut): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 50,
      compress: false,
      info: { Title: invoice.number },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc
      .fontSize(18)
      .text(invoice.kind === "credit_note" ? "Credit Note" : "Tax Invoice", { align: "right" });
    doc.fontSize(12).text(invoice.sellerName);
    if (invoice.sellerGstin) doc.fontSize(10).text(`GSTIN: ${invoice.sellerGstin}`);
    doc.moveDown();
    doc.fontSize(10);
    doc.text(`Number: ${invoice.number}`);
    doc.text(`Date: ${invoice.issueDate}    Due: ${invoice.dueDate}`);
    doc.text(`Billed to: ${invoice.buyerName}`);
    if (invoice.placeOfSupply) doc.text(`Place of supply: ${invoice.placeOfSupply}`);
    doc.moveDown();

    doc.font("Helvetica-Bold").text("Description", 50, doc.y, { continued: true, width: 280 });
    doc
      .text("SAC", { continued: true, width: 60 })
      .text("GST", { continued: true, width: 50 })
      .text("Amount", { align: "right" });
    doc.font("Helvetica");
    for (const line of invoice.lines) {
      doc.text(line.description, 50, doc.y, { continued: true, width: 280 });
      doc.text(line.sacCode, { continued: true, width: 60 });
      doc.text(`${line.gstRateBps / 100}%`, { continued: true, width: 50 });
      doc.text(rupees(line.taxablePaise), { align: "right" });
    }
    doc.moveDown();
    const total = (label: string, paise: number) =>
      doc.text(`${label}: ${rupees(paise)}`, { align: "right" });
    total("Taxable value", invoice.taxablePaise);
    if (invoice.cgstPaise) total("CGST", invoice.cgstPaise);
    if (invoice.sgstPaise) total("SGST", invoice.sgstPaise);
    if (invoice.igstPaise) total("IGST", invoice.igstPaise);
    doc.font("Helvetica-Bold");
    total("Total", invoice.totalPaise);
    doc.font("Helvetica");
    if (invoice.kind === "invoice") total("Paid", invoice.paidPaise);
    doc
      .moveDown(2)
      .fontSize(8)
      .text("This is a computer-generated document and needs no signature.", { align: "center" });
    doc.end();
  });
}
