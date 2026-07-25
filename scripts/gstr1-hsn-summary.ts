// GSTR-1 HSN-wise outward-supply summary for a quarter.
//
// Iterates every PAID Shopify order created in the window, rebuilds the invoice
// model (same engine that produces the real invoices), and aggregates the line
// items by HSN + GST rate. Emits two JSON files into the scratchpad for the
// Python xlsx writer, and prints a console table for a quick sanity check.
//
// Run:  npx tsx scripts/gstr1-hsn-summary.ts
// Env :  reads .env.local (SHOPIFY_* / NOTION_*)
import { config as loadEnv } from "dotenv";
import { writeFileSync } from "node:fs";
import Decimal from "decimal.js";

// Load env BEFORE importing shopify.ts — that module reads process.env at import
// time, so it must be pulled in dynamically (inside main) after this runs.
loadEnv({ path: ".env.local" });

// --- Quarter window (Apr 1 - Jun 30, 2026), boundaries in IST -----------------
const TZ_OFFSET = "+05:30"; // mirrors src/app/api/invoices/export/route.ts
const START = "2026-04-01";
const END = "2026-06-30";
const startISO = `${START}T00:00:00${TZ_OFFSET}`;
const endISO = `${END}T23:59:59${TZ_OFFSET}`;

// Where the Python writer picks up its input.
const SCRATCH =
  "C:/Users/anush/AppData/Local/Temp/claude/C--Users-anush-OneDrive-Desktop-Builder-ShopifyOrderTracker/25664144-33d4-46e8-86c7-a5dbad7161c6/scratchpad";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const d = (v: Decimal.Value) => new Decimal(v);

interface Group {
  hsn: string;
  rate: string; // GST %, as string key
  state: string; // place of supply, e.g. "27-Maharashtra"
  isService: boolean; // shipping/COD fee (SAC 9968) vs goods
  uqc: string;
  qty: Decimal;
  totalValue: Decimal; // tax-inclusive sale value
  taxableValue: Decimal;
  igst: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  titleCounts: Map<string, number>; // for representative description
}

interface DetailRow {
  order: string;
  date: string;
  state: string;
  hsn: string;
  product: string;
  qty: string;
  rate: string;
  taxableValue: string;
  cgst: string;
  sgst: string;
  igst: string;
  lineTotal: string;
}

