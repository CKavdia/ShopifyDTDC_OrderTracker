// Parity check for the ported invoice engine (run: npx tsx scripts/invoice-check.ts)
import assert from "node:assert";
import { buildInvoiceModel, rupeesInWords } from "../src/lib/invoice/calc";
import { financialYear, formatInvoiceNo, parseSequence } from "../src/lib/invoice/numbering";
import type { InvoiceOrder } from "../src/lib/shopify";

const order1168 = {
  id: "gid://shopify/Order/7074971156629",
  name: "#1168",
  createdAt: "2026-06-21T04:23:01Z",
  displayFinancialStatus: "PAID",
  note: null,
  currencyCode: "INR",
  taxesIncluded: true,
  subtotalPriceSet: { shopMoney: { amount: "2250.0" } },
  totalTaxSet: { shopMoney: { amount: "107.14" } },
  totalDiscountsSet: { shopMoney: { amount: "249.0" } },
  totalPriceSet: { shopMoney: { amount: "2250.0" } },
  customer: null,
  billingAddress: { name: "Seema Gurjar", company: null, address1: "12 Lake View Rd", address2: null, city: "Kankroli", province: "Rajasthan", provinceCode: "RJ", zip: "313324", country: "India", phone: null },
  shippingAddress: { name: "Seema Gurjar", company: null, address1: "12 Lake View Rd", address2: null, city: "Kankroli", province: "Rajasthan", provinceCode: "RJ", zip: "313324", country: "India", phone: null },
  lineItems: [
    {
      title: "Dark Green Handblock Printed Pure Cotton Farshi Suit Set",
      quantity: 1, sku: null, variantTitle: "M", vendor: null,
      originalUnitPriceSet: { shopMoney: { amount: "2499.0" } },
      originalTotalSet: { shopMoney: { amount: "2499.0" } },
      totalDiscountSet: { shopMoney: { amount: "0.0" } },
      discountAllocations: [{ allocatedAmountSet: { shopMoney: { amount: "249.0" } } }],
      taxLines: [{ title: "CGST", ratePercentage: 5, priceSet: { shopMoney: { amount: "107.14" } } }],
      product: { id: "gid://shopify/Product/1", hsn: { value: "62114290" } },
    },
  ],
} as unknown as InvoiceOrder;

const m = buildInvoiceModel(order1168);
const l = m.lines[0];
const t = m.totals;

assert.strictEqual(l.discountInclTax.toString(), "249");
assert.strictEqual(l.discount.toString(), "237.14");
assert.strictEqual(l.taxableValue.toString(), "2142.86");
assert.strictEqual(l.cgst.toString(), "53.57");
assert.strictEqual(l.sgst.toString(), "53.57");
assert.strictEqual(l.hsn, "62114290");
assert.strictEqual(m.intraState, true);
assert.strictEqual(t.grandTotal.toString(), "2250");
assert.strictEqual(
  t.grossPreTax.minus(t.discount).plus(t.totalGst).toString(),
  t.grandTotal.toString(),
  "Subtotal - Discount + GST = Grand Total"
);
assert.strictEqual(rupeesInWords("2250"), "INR Two Thousand Two Hundred Fifty Only");

// Inter-state -> single IGST.
const inter = { ...order1168, shippingAddress: { ...order1168.shippingAddress!, provinceCode: "MH", province: "Maharashtra" } };
const mi = buildInvoiceModel(inter);
assert.strictEqual(mi.intraState, false);
assert.strictEqual(mi.lines[0].igst.toString(), "107.14");
assert.ok(mi.placeOfSupply.startsWith("27-"));

// Numbering helpers.
assert.strictEqual(financialYear(new Date("2026-06-21")), "2026-27");
assert.strictEqual(financialYear(new Date("2026-02-10")), "2025-26");
assert.strictEqual(formatInvoiceNo("2026-27", 1), "UN/2026-27/00001");
assert.strictEqual(parseSequence("UN/2026-27/00042"), 42);

console.log("Ported invoice engine parity check passed ✓");
