import { NextRequest, NextResponse } from "next/server";
import { data } from "@/lib/data";
import { generateInvoicePdf } from "@/lib/invoice/generate.server";

// Puppeteer needs the Node.js runtime (not Edge).
export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const order = await data.getOrderById(id);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    if (!order.shopifyOrderId) {
      return NextResponse.json({ error: "No Shopify order ID" }, { status: 400 });
    }

    const { pdf, filename } = await generateInvoicePdf(order.shopifyOrderId, {
      orderNumber: order.orderNumber,
      customerName: order.customerName,
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
    console.error("Invoice generation failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invoice generation failed" },
      { status: 500 }
    );
  }
}
