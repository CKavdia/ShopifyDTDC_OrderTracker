// Money math for a manually-typed invoice — a sale that never went through
// Shopify (offline, wholesale, counter). It produces the SAME `InvoiceModel`
// that `calc.ts` builds from a Shopify order, wrapped around a synthetic
// `InvoiceOrder`, so `render.server.ts` renders it with no special-casing and
// the PDF comes out identical to an order-generated one.
//
// Deliberately isomorphic: this module imports only decimal.js and ./config
// (no node:fs, no puppeteer, no ../shopify at runtime) so the form component
// can import it directly and show live totals computed by the very same code
// that produces the PDF.
import Decimal from "decimal.js";
import {
  HOME_STATE_CODE,
  GST_STATE_CODES,
  GST_STATE_NAMES,
  SHIPPING_GST_RATE,
} from "./config";
import { rupeesInWords, type InvoiceLine, type InvoiceModel } from "./calc";
import type { InvoiceAddress, InvoiceOrder } from "../shopify";

Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

const D = (v: Decimal.Value | undefined | null) => new Decimal(v || 0);
const money = (d: Decimal) => d.toDecimalPlaces(2);

// The GST slabs offered on the form. Anything else is rejected.
export const GST_RATES = [0, 5, 12, 18, 28] as const;

// Options for the state dropdown, alphabetical by name.
export const STATE_OPTIONS: Array<{ code: string; name: string }> = Object.keys(
  GST_STATE_NAMES
)
  .map((code) => ({ code, name: GST_STATE_NAMES[code] }))
  .sort((a, b) => a.name.localeCompare(b.name));

export interface ManualParty {
  name: string;
  company: string;
  address1: string;
  address2: string;
  city: string;
  stateCode: string; // key of GST_STATE_CODES, e.g. "RJ"
  zip: string;
  phone: string;
}

export interface ManualLineInput {
  itemCode: string; // the invoice's "Item Code" column (blank prints empty)
  description: string;
  hsn: string;
  unit: string; // the invoice's "per" column, e.g. PCS / SET / MTR
  qty: number;
  rate: number; // per unit — GST-inclusive or not, per `pricesIncludeTax`
  gstRate: number; // one of GST_RATES
  discount: number; // absolute ₹ off the line, on the same basis as `rate`
}

export interface ManualInvoiceInput {
  invoiceNo: string;
  invoiceDate: string; // YYYY-MM-DD
  reference: string; // free text, e.g. a PO number
  pricesIncludeTax: boolean;
  buyer: ManualParty & { gstin: string };
  sameAsBilling: boolean;
  shipTo: ManualParty;
  lines: ManualLineInput[];
  shipping: { amount: number; gstRate: number };
  notes: string;
  markPaid: boolean;
}

export function emptyParty(): ManualParty {
  return {
    name: "",
    company: "",
    address1: "",
    address2: "",
    city: "",
    stateCode: HOME_STATE_CODE,
    zip: "",
    phone: "",
  };
}

export function emptyLine(): ManualLineInput {
  return { itemCode: "", description: "", hsn: "", unit: "PCS", qty: 1, rate: 0, gstRate: 5, discount: 0 };
}

export function emptyManualInvoice(): ManualInvoiceInput {
  return {
    invoiceNo: "",
    invoiceDate: todayISO(),
    reference: "",
    pricesIncludeTax: false,
    buyer: { ...emptyParty(), gstin: "" },
    sameAsBilling: true,
    shipTo: emptyParty(),
    lines: [emptyLine()],
    shipping: { amount: 0, gstRate: SHIPPING_GST_RATE },
    notes: "",
    markPaid: false,
  };
}

// Local (IST-agnostic) calendar date — `toISOString()` would shift back a day
// for anyone east of UTC before 05:30.
export function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// --- Model building -------------------------------------------------------