async function main() {
  const { getPaidOrdersInRange, getOrderForInvoice } = await import("../src/lib/shopify");
  const { buildInvoiceModel } = await import("../src/lib/invoice/calc");

  console.log(`Fetching paid orders ${START} .. ${END} (IST)…`);
  const orders = await getPaidOrdersInRange(startISO, endISO);
  console.log(`  ${orders.length} paid orders in window.`);
  if (orders.length === 0) {
    console.log("Nothing to summarise.");
    return;
  }

  const groups = new Map<string, Group>();
  const detail: DetailRow[] = [];
  const missingHsn: { order: string; product: string; qty: string }[] = [];

  const zero = () => new Decimal(0);
  const grand = {
    qty: zero(),
    totalValue: zero(),
    taxableValue: zero(),
    igst: zero(),
    cgst: zero(),
    sgst: zero(),
  };

  let processed = 0;
  for (const order of orders) {
    const id = String(order.id);
    let inv;
    try {
      inv = await getOrderForInvoice(id);
    } catch (err) {
      console.warn(
        `  ! skipping order ${order.name ?? id}: ${
          err instanceof Error ? err.message : err
        }`
      );
      continue;
    }
    const model = buildInvoiceModel(inv);
    const orderName = inv.name || `#${id}`;
    const orderDate = (order.created_at || inv.createdAt || "").slice(0, 10);
    const shippingTitle = inv.shippingTitle || "Shipping";
    // Place of supply (destination state) — same for every line in the order.
    // model.placeOfSupply is "<code>-<name>", e.g. "27-Maharashtra". Fall back to
    // the raw province if it couldn't be resolved (unknown code).
    const state =
      model.placeOfSupply && !model.placeOfSupply.startsWith("??")
        ? model.placeOfSupply
        : inv.shippingAddress?.province ||
          inv.billingAddress?.province ||
          "Unknown";

    for (const line of model.lines) {
      const rawHsn = (line.hsn || "").trim();
      const rate = line.rate.toString();

      // The synthetic shipping/COD line gets SAC 9968; a blank-HSN *goods* line
      // means the product is missing its custom.hsn_sac metafield (flagged).
      const isShipping = rawHsn === "" && line.title === shippingTitle;
      const isGoods = !isShipping;
      const hsn = isShipping ? "9968" : rawHsn;
      if (isGoods && rawHsn === "") {
        missingHsn.push({ order: orderName, product: line.title, qty: line.qty.toString() });
      }

      const key = `${hsn}||${rate}||${state}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          hsn,
          rate,
          state,
          isService: isShipping,
          uqc: isGoods ? "PCS-PIECES" : "OTH-OTHERS",
          qty: zero(),
          totalValue: zero(),
          taxableValue: zero(),
          igst: zero(),
          cgst: zero(),
          sgst: zero(),
          titleCounts: new Map(),
        };
        groups.set(key, g);
      }
      g.qty = g.qty.plus(line.qty);
      g.totalValue = g.totalValue.plus(line.lineTotal);
      g.taxableValue = g.taxableValue.plus(line.taxableValue);
      g.igst = g.igst.plus(line.igst);
      g.cgst = g.cgst.plus(line.cgst);
      g.sgst = g.sgst.plus(line.sgst);
      g.titleCounts.set(line.title, (g.titleCounts.get(line.title) || 0) + 1);

      grand.qty = grand.qty.plus(line.qty);
      grand.totalValue = grand.totalValue.plus(line.lineTotal);
      grand.taxableValue = grand.taxableValue.plus(line.taxableValue);
      grand.igst = grand.igst.plus(line.igst);
      grand.cgst = grand.cgst.plus(line.cgst);
      grand.sgst = grand.sgst.plus(line.sgst);

      detail.push({
        order: orderName,
        date: orderDate,
        state,
        hsn,
        product: line.variantTitle ? `${line.title} (${line.variantTitle})` : line.title,
        qty: line.qty.toString(),
        rate,
        taxableValue: line.taxableValue.toFixed(2),
        cgst: line.cgst.toFixed(2),
        sgst: line.sgst.toFixed(2),
        igst: line.igst.toFixed(2),
        lineTotal: line.lineTotal.toFixed(2),
      });
    }

    processed++;
    if (processed % 25 === 0) console.log(`  …processed ${processed}/${orders.length}`);
    await sleep(150); // be gentle with Shopify/Notion rate limits
  }

  // Sort groups: services (shipping/COD) last, blank-HSN goods next, else by
  // HSN, then rate, then state.
  const sorted = [...groups.values()].sort((a, b) => {
    if (a.isService !== b.isService) return a.isService ? 1 : -1;
    if (a.hsn === "" && b.hsn !== "") return 1;
    if (b.hsn === "" && a.hsn !== "") return -1;
    if (a.hsn !== b.hsn) return a.hsn.localeCompare(b.hsn);
    if (a.rate !== b.rate) return d(a.rate).minus(d(b.rate)).toNumber();
    return a.state.localeCompare(b.state);
  });

  const summaryOut = sorted.map((g) => {
    // Representative description = most frequent line title in the group.
    let desc = "";
    let best = -1;
    for (const [t, n] of g.titleCounts) if (n > best) { best = n; desc = t; }
    return {
      hsn: g.hsn,
      state: g.state,
      description: g.isService ? "Shipping / COD fee (SAC 9968)" : desc,
      uqc: g.uqc,
      totalQuantity: g.qty.toString(),
      totalValue: g.totalValue.toFixed(2),
      rate: g.rate,
      taxableValue: g.taxableValue.toFixed(2),
      igst: g.igst.toFixed(2),
      cgst: g.cgst.toFixed(2),
      sgst: g.sgst.toFixed(2),
      cess: "0.00",
      hsnType: g.isService ? "Services" : "Goods",
    };
  });

  const meta = {
    start: START,
    end: END,
    ordersInWindow: orders.length,
    ordersProcessed: processed,
    grand: {
      qty: grand.qty.toString(),
      totalValue: grand.totalValue.toFixed(2),
      taxableValue: grand.taxableValue.toFixed(2),
      igst: grand.igst.toFixed(2),
      cgst: grand.cgst.toFixed(2),
      sgst: grand.sgst.toFixed(2),
    },
    missingHsnCount: missingHsn.length,
  };

  writeFileSync(`${SCRATCH}/gstr1-summary.json`, JSON.stringify({ meta, rows: summaryOut }, null, 2));
  writeFileSync(`${SCRATCH}/gstr1-detail.json`, JSON.stringify(detail, null, 2));

  // --- Console report --------------------------------------------------------
  console.log(`\nHSN-wise summary (${START} .. ${END}):\n`);
  const pad = (s: string, n: number) => s.padEnd(n);
  const padL = (s: string, n: number) => s.padStart(n);
  console.log(
    pad("HSN", 12) + pad("State", 20) + pad("Rate", 6) + padL("Qty", 6) +
    padL("Taxable", 13) + padL("Total Val", 13) + padL("CGST", 10) +
    padL("SGST", 10) + padL("IGST", 11)
  );
  for (const r of summaryOut) {
    console.log(
      pad(r.hsn || "(no HSN)", 12) + pad(r.state.slice(0, 19), 20) +
      pad(r.rate + "%", 6) + padL(r.totalQuantity, 6) + padL(r.taxableValue, 13) +
      padL(r.totalValue, 13) + padL(r.cgst, 10) + padL(r.sgst, 10) +
      padL(r.igst, 11)
    );
  }
  console.log(
    "\n" + pad("GRAND TOTAL", 38) + padL(grand.qty.toString(), 6) +
    padL(grand.taxableValue.toFixed(2), 13) + padL(grand.totalValue.toFixed(2), 13) +
    padL(grand.cgst.toFixed(2), 10) + padL(grand.sgst.toFixed(2), 10) +
    padL(grand.igst.toFixed(2), 11)
  );
  console.log(
    `\nReconcile check: taxable + all tax = ` +
    grand.taxableValue.plus(grand.igst).plus(grand.cgst).plus(grand.sgst).toFixed(2) +
    ` (should equal sum of invoice grand totals for the quarter)`
  );

  if (missingHsn.length) {
    console.log(`\n⚠ ${missingHsn.length} goods line(s) missing an HSN metafield (custom.hsn_sac):`);
    for (const m of missingHsn) console.log(`   ${m.order}: ${m.product} (qty ${m.qty})`);
    console.log("   → set custom.hsn_sac on these Shopify products and re-run to reclassify.");
  }

  console.log(`\nWrote:\n  ${SCRATCH}/gstr1-summary.json\n  ${SCRATCH}/gstr1-detail.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
