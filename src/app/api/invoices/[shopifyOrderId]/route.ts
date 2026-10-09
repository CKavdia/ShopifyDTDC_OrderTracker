import { NextRequest, NextResponse } from "next/server";
import { generateInvoicePdf } from "@/lib/invoice/generate.server";
import { data } from "@/lib/data";

// Puppeteer needs the Node.js runtime (not Edge).
export const runtime = "nodejs";

// Re-download an invoice by Shopify order id (used by the Invoices page).
// The invoice already exists, so this reuses its number.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ shopifyOrderId: string }> }
) {
  try {
    const { shopifyOrderId } = await params;
    // Current display flag — controls whether the COD fee line is included.
    const hideCodFee = await data.getInvoiceHideCodFee();
    const { pdf, filename } = await generateInvoicePdf(shopifyOrderId, {
      hideCodFee,
    });

    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("Invoice re-download failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invoice re-download failed" },
      { status: 500 }
    );
  }
}
