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
  CONDITIONAL_OFFERS,
} from "./config";
import type { InvoiceOrder, InvoiceLineItem, InvoiceMoney } from "../shopify";
import type { InvoicePriceOverride } from "../data/types";

Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

const D = (v: Decimal.Value | undefined | null) => new Decimal(v || 0);
const money = (d: Decimal) => d.toDecimalPlaces(2);
const amt = (set?: InvoiceMoney) => D(set?.shopMoney?.amount);

// The store bills the COD fee as a shipping line titled "COD Fee" (occasionally
// spelled out). Match either, case-insensitively.
const COD_FEE_RE = /\bcod\b|cash\s+on\s+delivery/i;
export function isCodFeeTitle(title: string | null | undefined): boolean {
  return !!title && COD_FEE_RE.test(title);
}

// --- Conditional-offer revocation on returns ------------------------------

// True when a CLOSED return leaves the order short of a conditional offer's
// threshold (CONDITIONAL_OFFERS), which revokes that offer: every line then
// bills at its full pre-discount price. Only percentage offers revoke — a
// fixed-amount discount has no threshold semantics here.
export function discountRevoked(order: InvoiceOrder): boolean {
  if (!order.hasClosedReturn) return false;
  const apps = order.discounts ?? [];
  const matched = apps
    .filter((a) => a.percentage != null)
    .map((a) => {
      const name = a.name.toUpperCase();
      const key = Object.keys(CONDITIONAL_OFFERS).find((k) =>
        name.includes(k.toUpperCase())
      );
      return key ? CONDITIONAL_OFFERS[key] : null;
    })
    .filter((t): t is number => t != null);
  if (!matched.length) return false;
  // Goods pieces REMAINING after the return (shipping is not yet a line —
  // it is appended later, and only the offer's goods condition matters).
  const keptQty = order.lineItems.reduce((s, li) => s + (li.quantity || 0), 0);
  return keptQty < Math.max(...matched);
}

