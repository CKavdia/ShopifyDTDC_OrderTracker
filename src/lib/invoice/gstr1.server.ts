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
import { buildInvoiceModel } from "./calc";

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
  endISO: string
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

  let processed = 0;
  for (const order of orders) {
    const id = String(order.id);
    let inv;
    try {
      inv = await getOrderForInvoice(id);
    } catch (err) {
      console.warn(
        `[gstr1] skipping order ${order.name ?? id}: ${
          err instanceof Error ? err.message : err
        }`
      );
      continue;
    }
    const model = buildInvoiceModel(inv);
    const orderName = inv.name || `#${id}`;
    const orderDate = (order.created_at || inv.createdAt || "").slice(0, 10);
    const shippingTitle = inv.shippingTitle || "Shipping";
    const state =
      model.placeOfSupply && !model.placeOfSupply.startsWith("??")
        ? model.placeOfSupply
        : inv.shippingAddress?.province ||
          inv.billingAddress?.province ||
          "Unknown";

    for (const line of model.lines) {
      const rawHsn = (line.hsn || "").trim();
      const rate = line.rate.toString();
      // The synthetic shipping/COD line is the only expected blank-HSN line; give
      // it SAC 9968. A blank-HSN *goods* line means a product is missing its
      // custom.hsn_sac metafield (flagged, kept blank).
      const isShipping = rawHsn === "" && line.title === shippingTitle;
      const isGoods = !isShipping;
      const hsn = isShipping ? "9968" : rawHsn;
      if (isGoods && rawHsn === "") missingHsnCount++;

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

      const bucket = isGoods ? goods : cod;
      for (const t of [grand, bucket]) {
        t.qty = t.qty.plus(line.qty);
        t.totalValue = t.totalValue.plus(line.lineTotal);
        t.taxableValue = t.taxableValue.plus(line.taxableValue);
        t.igst = t.igst.plus(line.igst);
        t.cgst = t.cgst.plus(line.cgst);
        t.sgst = t.sgst.plus(line.sgst);
      }

      detail.push({
        order: orderName,
        date: orderDate,
        state,
        hsn,
        product: line.variantTitle
          ? `${line.title} (${line.variantTitle})`
          : line.title,
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
  }

  const sorted = [...groups.values()].sort((a, b) => {
    // Services (shipping/COD) last, then blank-HSN goods, then by HSN/rate/state.
    if (a.isService !== b.isService) return a.isService ? 1 : -1;
    if (a.hsn === "" && b.hsn !== "") return 1;
    if (b.hsn === "" && a.hsn !== "") return -1;
    if (a.hsn !== b.hsn) return a.hsn.localeCompare(b.hsn);
    if (a.rate !== b.rate) return d(a.rate).minus(d(b.rate)).toNumber();
    return a.state.localeCompare(b.state);
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
  rateCol: number
) {
  row.eachCell((cell) => {
    cell.border = BORDER as ExcelJS.Borders;
    cell.font = { size: 10 };
  });
  row.getCell(qtyCol).numFmt = QTY;
  row.getCell(rateCol).numFmt = "0";
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

  // ---- Sheet 2: Invoice Detail ----
  const wsd = wb.addWorksheet("Invoice Detail");
  const dwidths = [10, 12, 24, 12, 60, 6, 7, 14, 11, 11, 11, 20];
  wsd.columns = dwidths.map((w) => ({ width: w }));
  const D_MONEY = [8, 9, 10, 11, 12];
  const D_QTY = 6;
  const D_RATE = 7;

  styleHeader(
    wsd.addRow([
      "Order",
      "Order Date",
      "State (Place of Supply)",
      "HSN",
      "Product",
      "Qty",
      "Rate %",
      "Taxable Value",
      "CGST",
      "SGST",
      "IGST",
      "Line Total (incl. tax)",
    ])
  );
  wsd.views = [{ state: "frozen", ySplit: 1 }];

  for (const row of summary.detail) {
    const r = wsd.addRow([
      row.order,
      row.date,
      row.state,
      row.hsn,
      row.product,
      n(row.qty),
      n(row.rate),
      n(row.taxableValue),
      n(row.cgst),
      n(row.sgst),
      n(row.igst),
      n(row.lineTotal),
    ]);
    styleData(r, D_MONEY, D_QTY, D_RATE);
  }

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
