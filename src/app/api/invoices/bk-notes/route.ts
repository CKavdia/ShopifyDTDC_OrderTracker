import { NextRequest, NextResponse } from "next/server";
import { getPaidOrdersInRange, getOrderForInvoice } from "@/lib/shopify";
import { buildInvoiceModel } from "@/lib/invoice/calc";
import { renderNotesPdf, type BkNoteItem } from "@/lib/invoice/render.server";
import { data } from "@/lib/data";

// Puppeteer needs the Node.js runtime (not Edge).
export const runtime = "nodejs";

// Store timezone (India), matching the invoice export route.
const TZ_OFFSET = "+05:30";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Download one PDF with a bookkeeping note per order with a CLOSED return in
// [start, end], or a per-order price override (advance adjustment): cash
// collected, invoice total, and the store credit payable the accountant must
// book. Read-only — never mints invoice numbers; orders without a ledger row
// print "(not yet invoiced)".
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

    const ledger = await data.listInvoices();
    const invoiceNoByOrderId = new Map(
      ledger.map((inv) => [inv.shopifyOrderId, inv.invoiceNo])
    );
    const hideCodFee = await data.getInvoiceHideCodFee();

    const notes: BkNoteItem[] = [];
    for (const order of orders) {
      const shopifyOrderId = String(order.id);
      const inv = await getOrderForInvoice(shopifyOrderId);
      const priceOverride = await data.getInvoicePriceOverride(shopifyOrderId);
      // No closed return AND no override — nothing to book for this order.
      if (!inv.hasClosedReturn && !priceOverride) continue;
      const model = buildInvoiceModel(inv, { hideCodFee, priceOverride });
      const t = model.totals;
      const paid = Number(
        inv.collectedTotalPriceSet?.shopMoney?.amount ??
          inv.totalPriceSet.shopMoney.amount
      );
      const total = t.grandTotal.toNumber();
      const fmt = (n: number) =>
        n.toLocaleString("en-IN", {
          style: "currency",
          currency: "INR",
        });
      const itemLines = model.lines
        .filter((l) => l.lineTotal.greaterThan(0))
        .map((l) => ({
          label:
            l.unit === "PCS"
              ? `${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""} — ${l.qty} ${l.unit}`
              : l.title,
          amount: fmt(l.lineTotal.toNumber()),
        }));
      if (itemLines.length === 0) {
        itemLines.push({ label: "(all goods returned — no lines)", amount: fmt(0) });
      }

      notes.push({
        orderName: inv.name,
        orderDate: new Date(inv.createdAt).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        }),
        invoiceNo:
          invoiceNoByOrderId.get(shopifyOrderId) || "(not yet invoiced)",
        customerName:
          inv.shippingAddress?.name || inv.billingAddress?.name || "—",
        itemLines,
        paidAmount: fmt(paid),
        invoiceTotal: fmt(total),
        totalGst: fmt(t.totalGst.toNumber()),
        creditOwed: fmt(Math.max(0, paid - total)),
        refunded: ["REFUNDED", "PARTIALLY_REFUNDED"].includes(
          (inv.displayFinancialStatus || "").toUpperCase()
        ),
      });
    }

    if (notes.length === 0) {
      return NextResponse.json(
        { error: "No closed returns or advance-adjusted orders found in this date range." },
        { status: 404 }
      );
    }

    const periodLabel = `Period ${start} to ${end}`;
    const pdf = await renderNotesPdf(periodLabel, notes);
    const filename = `return-notes-${start}-to-${end}.pdf`;

    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("Bookkeeping notes export failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Bookkeeping notes export failed" },
      { status: 500 }
    );
  }
}
