// Server-only: turn a Shopify order id into a numbered invoice PDF.
// Shared by the per-order route, the re-download route, and the range export.
import { getOrderForInvoice } from "../shopify";
import { data } from "../data";
import {
  buildInvoiceModel,
  type InvoiceModel,
  type InvoiceLine,
} from "./calc";
import { renderInvoicePdf, type InvoiceMeta } from "./render.server";
import type { InvoiceLineSnapshot } from "../data/types";

// Freeze the model's lines as the ledger snapshot — the issued invoice's
// figures become the source of truth for GSTR-1 and exports.
function snapshotFromModel(model: InvoiceModel): InvoiceLineSnapshot[] {
  const line = (l: InvoiceLine): InvoiceLineSnapshot => ({
    hsn: l.hsn,
    title: l.title,
    variantTitle: l.variantTitle || undefined,
    qty: l.qty.toNumber(),
    rate: l.rate.toNumber(),
    taxableValue: l.taxableValue.toNumber(),
    cgst: l.cgst.toNumber(),
    sgst: l.sgst.toNumber(),
    igst: l.igst.toNumber(),
    lineTotal: l.lineTotal.toNumber(),
    service: !l.unit,
  });
  return model.lines.map(line);
}

// Fetch an order, compute its invoice model, and assign (or reuse) its number.
// Does NOT render — callers render one invoice or many into a merged PDF.
export async function prepareInvoiceItem(
  shopifyOrderId: string,
  opts: {
    invoiceDate?: Date;
    orderNumber?: string;
    customerName?: string;
    hideCodFee?: boolean;
  } = {}
): Promise<{ model: InvoiceModel; meta: InvoiceMeta; invoiceNo: string; reused: boolean }> {
  const invoiceOrder = await getOrderForInvoice(shopifyOrderId);
  // A per-order price override (set on the ledger row) forces the unit price
  // and GST rate for this order on every build — regeneration, export, GSTR-1
  // and bookkeeping notes all reproduce the same figures.
  const priceOverride = await data.getInvoicePriceOverride(shopifyOrderId);
  const model = buildInvoiceModel(invoiceOrder, {
    hideCodFee: opts.hideCodFee,
    priceOverride,
  });
  const t = model.totals;

  const invoiceDate = opts.invoiceDate ?? new Date();
  const { invoiceNo, reused } = await data.getOrCreateInvoiceNumber({
    shopifyOrderId,
    orderNumber: opts.orderNumber || invoiceOrder.name,
    customerName:
      opts.customerName ||
      invoiceOrder.shippingAddress?.name ||
      invoiceOrder.billingAddress?.name ||
      "",
    invoiceDate: invoiceDate.toISOString(),
    placeOfSupply: model.placeOfSupply,
    taxableValue: t.taxableValue.toNumber(),
    cgst: t.cgst.toNumber(),
    sgst: t.sgst.toNumber(),
    igst: t.igst.toNumber(),
    grandTotal: t.grandTotal.toNumber(),
    priceOverride,
    lineItems: snapshotFromModel(model),
  });

  return { model, meta: { invoiceNo, invoiceDate }, invoiceNo, reused };
}

export async function generateInvoicePdf(
  shopifyOrderId: string,
  meta: { orderNumber?: string; customerName?: string; hideCodFee?: boolean } = {}
): Promise<{ pdf: Uint8Array; invoiceNo: string; filename: string; reused: boolean }> {
  const { model, meta: renderMeta, invoiceNo, reused } = await prepareInvoiceItem(
    shopifyOrderId,
    meta
  );
  const pdf = await renderInvoicePdf(model, renderMeta);
  const filename = `${invoiceNo.replace(/[\\/]/g, "-")}.pdf`;
  return { pdf, invoiceNo, filename, reused };
}
