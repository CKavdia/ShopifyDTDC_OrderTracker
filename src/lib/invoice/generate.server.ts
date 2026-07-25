// Server-only: turn a Shopify order id into a numbered invoice PDF.
// Shared by the per-order route, the re-download route, and the range export.
import { getOrderForInvoice } from "../shopify";
import { data } from "../data";
import { buildInvoiceModel, type InvoiceModel } from "./calc";
import { renderInvoicePdf, type InvoiceMeta } from "./render.server";

// Fetch an order, compute its invoice model, and assign (or reuse) its number.
// Does NOT render — callers render one invoice or many into a merged PDF.
export async function prepareInvoiceItem(
  shopifyOrderId: string,
  opts: { invoiceDate?: Date; orderNumber?: string; customerName?: string } = {}
): Promise<{ model: InvoiceModel; meta: InvoiceMeta; invoiceNo: string; reused: boolean }> {
  const invoiceOrder = await getOrderForInvoice(shopifyOrderId);
  const model = buildInvoiceModel(invoiceOrder);
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
  });

  return { model, meta: { invoiceNo, invoiceDate }, invoiceNo, reused };
}

export async function generateInvoicePdf(
  shopifyOrderId: string,
  meta: { orderNumber?: string; customerName?: string } = {}
): Promise<{ pdf: Uint8Array; invoiceNo: string; filename: string; reused: boolean }> {
  const { model, meta: renderMeta, invoiceNo, reused } = await prepareInvoiceItem(
    shopifyOrderId,
    meta
  );
  const pdf = await renderInvoicePdf(model, renderMeta);
  const filename = `${invoiceNo.replace(/[\\/]/g, "-")}.pdf`;
  return { pdf, invoiceNo, filename, reused };
}
