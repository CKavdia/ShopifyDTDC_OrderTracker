import { NextRequest, NextResponse } from "next/server";
import { getOrderForInvoice } from "@/lib/shopify";
import { buildInvoiceModel } from "@/lib/invoice/calc";
import { data } from "@/lib/data";

export const runtime = "nodejs";

// Per-line unit prices for the Update Invoice dialog: the goods lines with
// their currently printed unit price (the forced one when an override is
// active, the Shopify-computed one otherwise), plus the collected total so the
// dialog can preview the store-credit advance.
export async function GET(request: NextRequest) {
  try {
    const shopifyOrderId =
      new URL(request.url).searchParams.get("shopifyOrderId") || "";
    if (!shopifyOrderId) {
      return NextResponse.json(
        { error: "shopifyOrderId is required." },
        { status: 400 }
      );
    }

    const inv = await getOrderForInvoice(shopifyOrderId);
    const priceOverride = await data.getInvoicePriceOverride(shopifyOrderId);
    const hideCodFee = await data.getInvoiceHideCodFee();
    const model = buildInvoiceModel(inv, { hideCodFee, priceOverride });
    const goods = model.lines.filter((l) => l.unit === "PCS");

    return NextResponse.json({
      invoiceNo: null, // caller already knows it from the ledger row
      priceOverride,
      gstRate: priceOverride?.gstRate ?? Number(goods[0]?.rate ?? 5),
      lines: goods.map((l) => ({
        key: l.key,
        title: l.title,
        variantTitle: l.variantTitle,
        qty: l.qty.toNumber(),
        unitPrice: l.unitPricePreTax.toNumber(),
      })),
      currentTotal: model.totals.grandTotal.toNumber(),
      collected: Number(
        inv.collectedTotalPriceSet?.shopMoney?.amount ??
          inv.totalPriceSet?.shopMoney?.amount ??
          0
      ),
    });
  } catch (err) {
    console.error("Price override load failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Price override load failed" },
      { status: 500 }
    );
  }
}

// Set or clear the override.
// POST { shopifyOrderId, gstRate, lines: [{ key, title, qty, unitPrice }] }
// POST { shopifyOrderId, clear: true }  -> clear.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const shopifyOrderId = String(body.shopifyOrderId || "");
    if (!shopifyOrderId) {
      return NextResponse.json(
        { error: "shopifyOrderId is required." },
        { status: 400 }
      );
    }

    if (body.clear) {
      await data.setInvoicePriceOverride(shopifyOrderId, null);
      return NextResponse.json({ cleared: true });
    }

    const gstRate = Number(body.gstRate);
    if (!Number.isFinite(gstRate) || ![0, 5, 12, 18, 28].includes(gstRate)) {
      return NextResponse.json(
        { error: "gstRate must be one of 0, 5, 12, 18, 28." },
        { status: 400 }
      );
    }
    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    if (rawLines.length === 0) {
      return NextResponse.json(
        { error: "At least one item line is required." },
        { status: 400 }
      );
    }
    const lines = rawLines.map((li: Record<string, unknown>) => ({
      key: String(li.key || ""),
      title: String(li.title || ""),
      qty: Number(li.qty || 0),
      unitPrice: Number(li.unitPrice),
    }));
    if (lines.some((l: { key: string; unitPrice: number }) => !l.key)) {
      return NextResponse.json(
        { error: "Every line needs its line-item key." },
        { status: 400 }
      );
    }
    if (
      lines.some(
        (l: { unitPrice: number }) =>
          !Number.isFinite(l.unitPrice) || l.unitPrice <= 0
      )
    ) {
      return NextResponse.json(
        { error: "Every unit price must be a positive number." },
        { status: 400 }
      );
    }

    await data.setInvoicePriceOverride(shopifyOrderId, { gstRate, lines });
    return NextResponse.json({ priceOverride: { gstRate, lines } });
  } catch (err) {
    console.error("Price override save failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Price override save failed" },
      { status: 500 }
    );
  }
}