export function buildManualInvoiceModel(input: ManualInvoiceInput): InvoiceModel {
  const intraState = input.buyer.stateCode === HOME_STATE_CODE;

  const lines = input.lines
    .filter((l) => l.description.trim() !== "" || D(l.qty).times(D(l.rate)).greaterThan(0))
    .map((l) => computeManualLine(l, intraState, input.pricesIncludeTax));

  const shippingAmount = D(input.shipping.amount);
  if (shippingAmount.greaterThan(0)) {
    lines.push(
      computeManualLine(
        {
          itemCode: "",
          description: "Shipping & Handling",
          hsn: "",
          unit: "", // service line — kept out of the pieces total
          qty: 1,
          rate: input.shipping.amount,
          gstRate: input.shipping.gstRate,
          discount: 0,
        },
        intraState,
        input.pricesIncludeTax
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

  // No external total to reconcile against (unlike a Shopify order), so the
  // invoice rounds itself to whole rupees the way a paper bill would.
  const beforeRounding = money(taxableValue.plus(totalGst));
  const grandTotal = beforeRounding.toDecimalPlaces(0);
  const roundOff = money(grandTotal.minus(beforeRounding));

  const placeOfSupply = `${GST_STATE_CODES[input.buyer.stateCode] || "??"}-${
    GST_STATE_NAMES[input.buyer.stateCode] || ""
  }`;

  const order = syntheticOrder(input, {
    taxableValue,
    totalGst,
    discount,
    grandTotal,
    shipping: shippingAmount,
  });

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

// Exported so the form can price a single row without rebuilding the whole
// model — model.lines is filtered and has the shipping row appended, so its
// indices don't line up with the rows on screen.
export function computeManualLine(
  li: ManualLineInput,
  intraState: boolean,
  pricesIncludeTax: boolean
): InvoiceLine {
  const qty = D(li.qty);
  const rate = D(li.gstRate);
  const gross = qty.times(D(li.rate));
  const enteredDiscount = D(li.discount);
  const net = gross.minus(enteredDiscount);

  let taxableValue: Decimal;
  let gst: Decimal;
  let grossPreTax: Decimal;
  let lineTotal: Decimal;

  if (pricesIncludeTax) {
    // The typed price already contains GST — back it out, exactly as calc.ts
    // does for Shopify's tax-inclusive prices.
    gst = rate.isZero() ? new Decimal(0) : net.times(rate).dividedBy(rate.plus(100));
    taxableValue = net.minus(gst);
    grossPreTax = rate.isZero()
      ? gross
      : gross.dividedBy(new Decimal(1).plus(rate.dividedBy(100)));
    lineTotal = net;
  } else {
    taxableValue = net;
    gst = taxableValue.times(rate).dividedBy(100);
    grossPreTax = gross;
    lineTotal = net.plus(gst);
  }

  const unitPricePreTax = qty.isZero() ? new Decimal(0) : grossPreTax.dividedBy(qty);
  // Discount stated on the taxable (pre-tax) basis so every column reconciles.
  const discountPreTax = money(grossPreTax).minus(money(taxableValue));

  // Each head computed from the taxable value at its own rate and rounded
  // independently — same rule as calc.ts, so CGST and SGST always match.
  const zero = new Decimal(0);
  let cgst = zero;
  let sgst = zero;
  let igst = zero;
  if (intraState) {
    cgst = money(taxableValue.times(rate.dividedBy(2)).dividedBy(100));
    sgst = cgst;
  } else {
    igst = money(taxableValue.times(rate).dividedBy(100));
  }
  const splitGst = money(cgst.plus(sgst).plus(igst));

  return {
    key: "", // manual line — never matched by a price override
    title: li.description.trim() || "Item",
    variantTitle: "",
    itemCode: (li.itemCode || "").trim(),
    imageUrl: "",
    sku: "",
    hsn: (li.hsn || "").trim(),
    unit: (li.unit || "").trim(),
    qty,
    unitPricePreTax: money(unitPricePreTax),
    grossPreTax: money(grossPreTax),
    discount: discountPreTax,
    discountInclTax: money(enteredDiscount),
    taxableValue: money(taxableValue),
    rate,
    halfRate: money(rate.dividedBy(2)),
    cgst,
    sgst,
    igst,
    gst: splitGst,
    // On the exclusive basis the line total follows the split heads, so it can
    // never drift a paise from what the invoice's tax rows add up to.
    lineTotal: pricesIncludeTax ? money(lineTotal) : money(taxableValue.plus(splitGst)),
  };
}

function toInvoiceAddress(p: ManualParty): InvoiceAddress {
  return {
    name: p.name.trim() || null,
    company: p.company.trim() || null,
    address1: p.address1.trim() || null,
    address2: p.address2.trim() || null,
    city: p.city.trim() || null,
    province: GST_STATE_NAMES[p.stateCode] || null,
    provinceCode: p.stateCode || null,
    zip: p.zip.trim() || null,
    country: "India",
    phone: p.phone.trim() || null,
  };
}

// A stand-in for the Shopify order the renderer expects. `name` is left empty —
// that is the signal render.server.ts uses to drop the Shopify-only "Order" and
// "Order Date" rows from the invoice details panel.
function syntheticOrder(
  input: ManualInvoiceInput,
  t: {
    taxableValue: Decimal;
    totalGst: Decimal;
    discount: Decimal;
    grandTotal: Decimal;
    shipping: Decimal;
  }
): InvoiceOrder {
  const set = (d: Decimal) => ({ shopMoney: { amount: d.toFixed(2) } });
  const billing = toInvoiceAddress(input.buyer);
  return {
    id: "",
    name: "",
    createdAt: input.invoiceDate,
    displayFinancialStatus: input.markPaid ? "PAID" : "",
    note: input.notes || null,
    currencyCode: "INR",
    subtotalPriceSet: set(t.taxableValue),
    totalTaxSet: set(t.totalGst),
    totalDiscountsSet: set(t.discount),
    totalPriceSet: set(t.grandTotal),
    totalShippingPriceSet: set(t.shipping),
    shippingTitle: null,
    taxesIncluded: input.pricesIncludeTax,
    billingAddress: billing,
    shippingAddress: input.sameAsBilling ? billing : toInvoiceAddress(input.shipTo),
    lineItems: [],
  };
}

// --- Untrusted input ------------------------------------------------------

// Coerce an arbitrary JSON body into a fully-formed ManualInvoiceInput. Every
// field is defaulted, so `validateManualInvoice` only has to judge values, not
// guard against missing keys or wrong types.
export function parseManualInvoiceInput(body: unknown): ManualInvoiceInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const num = (v: unknown) => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? n : 0;
  };
  const party = (v: unknown): ManualParty => {
    const p = (v ?? {}) as Record<string, unknown>;
    return {
      name: str(p.name),
      company: str(p.company),
      address1: str(p.address1),
      address2: str(p.address2),
      city: str(p.city),
      stateCode: str(p.stateCode).toUpperCase(),
      zip: str(p.zip),
      phone: str(p.phone),
    };
  };

  const buyerRaw = (b.buyer ?? {}) as Record<string, unknown>;
  const shipping = (b.shipping ?? {}) as Record<string, unknown>;
  const rawLines = Array.isArray(b.lines) ? b.lines : [];

  return {
    invoiceNo: str(b.invoiceNo).trim(),
    invoiceDate: str(b.invoiceDate).trim(),
    reference: str(b.reference).trim(),
    pricesIncludeTax: b.pricesIncludeTax === true,
    buyer: { ...party(b.buyer), gstin: str(buyerRaw.gstin).trim().toUpperCase() },
    sameAsBilling: b.sameAsBilling !== false,
    shipTo: party(b.shipTo),
    lines: rawLines.map((l) => {
      const r = (l ?? {}) as Record<string, unknown>;
      return {
        itemCode: str(r.itemCode),
        description: str(r.description),
        hsn: str(r.hsn),
        unit: str(r.unit) || "PCS",
        qty: num(r.qty),
        rate: num(r.rate),
        gstRate: num(r.gstRate),
        discount: num(r.discount),
      };
    }),
    shipping: { amount: num(shipping.amount), gstRate: num(shipping.gstRate) },
    notes: str(b.notes),
    markPaid: b.markPaid === true,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 15 chars: 2-digit state code, 10-char PAN, entity digit, 'Z', checksum.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

// Returns the first problem found, or null when the invoice can be generated.
// Shared by the form (to disable the button) and the API route (to reject bad
// payloads), so both agree on what a valid invoice is.
export function validateManualInvoice(input: ManualInvoiceInput): string | null {
  if (!input.invoiceNo) return "Invoice number is required.";
  if (!DATE_RE.test(input.invoiceDate)) return "Invoice date must be a valid date.";
  if (!input.buyer.name.trim()) return "Buyer name is required.";
  if (!GST_STATE_CODES[input.buyer.stateCode])
    return "Select a valid buyer state.";
  if (input.buyer.gstin && !GSTIN_RE.test(input.buyer.gstin))
    return "Buyer GSTIN must be 15 characters in the standard format.";
  if (!input.sameAsBilling && !GST_STATE_CODES[input.shipTo.stateCode])
    return "Select a valid ship-to state.";

  const priced = input.lines.filter((l) => l.qty > 0 && l.rate > 0);
  if (priced.length === 0)
    return "Add at least one line item with a quantity and a rate.";

  for (const [i, l] of input.lines.entries()) {
    const label = `Line ${i + 1}`;
    if (l.qty < 0 || l.rate < 0 || l.discount < 0)
      return `${label}: quantity, rate and discount cannot be negative.`;
    if (!GST_RATES.includes(l.gstRate as (typeof GST_RATES)[number]))
      return `${label}: GST rate must be one of ${GST_RATES.join(", ")}%.`;
    if (l.discount > l.qty * l.rate)
      return `${label}: discount is larger than the line amount.`;
    if (l.qty > 0 && l.rate > 0 && !l.description.trim())
      return `${label}: description is required.`;
  }

  if (input.shipping.amount < 0) return "Shipping amount cannot be negative.";
  if (
    input.shipping.amount > 0 &&
    !GST_RATES.includes(input.shipping.gstRate as (typeof GST_RATES)[number])
  )
    return `Shipping GST rate must be one of ${GST_RATES.join(", ")}%.`;

  return null;
}
