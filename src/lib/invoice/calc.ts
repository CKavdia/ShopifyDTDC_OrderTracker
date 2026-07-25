// All money math for the invoice. Uses decimal.js so paise never drift via
// binary floating point. Shopify prices are TAX-INCLUSIVE (shop.taxesIncluded
// = true), so every "price" coming from the API already contains GST.
import Decimal from "decimal.js";
import {
  HOME_STATE_CODE,
  HOME_STATE_GST_CODE,
  GST_STATE_CODES,
  DEFAULT_GST,
  SHIPPING_GST_RATE,
} from "./config";
import type { InvoiceOrder, InvoiceLineItem, InvoiceMoney } from "../shopify";

Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

const D = (v: Decimal.Value | undefined | null) => new Decimal(v || 0);
const money = (d: Decimal) => d.toDecimalPlaces(2);
const amt = (set?: InvoiceMoney) => D(set?.shopMoney?.amount);

export interface InvoiceLine {
  title: string;
  variantTitle: string;
  sku: string;
  hsn: string;
  qty: Decimal;
  unitPricePreTax: Decimal;
  grossPreTax: Decimal;
  discount: Decimal;
  discountInclTax: Decimal;
  taxableValue: Decimal;
  rate: Decimal;
  halfRate: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
  gst: Decimal;
  lineTotal: Decimal;
}

export interface InvoiceModel {
  order: InvoiceOrder;
  intraState: boolean;
  placeOfSupply: string;
  lines: InvoiceLine[];
  totals: {
    grossPreTax: Decimal;
    discount: Decimal;
    taxableValue: Decimal;
    cgst: Decimal;
    sgst: Decimal;
    igst: Decimal;
    totalGst: Decimal;
    roundOff: Decimal;
    grandTotal: Decimal;
  };
  amountInWords: string;
}

// Build the fully computed invoice model from a Shopify order.
export function buildInvoiceModel(order: InvoiceOrder): InvoiceModel {
  const shipCode =
    order.shippingAddress?.provinceCode ||
    order.billingAddress?.provinceCode ||
    "";
  const intraState = shipCode === HOME_STATE_CODE;

  const lines = order.lineItems.map((li) => computeLine(li, intraState));

  // Shipping / COD fee as a GST-inclusive taxable line (flat SHIPPING_GST_RATE),
  // so it carries its own tax rather than being swept into round-off.
  const shipping = money(amt(order.totalShippingPriceSet));
  if (shipping.greaterThan(0)) {
    lines.push(
      computeFlatLine(
        order.shippingTitle || "Shipping",
        shipping,
        new Decimal(SHIPPING_GST_RATE),
        intraState
      )
    );
  }

  const zero = new Decimal(0);
  const sum = (key: keyof InvoiceLine) =>
    lines.reduce((acc, l) => acc.plus(l[key] as Decimal), zero);

  const grossPreTax = money(sum("grossPreTax"));
  const discount = money(sum("discount"));
  const taxableValue = money(sum("taxableValue"));
  const cgst = money(sum("cgst"));
  const sgst = money(sum("sgst"));
  const igst = money(sum("igst"));
  const totalGst = money(cgst.plus(sgst).plus(igst));

  // Reconcile against Shopify's authoritative order totals (shipping is now a
  // line, so it's already included in taxableValue + totalGst).
  const shopifyTotal = money(amt(order.totalPriceSet));
  const computedBeforeRounding = money(taxableValue.plus(totalGst));
  const roundOff = money(shopifyTotal.minus(computedBeforeRounding));
  const grandTotal = shopifyTotal;

  const shopifyTax = money(amt(order.totalTaxSet));
  // Only flag genuine divergence. When Shopify recorded no tax, we deliberately
  // synthesized GST at the default rate, so a mismatch there is expected.
  if (
    shopifyTax.greaterThan(0) &&
    totalGst.minus(shopifyTax).abs().greaterThan(new Decimal("0.05"))
  ) {
    console.warn(
      `[invoice] GST reconciliation warning: computed ${totalGst} vs Shopify ${shopifyTax} on order ${order.name}`
    );
  }

  const placeOfSupply = intraState
    ? `${HOME_STATE_GST_CODE}-${order.shippingAddress?.province || "Rajasthan"}`
    : `${GST_STATE_CODES[shipCode] || "??"}-${order.shippingAddress?.province || ""}`;

  return {
    order,
    intraState,
    placeOfSupply,
    lines,
    totals: {
      grossPreTax,
      discount,
      taxableValue,
      cgst,
      sgst,
      igst,
      totalGst,
      roundOff,
      grandTotal,
    },
    amountInWords: rupeesInWords(grandTotal),
  };
}