export interface InvoiceLine {
  // Shopify line-item id — the stable key a per-order price override matches on.
  key: string;
  title: string;
  variantTitle: string;
  // "Item Code" column on the invoice — the SKU on Shopify orders, a typed
  // code on manual ones (blank prints an empty cell).
  itemCode: string;
  // Product thumbnail URL (Shopify variant image). Blank = no thumbnail; the
  // invoice drops the thumbnail column entirely when no line carries one.
  imageUrl: string;
  sku: string;
  hsn: string;
  // Unit of measure for the invoice's "per" column ("PCS"). Blank marks a
  // service line (shipping/COD), which Tally excludes from the pieces total.
  unit: string;
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
// opts.hideCodFee drops the COD fee shipping line from the invoice entirely:
// the grand total is then reduced by the fee amount (it no longer reconciles to
// Shopify's order total, which always includes the fee), and the tax
// reconciliation warning is suppressed (Shopify's totalTax includes the fee's
// GST, the invoice deliberately does not).
// opts.priceOverride forces the goods unit price (tax-EXCLUSIVE) and GST rate
// for this order only — the customer paid a fixed unit price (e.g. ₹2,499 with
// 5% GST on top) and the remainder of what they paid is a store credit handled
// in bookkeeping, not on the invoice. Totals then stand on their own computed
// figures, like the revoked branch: there is no Shopify total to reconcile to.
export function buildInvoiceModel(
  order: InvoiceOrder,
  opts: { hideCodFee?: boolean; priceOverride?: InvoicePriceOverride | null } = {}
): InvoiceModel {
  const shipCode =
    order.shippingAddress?.provinceCode ||
    order.billingAddress?.provinceCode ||
    "";
  const intraState = shipCode === HOME_STATE_CODE;

  // A conditional offer can be revoked by the return (e.g. "Buy 2 get 10%
  // off" with one piece returned). Revoked lines print at full price and the
  // invoice totals are computed from the lines, since Shopify's totals still
  // embed the discount.
  const revoked = discountRevoked(order);
  const override = opts.priceOverride ?? null;

  const lines = spreadFullDiscounts(
    revoked
      ? order.lineItems.map((li) => ({ ...li, discountAllocations: [] }))
      : order.lineItems
  ).map((li) => computeLine(li, intraState, revoked));

  // Apply the forced unit prices / rate to the goods lines. The override is
  // tax-exclusive: unitPricePreTax prints as-is and GST sits on top of it.
  // Lines are matched by Shopify line-item id; a "*" wildcard matches every
  // goods line (legacy single-price overrides). A line with no matching
  // override entry keeps its Shopify-computed price.
  if (override) {
    for (const l of lines) {
      const ol =
        override.lines.find((x) => x.key === l.key) ??
        override.lines.find((x) => x.key === "*");
      if (ol) forcePrice(l, ol.unitPrice, override.gstRate, intraState);
    }
  }

  // Shipping / COD fee as a GST-inclusive taxable line (flat SHIPPING_GST_RATE),
  // so it carries its own tax rather than being swept into round-off.
  const shipping = money(amt(order.totalShippingPriceSet));
  // The store models the COD fee as a shipping line whose title says so (e.g.
  // "COD Fee"). Note the limitation: with the single shippingLine the query
  // fetches, an order combining real shipping AND a COD fee would drop both —
  // in practice the store uses one or the other.
  const codFeeHidden = !!opts.hideCodFee && isCodFeeTitle(order.shippingTitle);
  if (shipping.greaterThan(0) && !codFeeHidden) {
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
  // line, so it's already included in taxableValue + totalGst). When the COD
  // fee is hidden, the invoice total is Shopify's total minus the fee. When a
  // conditional offer was revoked, Shopify's totals still embed the discount
  // the invoice no longer honours, so the invoice stands on its own computed
  // figures instead.
  const shopifyTotal = money(amt(order.totalPriceSet));
  const computedBeforeRounding = money(taxableValue.plus(totalGst));
  // Our slab rule can disagree with what the customer actually paid at checkout
  // (Shopify collected tax at a different rate). The invoice then stands on its
  // own computed figures — the shortfall or surplus vs the payment is
  // bookkeeping (store credit / refund), never round-off on the invoice face.
  const targetTotal = codFeeHidden
    ? money(shopifyTotal.minus(shipping))
    : shopifyTotal;
  const figuresMatch =
    computedBeforeRounding.minus(targetTotal).abs().lessThanOrEqualTo("0.05");
  const grandTotal =
    revoked || override || !figuresMatch
      ? computedBeforeRounding
      : targetTotal;
  const roundOff = money(grandTotal.minus(computedBeforeRounding));

  const shopifyTax = money(amt(order.totalTaxSet));
  // Flag the mismatch explicitly: our rule charging a different GST than
  // Shopify collected is exactly the case worth seeing in the logs.
  if (
    shopifyTax.greaterThan(0) &&
    !codFeeHidden &&
    !revoked &&
    !override &&
    totalGst.minus(shopifyTax).abs().greaterThan(new Decimal("0.05"))
  ) {
    console.warn(
      `[invoice] GST rule differs from Shopify's collected tax: computed ${totalGst} vs Shopify ${shopifyTax} on order ${order.name}`
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

// Shopify sometimes lands a promotion's entire discount on a single line —
// most often a BOGO where the free piece carries 100% off. On the invoice
// that prints as one full-price line next to a zero-value line: the zero line
// bills no GST and reads like a mistake. When any line is discounted to
// zero, treat the basket's discounts as one pool and share it over every
// goods line in proportion to its own value, so each line shows its effective
// post-promotion price and none is left at zero. Discounts that are merely
// uneven (a code off one product) are left exactly as Shopify allocated them.
function spreadFullDiscounts(items: InvoiceLineItem[]): InvoiceLineItem[] {
  const grossOf = (li: InvoiceLineItem) => amt(li.originalTotalSet);
  const discOf = (li: InvoiceLineItem) =>
    li.discountAllocations.reduce(
      (acc, a) => acc.plus(amt(a.allocatedAmountSet)),
      new Decimal(0)
    );

  const wiped = items.filter(
    (li) => grossOf(li).greaterThan(0) && discOf(li).greaterThanOrEqualTo(grossOf(li))
  );
  if (!wiped.length) return items;

  const pool = items.reduce((acc, li) => acc.plus(discOf(li)), new Decimal(0));
  const base = items.reduce(
    (acc, li) => (grossOf(li).greaterThan(0) ? acc.plus(grossOf(li)) : acc),
    new Decimal(0)
  );
  if (pool.isZero() || base.isZero()) return items;

  // Hand out rounded shares and give the paise left over to the last line so
  // the pool stays exact — the invoice must reconcile to Shopify's totals.
  let given = new Decimal(0);
  const carriers = items.filter((li) => grossOf(li).greaterThan(0));
  const shares = carriers.map((li, i) => {
    if (i === carriers.length - 1) {
      const last = money(pool.minus(given));
      given = given.plus(last);
      return [li, last] as const;
    }
    const share = money(pool.times(grossOf(li)).dividedBy(base));
    given = given.plus(share);
    return [li, share] as const;
  });
  const shareByRef = new Map(shares);
  return items.map((li) => {
    const share = shareByRef.get(li);
    if (!share) return li; // zero-value line keeps its identity, no discount
    return {
      ...li,
      discountAllocations: [
        { allocatedAmountSet: { shopMoney: { amount: share.toFixed(2) } } },
      ],
    };
  });
}

function computeLine(
  li: InvoiceLineItem,
  intraState: boolean,
  revokeDiscount = false
): InvoiceLine {  const qty = D(li.quantity);
  const grossInclTax = amt(li.originalTotalSet); // pre-discount, tax-inclusive
  // When the offer is revoked, the discount allocation is ignored — the line
  // bills at its full price even though Shopify's allocation still carries it.
  const discount = revokeDiscount
    ? new Decimal(0)
    : li.discountAllocations.reduce(
        (acc, a) => acc.plus(amt(a.allocatedAmountSet)),
        new Decimal(0)
      );
  const netInclTax = grossInclTax.minus(discount);

  // Heads (CGST/SGST or IGST) are the authoritative figures: each is rounded
  // from the tax-extracted basis (net ÷ (1 + rate)), and the taxable value is
  // derived as lineTotal minus the heads so every line reconciles to the
  // paise: taxable + CGST + SGST = lineTotal (or taxable + IGST).
  // Deriving taxable from Shopify's recorded tax instead leaves head-rounding
  // drift inside the line, which revoked orders (no Shopify total to reconcile
  // to) cannot absorb silently.
  // The GST rate is OUR slab rule on the BILLED taxable value per piece (the
  // customer-facing ₹2,500 threshold), never Shopify's recorded tax lines —
  // an order edit can leave Shopify's rate stale (order #1226 carried 18% for
  // a piece billed under ₹2,500).
  //
  // The pre-tax basis is extracted at OUR rate, never Shopify's. Shopify's
  // listed prices are tax-inclusive, so extracting at the rate we charge makes
  // the line total equal the amount the customer actually paid — charging 5%
  // on a basis extracted at Shopify's 18% produced line totals that matched
  // neither the checkout nor the slab (order #1225 billed 1,377.14 for a
  // piece whose checkout amount was 1,547.64).
  //
  // When neither rate satisfies the slab (checkout amount per piece in the
  // band where 5% bills above ₹2,500 and 18% bills below it), the invoice
  // prints the largest slab-compliant value (₹2,500 per piece @ 5%); the
  // shortfall vs the payment is booked as a customer advance off the invoice
  // face (orders #1170/#1198 use a price override for the same outcome).
  const shopifyRate = li.taxLines.length
    ? D(li.taxLines[0].ratePercentage)
    : null;
  let rate: Decimal;
  let preTaxNet: Decimal;
  if (shopifyRate != null && shopifyRate.isZero()) {
    rate = new Decimal(0); // exempt line — keep it exempt
    preTaxNet = netInclTax;
  } else {
    const netPerPiece = qty.isZero() ? netInclTax : netInclTax.dividedBy(qty);
    const divisor = (r: Decimal.Value) =>
      new Decimal(1).plus(D(r).dividedBy(100));
    const lowTaxable = netPerPiece.dividedBy(divisor(DEFAULT_GST.lowRate));
    const highTaxable = netPerPiece.dividedBy(divisor(DEFAULT_GST.highRate));
    if (lowTaxable.lessThanOrEqualTo(DEFAULT_GST.thresholdPerPiece)) {
      // 5% keeps the billed value inside the slab — bill the actual amount.
      rate = D(DEFAULT_GST.lowRate);
      preTaxNet = netInclTax.dividedBy(divisor(DEFAULT_GST.lowRate));
    } else if (highTaxable.greaterThan(DEFAULT_GST.thresholdPerPiece)) {
      // 18% keeps the billed value above the slab — bill the actual amount.
      rate = D(DEFAULT_GST.highRate);
      preTaxNet = netInclTax.dividedBy(divisor(DEFAULT_GST.highRate));
    } else {
      // Dead band: no rate both matches the payment and respects the slab.
      rate = D(DEFAULT_GST.lowRate);
      preTaxNet = D(
        qty.isZero()
          ? DEFAULT_GST.thresholdPerPiece
          : DEFAULT_GST.thresholdPerPiece * qty.toNumber()
      );
    }
  }

  // GST is recomputed on the pre-tax basis at our rate. When the checkout
  // collected a different rate, the line total differs from what the customer
  // paid — the invoice prints our figures and the difference is bookkeeping.
  const taxableValue = preTaxNet;

  const { cgst, sgst, igst } = splitTax(taxableValue, rate, intraState);
  const gst = money(cgst.plus(sgst).plus(igst));

  const basisDivisor = new Decimal(1).plus(rate.dividedBy(100));
  const grossPreTax = grossInclTax.dividedBy(basisDivisor);
  const unitPricePreTax = qty.isZero() ? new Decimal(0) : grossPreTax.dividedBy(qty);
  // Discount on the taxable (pre-tax) basis so every column reconciles.
  const discountPreTax = money(grossPreTax).minus(money(taxableValue));

  return {
    key: li.id || "",
    title: li.title,
    variantTitle:
      li.variantTitle && li.variantTitle !== "Default Title" ? li.variantTitle : "",
    itemCode: li.sku || "",
    imageUrl: li.imageUrl || "",
    sku: li.sku || "",
    hsn: li.product?.hsn?.value || "",
    unit: "PCS",
    qty,
    unitPricePreTax: money(unitPricePreTax),
    grossPreTax: money(grossPreTax),
    discount: discountPreTax,
    discountInclTax: money(discount),
    taxableValue,
    rate,
    halfRate: money(rate.dividedBy(2)),
    cgst,
    sgst,
    igst,
    // The heads are the authoritative figures once split, so keep `gst` equal
    // to their sum rather than to the pre-split value.
    gst,
    // The line's own tax-inclusive total at OUR rate. When the checkout
    // collected a different rate this differs from the customer's payment —
    // the invoice stands on its own figures.
    lineTotal: money(taxableValue.plus(gst)),
  };
}

// Split tax into heads the way GST law (and Tally) does it: each head is
// computed from the taxable value at its own rate and rounded independently.
// Halving a single rounded total instead would leave CGST and SGST differing
// by a paise on odd amounts, which is wrong on the face of an invoice.
function splitTax(
  taxableValue: Decimal,
  rate: Decimal,
  intraState: boolean
): { cgst: Decimal; sgst: Decimal; igst: Decimal } {
  const zero = new Decimal(0);
  if (intraState) {
    const half = money(taxableValue.times(rate.dividedBy(2)).dividedBy(100));
    return { cgst: half, sgst: half, igst: zero };
  }
  return { cgst: zero, sgst: zero, igst: money(taxableValue.times(rate).dividedBy(100)) };
}

// Force one goods line to its overridden unit price. The override is
// tax-EXCLUSIVE: unitPricePreTax is the printed unit price (pre-tax) and GST
// at the forced rate sits on top of it. Discounts are not honoured — the
// customer agreed a fixed price, and any shortfall they paid vs this total is
// a store credit booked outside the invoice.
function forcePrice(
  l: InvoiceLine,
  unitPrice: number,
  gstRate: number,
  intraState: boolean
): void {
  const unit = money(D(unitPrice));
  const grossPreTax = money(unit.times(l.qty));
  const taxableValue = grossPreTax;
  const rate = new Decimal(gstRate);
  const { cgst, sgst, igst } = splitTax(taxableValue, rate, intraState);
  const gst = money(cgst.plus(sgst).plus(igst));
  l.unitPricePreTax = unit;
  l.grossPreTax = grossPreTax;
  l.discount = new Decimal(0);
  l.discountInclTax = new Decimal(0);
  l.taxableValue = taxableValue;
  l.rate = rate;
  l.halfRate = money(rate.dividedBy(2));
  l.cgst = cgst;
  l.sgst = sgst;
  l.igst = igst;
  l.gst = gst;
  l.lineTotal = money(taxableValue.plus(gst));
}

// A flat GST-inclusive charge (e.g. shipping / COD fee) as a taxable line.
// Heads are authoritative and the taxable value is derived from them, exactly
// like computeLine, so the line reconciles: taxable + heads = amountInclTax.
function computeFlatLine(
  title: string,
  amountInclTax: Decimal,
  rate: Decimal,
  intraState: boolean
): InvoiceLine {
  const divisor = new Decimal(1).plus(rate.dividedBy(100));
  const taxBasis = rate.isZero() ? amountInclTax : amountInclTax.dividedBy(divisor);
  const { cgst, sgst, igst } = splitTax(taxBasis, rate, intraState);
  const gst = money(cgst.plus(sgst).plus(igst));
  const taxable = money(amountInclTax.minus(gst));
  return {
    key: "", // service line — never matched by a price override
    title,
    variantTitle: "",
    itemCode: "",
    imageUrl: "",
    sku: "",
    hsn: "",
    unit: "", // service line
    qty: new Decimal(1),
    unitPricePreTax: taxable,
    grossPreTax: taxable,
    discount: new Decimal(0),
    discountInclTax: new Decimal(0),
    taxableValue: taxable,
    rate,
    halfRate: money(rate.dividedBy(2)),
    cgst,
    sgst,
    igst,
    gst: money(cgst.plus(sgst).plus(igst)),
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
