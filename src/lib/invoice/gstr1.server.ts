// GSTR-1 HSN-wise outward-supply summary — shared server logic.
//
// Iterates every PAID Shopify order in a window, rebuilds the invoice model (the
// same engine that produces the real invoices), aggregates the line items by
// HSN + GST rate + place-of-supply state, and renders a formatted .xlsx.
//
// Used by GET /api/invoices/hsn-summary. The tax math is identical to the
// standalone script scripts/gstr1-hsn-summary.ts.
import Decimal from "decimal.js";
import ExcelJS from "exceljs";
import { getPaidOrdersInRange, getOrderForInvoice } from "../shopify";
import { data } from "../data";
import { buildInvoiceModel } from "./calc";
import { parseInvoicePdf, type ParsedItem } from "./parse";

export interface Gstr1Row {
  hsn: string;
  state: string; // place of supply, e.g. "27-Maharashtra"
  uqc: string;
  totalQuantity: string;
  totalValue: string; // tax-inclusive sale value
  rate: string;
  taxableValue: string;
  igst: string;
  cgst: string;
  sgst: string;
  cess: string;
  hsnType: string;
}

export interface Gstr1Detail {
  order: string;
  date: string;
  gstin: string; // buyer GSTIN when known — empty rows are the B2C sheet
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

export interface Gstr1Totals {
  qty: string;
  totalValue: string;
  taxableValue: string;
  igst: string;
  cgst: string;
  sgst: string;
}

export interface Gstr1Summary {
  meta: {
    start: string;
    end: string;
    ordersInWindow: number;
    ordersProcessed: number;
    missingHsnCount: number;
    wholesaleCount: number; // offline wholesale invoices included in the window
  };
  rows: Gstr1Row[];
  detail: Gstr1Detail[];
  goodsTotal: Gstr1Totals;
  codTotal: Gstr1Totals;
  grand: Gstr1Totals;
}

interface Group {
  hsn: string;
  rate: string;
  state: string;
  isService: boolean; // shipping/COD fee (SAC), vs goods
  uqc: string;
  qty: Decimal;
  totalValue: Decimal;
  taxableValue: Decimal;
  igst: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  titleCounts: Map<string, number>;
}

const d = (v: Decimal.Value) => new Decimal(v);

// Aggregate all paid orders in [startISO, endISO] into an HSN x rate x state summary.
export async function buildGstr1Summary(
  startISO: string,
  endISO: string,
  opts: { hideCodFee?: boolean } = {}
): Promise<Gstr1Summary> {
  const orders = await getPaidOrdersInRange(startISO, endISO);

  const groups = new Map<string, Group>();
  const detail: Gstr1Detail[] = [];
  let missingHsnCount = 0;

  const zero = () => new Decimal(0);
  const acc = () => ({
    qty: zero(),
    totalValue: zero(),
    taxableValue: zero(),
    igst: zero(),
    cgst: zero(),
    sgst: zero(),
  });
  const grand = acc();
  const goods = acc();
  const cod = acc();

  // One summary row and one detail row per invoice line — every source
  // (frozen snapshot, fresh Shopify model, wholesale PDF) funnels through here.
  const addLine = (a: {
    order: string;
    date: string;
    gstin: string;
    state: string;
    product: string;
    hsn: string;
    isService: boolean;
    qty: Decimal;
    totalValue: Decimal; // tax-inclusive line total
    taxableValue: Decimal;
    igst: Decimal;
    cgst: Decimal;
    sgst: Decimal;
    rate: string;
    title: string;
  }) => {
    if (!a.isService && a.hsn === "") missingHsnCount++;
    const key = `${a.hsn}||${a.rate}||${a.state}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        hsn: a.hsn,
        rate: a.rate,
        state: a.state,
        isService: a.isService,
        uqc: a.isService ? "OTH-OTHERS" : "PCS-PIECES",
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
    g.qty = g.qty.plus(a.qty);
    g.totalValue = g.totalValue.plus(a.totalValue);
    g.taxableValue = g.taxableValue.plus(a.taxableValue);
    g.igst = g.igst.plus(a.igst);
    g.cgst = g.cgst.plus(a.cgst);
    g.sgst = g.sgst.plus(a.sgst);
    g.titleCounts.set(a.title, (g.titleCounts.get(a.title) || 0) + 1);

    const bucket = a.isService ? cod : goods;
    for (const t of [grand, bucket]) {
      t.qty = t.qty.plus(a.qty);
      t.totalValue = t.totalValue.plus(a.totalValue);
      t.taxableValue = t.taxableValue.plus(a.taxableValue);
      t.igst = t.igst.plus(a.igst);
      t.cgst = t.cgst.plus(a.cgst);
      t.sgst = t.sgst.plus(a.sgst);
    }

    detail.push({
      order: a.order,
      date: a.date,
      gstin: a.gstin,
      state: a.state,
      hsn: a.hsn,
      product: a.product,
      qty: a.qty.toString(),
      rate: a.rate,
      taxableValue: a.taxableValue.toFixed(2),
      cgst: a.cgst.toFixed(2),
      sgst: a.sgst.toFixed(2),
      igst: a.igst.toFixed(2),
      lineTotal: a.totalValue.toFixed(2),
    });
  };

  // Frozen line snapshots keyed by Shopify order id — for these orders the
  // issued invoice is the source of truth and Shopify is not consulted.
  const ledgerRows = await data.listInvoices();
  const snapshotByOrderId = new Map(
    ledgerRows
      .filter(
        (r) =>
          r.type === "retail" &&
          r.shopifyOrderId &&
          (r.lineItems?.length ?? 0) > 0
      )
      .map((r) => [r.shopifyOrderId, r])
  );
  // Invoice number per order id — detail rows are keyed by our invoice number,
  // never the Shopify order name.
  const invoiceNoByOrderId = new Map(
    ledgerRows
      .filter((r) => r.type === "retail" && r.shopifyOrderId)
      .map((r) => [r.shopifyOrderId, r.invoiceNo])
  );

  let processed = 0;
  for (const order of orders) {
    const id = String(order.id);
    const orderName = order.name || `#${id}`;
    const orderDate = (order.created_at || "").slice(0, 10);

    const snap = snapshotByOrderId.get(id);
    if (snap) {
      const state = snap.placeOfSupply || "Unknown";
      for (const l of snap.lineItems!) {
        const isShipping = !!l.service;
        addLine({
          order: snap.invoiceNo || orderName,
          date: orderDate,
          gstin: snap.gstin,
          state,
          product: l.variantTitle
            ? `${l.title} (${l.variantTitle})`
            : l.title,
          hsn: isShipping ? "9968" : (l.hsn || "").trim(),
          isService: isShipping,
          qty: d(l.qty),
          totalValue: d(l.lineTotal),
          taxableValue: d(l.taxableValue),
          igst: d(l.igst),
          cgst: d(l.cgst),
          sgst: d(l.sgst),
          rate: String(l.rate),
          title: l.title,
        });
      }
      processed++;
      continue;
    }

    let inv;
    try {
      inv = await getOrderForInvoice(id);
    } catch (err) {
      console.warn(
        `[gstr1] skipping order ${orderName}: ${
          err instanceof Error ? err.message : err
        }`
      );
      continue;
    }
    const priceOverride = await data.getInvoicePriceOverride(id);
    const model = buildInvoiceModel(inv, {
      hideCodFee: opts.hideCodFee,
      priceOverride,
    });
    const shippingTitle = inv.shippingTitle || "Shipping";
    const state =
      model.placeOfSupply && !model.placeOfSupply.startsWith("??")
        ? model.placeOfSupply
        : inv.shippingAddress?.province ||
          inv.billingAddress?.province ||
          "Unknown";

    for (const line of model.lines) {
      const rawHsn = (line.hsn || "").trim();
      // The synthetic shipping/COD line is the only expected blank-HSN line; it
      // carries SAC 9968. A blank-HSN *goods* line means a product is missing
      // its custom.hsn_sac metafield (flagged, kept blank).
      const isShipping = rawHsn === "" && line.title === shippingTitle;
      addLine({
        order: invoiceNoByOrderId.get(id) || orderName,
        date: orderDate,
        // Shopify orders carry no buyer GSTIN in the tool — B2C by definition.
        gstin: "",
        state,
        product: line.variantTitle
          ? `${line.title} (${line.variantTitle})`
          : line.title,
        hsn: isShipping ? "9968" : rawHsn,
        isService: isShipping,
        qty: line.qty,
        totalValue: line.lineTotal,
        taxableValue: line.taxableValue,
        igst: line.igst,
        cgst: line.cgst,
        sgst: line.sgst,
        rate: line.rate.toString(),
        title: line.title,
      });
    }
    processed++;
  }

  // --- Wholesale invoices issued offline -------------------------------------
  // They live only in the ledger (no Shopify order, no line items), so each
  // contributes one summary row: whole-invoice HSN (if recorded on upload),
  // a rate derived from its GST heads and snapped to the nearest slab, and
  // its place of supply. The summary still uses whole-invoice totals; the
  // detail sheet comes from the frozen item-table snapshot when the upload
  // recorded one, else the seller PDF is parsed on the fly, else a single
  // whole-invoice row.
  const wholesale = ledgerRows.filter(
    (i) =>
      i.type === "wholesale" &&
      i.status !== "Cancelled" &&
      i.invoiceDate.slice(0, 10) >= startISO.slice(0, 10) &&
      i.invoiceDate.slice(0, 10) <= endISO.slice(0, 10)
  );
  const SLABS = [0, 5, 12, 18, 28];
  // Add one amount set to the (HSN, rate, state) group and the grand / bucket
  // totals — used by both the whole-invoice fallback and per-line accumulation.
  const accum = (a: {
    state: string;
    hsn: string;
    rate: string;
    isService: boolean;
    qty: Decimal;
    totalValue: Decimal;
    taxableValue: Decimal;
    igst: Decimal;
    cgst: Decimal;
    sgst: Decimal;
    title: string;
  }) => {
    const key = `${a.hsn}||${a.rate}||${a.state}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        hsn: a.hsn,
        rate: a.rate,
        state: a.state,
        isService: a.isService,
        // Pieces known only when an amount carried a qty; else the GSTR-1
        // "others" unit.
        uqc: a.qty.greaterThan(0) ? "PCS-PIECES" : "OTH-OTHERS",
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
    g.qty = g.qty.plus(a.qty);
    g.totalValue = g.totalValue.plus(a.totalValue);
    g.taxableValue = g.taxableValue.plus(a.taxableValue);
    g.igst = g.igst.plus(a.igst);
    g.cgst = g.cgst.plus(a.cgst);
    g.sgst = g.sgst.plus(a.sgst);
    if (a.title) g.titleCounts.set(a.title, (g.titleCounts.get(a.title) || 0) + 1);

    const bucket = a.isService ? cod : goods;
    for (const t of [grand, bucket]) {
      t.qty = t.qty.plus(a.qty);
      t.totalValue = t.totalValue.plus(a.totalValue);
      t.taxableValue = t.taxableValue.plus(a.taxableValue);
      t.igst = t.igst.plus(a.igst);
      t.cgst = t.cgst.plus(a.cgst);
      t.sgst = t.sgst.plus(a.sgst);
    }
  };

  for (const inv of wholesale) {
    const taxable = d(inv.taxableValue);
    const tax = d(inv.cgst).plus(d(inv.sgst)).plus(d(inv.igst));
    const rawRate = taxable.isZero()
      ? 0
      : tax.dividedBy(taxable).times(100).toDecimalPlaces(1).toNumber();
    const rate = SLABS.reduce((best, s) =>
      Math.abs(s - rawRate) < Math.abs(best - rawRate) ? s : best
    );
    const state = inv.placeOfSupply || "Unknown";
    const invHsn = (inv.hsn || "").trim();
    const qty = d(inv.quantity ?? 0);

    // Frozen item-table snapshot: accumulate per line so the HSN Summary
    // groups the real per-line HSNs instead of the (often blank)
    // whole-invoice HSN prop recorded at upload.
    if ((inv.lineItems?.length ?? 0) > 0) {
      for (const l of inv.lineItems!) {
        const lineHsn = (l.hsn || "").trim();
        if (!l.service && !lineHsn) missingHsnCount++;
        accum({
          state,
          hsn: lineHsn,
          rate: String(l.rate ?? rate),
          isService: !!l.service,
          qty: d(l.qty ?? 0),
          totalValue: d(l.lineTotal ?? 0),
          taxableValue: d(l.taxableValue ?? 0),
          igst: d(l.igst ?? 0),
          cgst: d(l.cgst ?? 0),
          sgst: d(l.sgst ?? 0),
          title: l.title,
        });
      }
    } else {
      // Pre-snapshot row: one group off the whole-invoice totals.
      if (!invHsn) missingHsnCount++;
      accum({
        state,
        hsn: invHsn,
        rate: String(rate),
        isService: false,
        qty,
        totalValue: d(inv.grandTotal),
        taxableValue: taxable,
        igst: d(inv.igst),
        cgst: d(inv.cgst),
        sgst: d(inv.sgst),
        title: "",
      });
    }

    // Real product lines come off the frozen item-table snapshot (parsed from
    // the seller's original PDF at upload time); a row from before snapshots
    // existed falls back to parsing the PDF now, and a PDF that fails to read
    // falls back to the one-row-per-invoice line.
    let items: ParsedItem[] = [];
    let detailDone = false;
    if ((inv.lineItems?.length ?? 0) > 0) {
      // Snapshot lines already carry the CGST/SGST vs IGST split made at
      // upload — render them straight into detail rows.
      for (const l of inv.lineItems!) {
        detail.push({
          order: inv.invoiceNo,
          date: inv.invoiceDate.slice(0, 10),
          gstin: inv.gstin,
          state,
          hsn: l.hsn || invHsn,
          product: l.title || `Wholesale — ${inv.customerName}`,
          qty: String(l.qty),
          rate: String(l.rate),
          taxableValue: d(l.taxableValue).toFixed(2),
          cgst: d(l.cgst).toFixed(2),
          sgst: d(l.sgst).toFixed(2),
          igst: d(l.igst).toFixed(2),
          lineTotal: d(l.lineTotal).toFixed(2),
        });
      }
      detailDone = true;
    } else if (inv.origPdfUrl) {
      try {
        const buf = Buffer.from(
          await (await fetch(inv.origPdfUrl)).arrayBuffer()
        );
        items = (await parseInvoicePdf(buf)).items;
      } catch (err) {
        console.warn(
          `[gstr1] item parse failed for ${inv.invoiceNo}: ${
            err instanceof Error ? err.message : err
          }`
        );
      }
    }

    if (!detailDone) {
      if (items.length > 0) {
        // Each row prints its tax once — as IGST, or as a CGST+SGST pair when
        // the buyer sits in the seller's state; the parse flags which.
        for (const it of items) {
          const tax = d(it.taxAmount ?? 0);
          const half = tax.dividedBy(2).toDecimalPlaces(2);
          detail.push({
            order: inv.invoiceNo,
            date: inv.invoiceDate.slice(0, 10),
            gstin: inv.gstin,
            state,
            hsn: it.hsn || invHsn,
            product: it.title || `Wholesale — ${inv.customerName}`,
            qty: (it.qty ?? 0).toString(),
            rate: it.rate != null ? String(it.rate) : String(rate),
            taxableValue: d(it.taxableValue ?? 0).toFixed(2),
            cgst: it.intra ? half.toFixed(2) : "0.00",
            sgst: it.intra ? half.toFixed(2) : "0.00",
            igst: it.intra ? "0.00" : tax.toFixed(2),
            lineTotal: d(it.lineTotal ?? 0).toFixed(2),
          });
        }
      } else {
        detail.push({
          order: inv.invoiceNo,
          date: inv.invoiceDate.slice(0, 10),
          gstin: inv.gstin,
          state,
          hsn: invHsn,
          product: `Wholesale — ${inv.customerName}`,
          qty: qty.toString(),
          rate: String(rate),
          taxableValue: taxable.toFixed(2),
          cgst: d(inv.cgst).toFixed(2),
          sgst: d(inv.sgst).toFixed(2),
          igst: d(inv.igst).toFixed(2),
          lineTotal: d(inv.grandTotal).toFixed(2),
        });
      }
    }
  }
  const wholesaleCount = wholesale.length;

  const sorted = [...groups.values()].sort((a, b) => {
    // Services (shipping/COD) last and blank-HSN goods just before them, then
    // state-wise like the B2C/B2B sheets — HSN, then rate, within each state.
    if (a.isService !== b.isService) return a.isService ? 1 : -1;
    if (a.hsn === "" && b.hsn !== "") return 1;
    if (b.hsn === "" && a.hsn !== "") return -1;
    if (a.state !== b.state) return a.state.localeCompare(b.state);
    if (a.hsn !== b.hsn) return a.hsn.localeCompare(b.hsn);
    return d(a.rate).minus(d(b.rate)).toNumber();
  });

  const rows: Gstr1Row[] = sorted.map((g) => ({
    hsn: g.hsn,
    state: g.state,
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
  }));

  const totals = (t: ReturnType<typeof acc>): Gstr1Totals => ({
    qty: t.qty.toString(),
    totalValue: t.totalValue.toFixed(2),
    taxableValue: t.taxableValue.toFixed(2),
    igst: t.igst.toFixed(2),
    cgst: t.cgst.toFixed(2),
    sgst: t.sgst.toFixed(2),
  });

  return {
    meta: {
      start: startISO.slice(0, 10),
      end: endISO.slice(0, 10),
      ordersInWindow: orders.length,
      ordersProcessed: processed,
      missingHsnCount,
      wholesaleCount,
    },
    rows,
    detail,
    goodsTotal: totals(goods),
    codTotal: totals(cod),
    grand: totals(grand),
  };
}

// --- xlsx rendering ----------------------------------------------------------

const MONEY = "#,##0.00";
const QTY = "#,##0";

const HEADER_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F3864" },
} as const;
const TOTAL_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFD9E1F2" },
} as const;
const THIN = { style: "thin", color: { argb: "FFBFBFBF" } } as const;
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN } as const;

function styleHeader(row: ExcelJS.Row) {
  row.height = 30;
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL as ExcelJS.Fill;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = BORDER as ExcelJS.Borders;
  });
}

function styleData(
  row: ExcelJS.Row,
  moneyCols: number[],
  qtyCol: number,
  rateCol: number = 0 // 0 = sheet has no rate column
) {
  row.eachCell((cell) => {
    cell.border = BORDER as ExcelJS.Borders;
    cell.font = { size: 10 };
  });
  row.getCell(qtyCol).numFmt = QTY;
  if (rateCol > 0) row.getCell(rateCol).numFmt = "0";
  for (const c of moneyCols) row.getCell(c).numFmt = MONEY;
}

function styleTotal(
  row: ExcelJS.Row,
  ncols: number,
  moneyCols: number[],
  qtyCol: number
) {
  for (let c = 1; c <= ncols; c++) {
    const cell = row.getCell(c);
    cell.font = { bold: true };
    cell.fill = TOTAL_FILL as ExcelJS.Fill;
    cell.border = BORDER as ExcelJS.Borders;
  }
  row.getCell(qtyCol).numFmt = QTY;
  for (const c of moneyCols) row.getCell(c).numFmt = MONEY;
}

const n = (s: string) => Number(s);

export async function renderGstr1Workbook(
  summary: Gstr1Summary
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "UrbanNaari Order Tracker";

  // ---- Sheet 1: HSN Summary ----
  const ws = wb.addWorksheet("HSN Summary");
  const widths = [30, 24, 12, 13, 14, 7, 15, 18, 16, 17, 12, 10];
  ws.columns = widths.map((w) => ({ width: w }));
  const NCOLS = widths.length;
  const MONEY_COLS = [5, 7, 8, 9, 10, 11];
  const QTY_COL = 4;
  const RATE_COL = 6;

  styleHeader(
    ws.addRow([
      "HSN",
      "State (Place of Supply)",
      "UQC",
      "Total Quantity",
      "Total Value",
      "Rate",
      "Taxable Value",
      "Integrated Tax Amount",
      "Central Tax Amount",
      "State/UT Tax Amount",
      "Cess Amount",
      "HSN Type",
    ])
  );
  ws.views = [{ state: "frozen", ySplit: 1 }];

  const goodsRows = summary.rows.filter((r) => r.hsnType !== "Services");
  const codRows = summary.rows.filter((r) => r.hsnType === "Services");

  const dataRow = (r: Gstr1Row, hsnLabel?: string) =>
    ws.addRow([
      hsnLabel ?? r.hsn,
      r.state,
      r.uqc,
      n(r.totalQuantity),
      n(r.totalValue),
      n(r.rate),
      n(r.taxableValue),
      n(r.igst),
      n(r.cgst),
      n(r.sgst),
      n(r.cess),
      r.hsnType,
    ]);

  const totalRow = (label: string, t: Gstr1Totals) =>
    ws.addRow([
      label,
      "",
      "",
      n(t.qty),
      n(t.totalValue),
      "",
      n(t.taxableValue),
      n(t.igst),
      n(t.cgst),
      n(t.sgst),
      0,
      "",
    ]);

  for (const r of goodsRows) styleData(dataRow(r), MONEY_COLS, QTY_COL, RATE_COL);
  styleTotal(totalRow("TOTAL - Goods", summary.goodsTotal), NCOLS, MONEY_COLS, QTY_COL);

  ws.addRow([]);
  ws.addRow([]);

  for (const r of codRows) {
    styleData(dataRow(r), MONEY_COLS, QTY_COL, RATE_COL);
  }
  styleTotal(
    totalRow("GRAND TOTAL (Goods + COD)", summary.grand),
    NCOLS,
    MONEY_COLS,
    QTY_COL
  );

  // ---- Sheet 2: B2C Summary (invoices with no buyer GSTIN) -------------------
  // State × HSN × rate rollup — no per-order lines, no dates. Rate is part of
  // the key so one HSN selling at two slabs prints as two rows, never merged.
  const b2c = summary.detail.filter((r) => !r.gstin);
  const byStateHsn = new Map<
    string,
    {
      state: string;
      hsn: string;
      rate: string;
      qty: number;
      taxable: number;
      cgst: number;
      sgst: number;
      igst: number;
      total: number;
    }
  >();
  for (const r of b2c) {
    const key = `${r.state}||${r.hsn}||${r.rate}`;
    const g =
      byStateHsn.get(key) ??
      { state: r.state, hsn: r.hsn, rate: r.rate, qty: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
    g.qty += n(r.qty);
    g.taxable += n(r.taxableValue);
    g.cgst += n(r.cgst);
    g.sgst += n(r.sgst);
    g.igst += n(r.igst);
    g.total += n(r.lineTotal);
    byStateHsn.set(key, g);
  }
  const round2 = (v: number) => Math.round(v * 100) / 100;
  const wsc = wb.addWorksheet("B2C Summary");
  const cwidths = [24, 14, 10, 8, 16, 12, 12, 12, 16];
  wsc.columns = cwidths.map((w) => ({ width: w }));
  const C_MONEY = [5, 6, 7, 8, 9];
  const C_QTY = 4;
  const C_RATE = 3;

  styleHeader(
    wsc.addRow([
      "State (Place of Supply)",
      "HSN",
      "GST Rate",
      "Qty",
      "Taxable Value",
      "CGST",
      "SGST",
      "IGST",
      "Total Value (incl. tax)",
    ])
  );
  wsc.views = [{ state: "frozen", ySplit: 1 }];

  const stateRows = [...byStateHsn.values()].sort(
    (a, b) =>
      a.state.localeCompare(b.state) ||
      a.hsn.localeCompare(b.hsn) ||
      d(a.rate).minus(d(b.rate)).toNumber()
  );
  for (const g of stateRows) {
    const r = wsc.addRow([
      g.state,
      g.hsn || "(blank)",
      d(g.rate).toNumber(),
      g.qty,
      round2(g.taxable),
      round2(g.cgst),
      round2(g.sgst),
      round2(g.igst),
      round2(g.total),
    ]);
    styleData(r, C_MONEY, C_QTY, C_RATE);
  }
  styleTotal(
    wsc.addRow([
      "Total",
      "",
      "",
      round2(stateRows.reduce((a, g) => a + g.qty, 0)),
      round2(stateRows.reduce((a, g) => a + g.taxable, 0)),
      round2(stateRows.reduce((a, g) => a + g.cgst, 0)),
      round2(stateRows.reduce((a, g) => a + g.sgst, 0)),
      round2(stateRows.reduce((a, g) => a + g.igst, 0)),
      round2(stateRows.reduce((a, g) => a + g.total, 0)),
    ]),
    9,
    C_MONEY,
    C_QTY
  );

  // ---- Sheet 3: B2B Summary (invoices with a buyer GSTIN) --------------------
  // Invoice × state × HSN rollup — no products. Each invoice carries its
  // buyer GSTIN, so the row identifies both the buyer and the lines' HSNs.
  const b2b = summary.detail.filter((r) => r.gstin);
  const byInvHsnB2b = new Map<
    string,
    {
      invoice: string;
      gstin: string;
      state: string;
      hsn: string;
      rate: string;
      qty: number;
      taxable: number;
      cgst: number;
      sgst: number;
      igst: number;
      total: number;
    }
  >();
  for (const r of b2b) {
    const key = `${r.order}||${r.gstin}||${r.state}||${r.hsn}||${r.rate}`;
    const g =
      byInvHsnB2b.get(key) ??
      {
        invoice: r.order,
        gstin: r.gstin,
        state: r.state,
        hsn: r.hsn,
        rate: r.rate,
        qty: 0,
        taxable: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        total: 0,
      };
    g.qty += n(r.qty);
    g.taxable += n(r.taxableValue);
    g.cgst += n(r.cgst);
    g.sgst += n(r.sgst);
    g.igst += n(r.igst);
    g.total += n(r.lineTotal);
    byInvHsnB2b.set(key, g);
  }
  const wsb = wb.addWorksheet("B2B Summary");
  const bwidths = [17, 17, 24, 14, 10, 8, 16, 12, 12, 12, 16];
  wsb.columns = bwidths.map((w) => ({ width: w }));
  const B_MONEY = [7, 8, 9, 10, 11];
  const B_QTY = 6;
  const B_RATE = 5;

  styleHeader(
    wsb.addRow([
      "Invoice",
      "Buyer GSTIN",
      "State (Place of Supply)",
      "HSN",
      "GST Rate",
      "Qty",
      "Taxable Value",
      "CGST",
      "SGST",
      "IGST",
      "Total Value (incl. tax)",
    ])
  );
  wsb.views = [{ state: "frozen", ySplit: 1 }];

  const b2bRows = [...byInvHsnB2b.values()].sort(
    (a, b) =>
      a.state.localeCompare(b.state) ||
      a.invoice.localeCompare(b.invoice) ||
      a.hsn.localeCompare(b.hsn) ||
      d(a.rate).minus(d(b.rate)).toNumber()
  );
  for (const g of b2bRows) {
    const r = wsb.addRow([
      g.invoice,
      g.gstin,
      g.state,
      g.hsn || "(blank)",
      d(g.rate).toNumber(),
      g.qty,
      round2(g.taxable),
      round2(g.cgst),
      round2(g.sgst),
      round2(g.igst),
      round2(g.total),
    ]);
    styleData(r, B_MONEY, B_QTY, B_RATE);
  }
  styleTotal(
    wsb.addRow([
      "Total",
      "",
      "",
      "",
      "",
      round2(b2bRows.reduce((a, g) => a + g.qty, 0)),
      round2(b2bRows.reduce((a, g) => a + g.taxable, 0)),
      round2(b2bRows.reduce((a, g) => a + g.cgst, 0)),
      round2(b2bRows.reduce((a, g) => a + g.sgst, 0)),
      round2(b2bRows.reduce((a, g) => a + g.igst, 0)),
      round2(b2bRows.reduce((a, g) => a + g.total, 0)),
    ]),
    11,
    B_MONEY,
    B_QTY
  );

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