function computeLine(li: InvoiceLineItem, intraState: boolean): InvoiceLine {
  const qty = D(li.quantity);
  const grossInclTax = amt(li.originalTotalSet); // pre-discount, tax-inclusive
  const discount = li.discountAllocations.reduce(
    (acc, a) => acc.plus(amt(a.allocatedAmountSet)),
    new Decimal(0)
  ); // <-- the fix: discountAllocations, NOT totalDiscountSet
  const netInclTax = grossInclTax.minus(discount);

  // GST amount as Shopify computed it (already on the post-discount value).
  // If Shopify recorded no tax line (charge-tax was off for the product), fall
  // back to DEFAULT_GST_RATE and back the tax out of the GST-inclusive amount.
  let rate: Decimal;
  let gst: Decimal;
  if (li.taxLines.length) {
    gst = li.taxLines.reduce((acc, t) => acc.plus(amt(t.priceSet)), new Decimal(0));
    rate = D(li.taxLines[0].ratePercentage);
  } else {
    // Rate depends on the per-piece selling price (net, tax-inclusive).
    const perPiece = qty.isZero() ? netInclTax : netInclTax.dividedBy(qty);
    rate = new Decimal(
      perPiece.greaterThan(DEFAULT_GST.thresholdPerPiece)
        ? DEFAULT_GST.highRate
        : DEFAULT_GST.lowRate
    );
    gst = netInclTax.times(rate).dividedBy(rate.plus(100));
  }

  const taxableValue = netInclTax.minus(gst);
  const divisor = new Decimal(1).plus(rate.dividedBy(100));
  const grossPreTax = rate.isZero() ? grossInclTax : grossInclTax.dividedBy(divisor);
  const unitPricePreTax = qty.isZero() ? new Decimal(0) : grossPreTax.dividedBy(qty);
  // Discount on the taxable (pre-tax) basis so every column reconciles.
  const discountPreTax = money(grossPreTax).minus(money(taxableValue));

  let cgst = new Decimal(0);
  let sgst = new Decimal(0);
  let igst = new Decimal(0);
  if (intraState) {
    cgst = money(gst.dividedBy(2));
    sgst = money(gst.minus(cgst)); // keep paise exact: sgst = gst - cgst
  } else {
    igst = money(gst);
  }

  return {
    title: li.title,
    variantTitle:
      li.variantTitle && li.variantTitle !== "Default Title" ? li.variantTitle : "",
    sku: li.sku || "",
    hsn: li.product?.hsn?.value || "",
    qty,
    unitPricePreTax: money(unitPricePreTax),
    grossPreTax: money(grossPreTax),
    discount: money(discountPreTax),
    discountInclTax: money(discount),
    taxableValue: money(taxableValue),
    rate,
    halfRate: money(rate.dividedBy(2)),
    cgst,
    sgst,
    igst,
    gst: money(gst),
    lineTotal: money(netInclTax),
  };
}

// A flat GST-inclusive charge (e.g. shipping / COD fee) as a taxable line.
function computeFlatLine(
  title: string,
  amountInclTax: Decimal,
  rate: Decimal,
  intraState: boolean
): InvoiceLine {
  const gst = amountInclTax.times(rate).dividedBy(rate.plus(100));
  const taxable = amountInclTax.minus(gst);
  let cgst = new Decimal(0);
  let sgst = new Decimal(0);
  let igst = new Decimal(0);
  if (intraState) {
    cgst = money(gst.dividedBy(2));
    sgst = money(gst.minus(cgst));
  } else {
    igst = money(gst);
  }
  return {
    title,
    variantTitle: "",
    sku: "",
    hsn: "",
    qty: new Decimal(1),
    unitPricePreTax: money(taxable),
    grossPreTax: money(taxable),
    discount: new Decimal(0),
    discountInclTax: new Decimal(0),
    taxableValue: money(taxable),
    rate,
    halfRate: money(rate.dividedBy(2)),
    cgst,
    sgst,
    igst,
    gst: money(gst),
    lineTotal: money(amountInclTax),
  };
}

// --- Number to Indian-English words (rupees & paise) ----------------------

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return TENS[t] + (o ? " " + ONES[o] : "");
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  let s = "";
  if (h) s += ONES[h] + " Hundred";
  if (rest) s += (s ? " " : "") + twoDigits(rest);
  return s;
}

// Indian grouping: crore, lakh, thousand, hundred.
function integerInWords(num: number): string {
  if (num === 0) return "Zero";
  const crore = Math.floor(num / 10000000);
  const lakh = Math.floor((num % 10000000) / 100000);
  const thousand = Math.floor((num % 100000) / 1000);
  const hundred = num % 1000;

  const parts: string[] = [];
  if (crore) parts.push(integerInWords(crore) + " Crore");
  if (lakh) parts.push(twoDigits(lakh) + " Lakh");
  if (thousand) parts.push(twoDigits(thousand) + " Thousand");
  if (hundred) parts.push(threeDigits(hundred));
  return parts.join(" ");
}

export function rupeesInWords(decimalValue: Decimal.Value): string {
  const d = new Decimal(decimalValue).toDecimalPlaces(2);
  const rupees = d.floor().toNumber();
  const paise = d.minus(d.floor()).times(100).round().toNumber();
  let words = "INR " + integerInWords(rupees);
  if (paise) words += " and " + twoDigits(paise) + " Paise";
  words += " Only";
  return words;
}
