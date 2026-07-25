import { NextRequest, NextResponse } from "next/server";
import { getPaidOrdersInRange } from "@/lib/shopify";
import { prepareInvoiceItem } from "@/lib/invoice/generate.server";
import {
  renderMergedInvoicesPdf,
  type MergedInvoiceItem,
} from "@/lib/invoice/render.server";
import { data } from "@/lib/data";

// Puppeteer needs the Node.js runtime (not Edge).
export const runtime = "nodejs";

// Store timezone (India). Boundaries are interpreted in IST so a day covers the
// full local calendar day.
const TZ_OFFSET = "+05:30";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Download every invoice for paid orders created in [start, end] as one merged
// PDF, minting invoice numbers for any order not yet invoiced. Orders are
// processed oldest-first and sequentially (respects the numbering mutex and
// Notion/Shopify rate limits), so a large range can take a while.
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const start = searchParams.get("start") || "";
    const end = searchParams.get("end") || "";

    if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
      return NextResponse.json(
        { error: "start and end must be YYYY-MM-DD dates." },
        { status: 400 }
      );
    }
    if (start > end) {
      return NextResponse.json(
        { error: "start date must be on or before end date." },
        { status: 400 }
      );
    }

    const startISO = `${start}T00:00:00${TZ_OFFSET}`;
    const endISO = `${end}T23:59:59${TZ_OFFSET}`;

    const orders = await getPaidOrdersInRange(startISO, endISO);
    if (orders.length === 0) {
      return NextResponse.json(
        { error: "No paid orders found in this date range." },
        { status: 404 }
      );
    }

    // Render already-issued invoices with their real ledger date, not "now".
    const issued = await data.listInvoices();
    const dateByOrderId = new Map(
      issued.map((inv) => [inv.shopifyOrderId, inv.invoiceDate])
    );

    const items: MergedInvoiceItem[] = [];
    for (const order of orders) {
      const shopifyOrderId = String(order.id);
      const storedDate = dateByOrderId.get(shopifyOrderId);
      // Reused -> keep its original invoice date; new -> date it at the sale date.
      const invoiceDate = storedDate
        ? new Date(storedDate)
        : new Date(order.created_at);
      const { model, meta } = await prepareInvoiceItem(shopifyOrderId, {
        invoiceDate,
      });
      items.push({ model, meta });
    }

    const pdf = await renderMergedInvoicesPdf(items);
    const filename = `invoices-${start}-to-${end}.pdf`;

    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("Invoice range export failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invoice range export failed" },
      { status: 500 }
    );
  }
}
