import { NextRequest, NextResponse } from "next/server";
import {
  buildManualInvoiceModel,
  parseManualInvoiceInput,
  validateManualInvoice,
} from "@/lib/invoice/manual";
import { renderInvoicePdf } from "@/lib/invoice/render.server";

// Puppeteer needs the Node.js runtime (not Edge).
export const runtime = "nodejs";

// Render a manually-typed invoice to PDF.
//
// Unlike the order-driven routes this deliberately touches NEITHER Shopify NOR
// the Notion ledger: the invoice number is supplied by the caller, so nothing
// is minted from the automatic UN/FY/NNNNN series and nothing is recorded. The
// returned PDF is the only artifact.
export async function POST(request: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const input = parseManualInvoiceInput(body);
    const problem = validateManualInvoice(input);
    if (problem) {
      return NextResponse.json({ error: problem }, { status: 400 });
    }

    const model = buildManualInvoiceModel(input);
    const pdf = await renderInvoicePdf(model, {
      invoiceNo: input.invoiceNo,
      // Midday local time so the date can't slip across a timezone boundary.
      invoiceDate: new Date(`${input.invoiceDate}T12:00:00`),
      buyerGstin: input.buyer.gstin,
      reference: input.reference,
      notes: input.notes,
    });

    const filename = `${input.invoiceNo.replace(/[\\/:*?"<>|]/g, "-")}.pdf`;

    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("Manual invoice generation failed:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Manual invoice generation failed",
      },
      { status: 500 }
    );
  }
}
