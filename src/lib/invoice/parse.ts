// Extract invoice fields from an uploaded PDF (text layer only — no OCR).
//
// Two sources are expected: PDFs printed by this tool's own Tally-style
// template (labelled "Taxable Amount" / "Total Tax" / "Grand Total", GSTINs on
// dedicated lines) and invoices from other software, handled with generic
// label heuristics. Everything is a best guess — the caller must show the
// result in a confirm dialog before anything is saved.
import { PDFParse } from "pdf-parse";
import path from "path";
import { pathToFileURL } from "url";
import {
  seller,
  HOME_STATE_GST_CODE,
  GST_STATE_CODES,
  GST_STATE_NAMES,
} from "./config";
import type { InvoiceLineSnapshot } from "../data/types";

// Next.js bundles pdfjs in a chunk where its dynamic worker import can't be
// resolved, so point it at the real file on disk before first use. The server
// always runs with the project root as cwd (next dev / next start); the ESM
// loader needs a file:// URL, not a bare Windows path.
let workerReady = false;
function ensurePdfWorker() {
  if (workerReady) return;
  PDFParse.setWorker(
    pathToFileURL(
      path.join(
        process.cwd(),
        "node_modules/pdf-parse/dist/pdf-parse/cjs/pdf.worker.mjs"
      )
    ).href
  );
  workerReady = true;
}

// One line of the item table in a Tally-style invoice — enough to put real
// product rows on the GSTR-1 detail sheet.
export interface ParsedItem {
  title: string;
  hsn: string;
  isService: boolean; // shipping/COD-style row: no qty, no unit price
  intra: boolean; // CGST+SGST columns printed (buyer in the seller's state)
  qty: number | null;
  rate: number | null; // GST rate %
  taxableValue: number | null;
  taxAmount: number | null; // the tax printed on the line (IGST or CGST+SGST)
  lineTotal: number | null; // tax-inclusive
}

// Freeze the parsed item table as ledger snapshot lines (InvoiceLineSnapshot).
// Each row prints its tax once — as IGST, or as a CGST+SGST pair when the row
// carried a second Rate/Amt pair (buyer in the seller's state).
export function parsedItemsToSnapshot(items: ParsedItem[]): InvoiceLineSnapshot[] {
  return items.map((it) => {
    const tax = it.taxAmount ?? 0;
    const half = Math.round((tax / 2) * 100) / 100;
    return {
      hsn: it.hsn,
      title: it.title,
      qty: it.qty ?? 0,
      rate: it.rate ?? 0,
      taxableValue: it.taxableValue ?? 0,
      cgst: it.intra ? half : 0,
      sgst: it.intra ? Math.round((tax - half) * 100) / 100 : 0,
      igst: it.intra ? 0 : tax,
      lineTotal: it.lineTotal ?? 0,
      service: it.isService,
    };
  });
}

export interface ParsedInvoice {
  invoiceDate: string; // YYYY-MM-DD, "" if not found
  customerName: string;
  gstin: string;
  stateCode: string; // key of GST_STATE_CODES, "" if unknown
  stateName: string;
  hsn: string; // whole-invoice HSN from the GST summary, "" if not readable
  taxableValue: number | null;
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  grandTotal: number | null;
  totalQty: number | null; // goods quantity from the item table's Total row
  items: ParsedItem[]; // item table lines, when the layout is readable
  originalInvoiceNo: string;
  missing: string[]; // human-readable list of fields that could not be read
}

const GSTIN_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b/g;

// ₹1,23,456.78 / 1,234.5 / 123 — the last number on a labelled line.
const AMOUNT_RE = /([\d,]+\.\d{1,2}|[\d,]+)/;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const pad2 = (n: number) => String(n).padStart(2, "0");

// Try every Indian date layout; returns YYYY-MM-DD or "".
export function parseIndianDate(raw: string): string {
  const s = raw.trim();
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const d = +m[1];
    const mo = +m[2];
    let y = +m[3];
    if (y < 100) y += 2000;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000)
      return `${y}-${pad2(mo)}-${pad2(d)}`;
  }
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{2,4})$/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    let y = +m[3];
    if (y < 100) y += 2000;
    const d = +m[1];
    if (mo !== undefined && d >= 1 && d <= 31 && y >= 2000)
      return `${y}-${pad2(mo + 1)}-${pad2(d)}`;
  }
  return "";
}

function parseAmount(raw: string): number | null {
  const m = raw.match(AMOUNT_RE);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// First labelled amount where label and value sit on the SAME line (or the
// value is a bare next line). The short separator cap keeps the match from
// jumping past a table header ("Taxable Value \n IGST Total … \n 1") to some
// unrelated digit far below.
function labelAmount(text: string, labelRe: RegExp): number | null {
  const re = new RegExp(
    `${labelRe.source}[ \\t:₹.]{0,8}([\\d,]+(?:\\.\\d{1,2})?)`,
    "gi"
  );
  let last: number | null = null;
  for (const m of text.matchAll(re)) last = parseAmount(m[1]);
  return last;
}

export async function parseInvoicePdf(buffer: Buffer): Promise<ParsedInvoice> {
  ensurePdfWorker();
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  await parser.destroy();
  const text = result.text || "";

  const missing: string[] = [];

  // --- Dates ---------------------------------------------------------------
  // Prefer the value right after a "Dated" label; else the first date anywhere.
  let invoiceDate = "";
  const datedM = text.match(/Dated[^A-Za-z0-9]{0,20}((?:\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})|(?:\d{1,2}[-\s][A-Za-z]{3,}[-\s]\d{2,4}))/);
  if (datedM) invoiceDate = parseIndianDate(datedM[1]);
  if (!invoiceDate) {
    for (const m of text.matchAll(/(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}[-\s][A-Za-z]{3,}[-\s]\d{2,4})/g)) {
      invoiceDate = parseIndianDate(m[1]);
      if (invoiceDate) break;
    }
  }
  if (!invoiceDate) missing.push("Invoice date");

  // --- GSTINs (buyer vs seller) --------------------------------------------
  // The buyer block starts at "Buyer"/"Bill to" and prints after the seller's;
  // a GSTIN there belongs to the buyer. An unregistered buyer prints none —
  // the only GSTIN on the page is then the seller's, which must NOT be
  // attributed to the buyer (it would also misplace the state).
  const buyerMarkerIdx = text.search(/buyer|bill(?:ed)?\s*to/i);
  const allGstins = [...text.matchAll(GSTIN_RE)].map((m) => m[1]);
  const afterBuyer = buyerMarkerIdx >= 0
    ? allGstins.filter((g) => text.indexOf(g) > buyerMarkerIdx)
    : allGstins;
  const candidates = afterBuyer.filter((g) => g !== seller.gstin);
  const gstin = candidates.length > 0 ? candidates[candidates.length - 1] : "";
  if (!gstin) missing.push("Buyer GSTIN");

  // State from the buyer GSTIN's 2-digit code; fall back to the buyer block's
  // "State Name : X, Code : NN" line — the last one on the page (the seller's
  // prints first). The numeric code beats the name: names differ between
  // softwares, the GST state number does not.
  const numToCode: Record<string, string> = {};
  for (const [code, num] of Object.entries(GST_STATE_CODES)) {
    if (!(num in numToCode)) numToCode[num] = code;
  }
  let stateCode = gstin ? numToCode[gstin.slice(0, 2)] || "" : "";
  if (!stateCode) {
    for (const sm of text.matchAll(
      /State\s*Name\s*[:\s]*[A-Za-z][A-Za-z &]*?,?\s*Code\s*[:\s]*(\d{2})/gi
    )) {
      stateCode = numToCode[sm[1]] || stateCode;
    }
    if (!stateCode) {
      // No code anywhere — fall back to matching the state name.
      let name = "";
      for (const sm of text.matchAll(/State\s*Name\s*[:\s]*([A-Za-z][A-Za-z &]+)/gi)) {
        name = sm[1].trim();
      }
      stateCode =
        Object.keys(GST_STATE_NAMES).find(
          (c) => GST_STATE_NAMES[c].toLowerCase() === name.toLowerCase()
        ) || "";
    }
  }
  const stateName = stateCode ? GST_STATE_NAMES[stateCode] || "" : "";

  // --- Whole-invoice HSN (best effort, from the GST summary table) ----------
  // Rows under the "HSN/SAC" column start with the code; if the invoice mixes
  // several codes the summary can't pick one, so leave it for the user.
  let hsn = "";
  const summaryIdx = text.search(/HSN\/SAC|HSN\s*Summary/i);
  if (summaryIdx >= 0) {
    const codes = new Set<string>();
    for (const l of text.slice(summaryIdx).split(/\r?\n/)) {
      const m = l.trim().match(/^(\d{4,8})\s+[\d,.]/);
      if (m) codes.add(m[1]);
    }
    if (codes.size === 1) hsn = [...codes][0];
  }

  // --- Buyer name -----------------------------------------------------------
  let customerName = "";
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const buyerIdx = lines.findIndex((l) => /buyer|bill(?:ed)?\s*to/i.test(l));
  if (buyerIdx >= 0) {
    for (const l of lines.slice(buyerIdx + 1)) {
      if (!l) continue;
      if (/GSTIN|State Name|E-?Mail|Phone|Consignee|Ship to|Mobile|Address/i.test(l)) break;
      customerName = l.replace(/^M\/s\.?\s*/i, "").trim();
      break;
    }
  }
  if (!customerName) missing.push("Customer name");

  // --- Amounts ---------------------------------------------------------------
  const taxableValue = labelAmount(text, /Taxable\s*(?:Amount|Value)/);
  const grandTotal = labelAmount(text, /Grand\s*Total/);
  let totalTax = labelAmount(text, /Total\s*Tax/);
  if (totalTax == null && taxableValue != null && grandTotal != null)
    totalTax = Math.round((grandTotal - taxableValue) * 100) / 100;

  // CGST/SGST vs IGST follows the place of supply: same state as the seller ->
  // split equally, else IGST only. Totals only — the ledger stores no lines.
  let cgst: number | null = null;
  let sgst: number | null = null;
  let igst: number | null = null;
  if (totalTax != null && totalTax > 0) {
    const intra =
      (gstin && gstin.slice(0, 2) === HOME_STATE_GST_CODE) ||
      (!gstin && stateCode === "RJ");
    if (intra) {
      cgst = Math.round((totalTax / 2) * 100) / 100;
      sgst = Math.round((totalTax - cgst) * 100) / 100;
    } else {
      igst = totalTax;
    }
  }
  if (taxableValue == null) missing.push("Taxable value");
  if (grandTotal == null && (taxableValue == null || totalTax == null))
    missing.push("Grand total");

  // --- Original invoice number (kept as a reference only) --------------------
  // In Tally-style layouts the "Dated" label sits on the same visual row as
  // "Invoice No." and lands next to it in the extracted text — skip it so the
  // capture lands on the number itself.
  const noM = text.match(
    /Invoice\s*No\.?\s*[:\-]?\s*(?:Dated?\s*[:\-]?\s*)?([A-Za-z0-9][A-Za-z0-9/\-_.]{0,30})/i
  );
  const originalInvoiceNo = noM ? noM[1] : "";

  // --- Total goods quantity ---------------------------------------------------
  // Tally's item table ends with a "Total <qty> <taxable> <tax> <incl>" row;
  // the qty counts goods lines only (shipping carries no qty). The GST
  // summary's own "Total <taxable> ..." row has no integer after the label, so
  // requiring an integer followed by a money figure keeps the two apart.
  let totalQty: number | null = null;
  const qtyM = text.match(
    /(?:^|\n)\s*Total\s+(\d{1,6})\s+[\d,]+(?:\.\d{1,2})?\s+[\d,]+(?:\.\d{1,2})?/i
  );
  if (qtyM) {
    const v = parseInt(qtyM[1], 10);
    if (Number.isFinite(v)) totalQty = v;
  }

  // --- Item table lines -------------------------------------------------------
  // Tally rows read "<sno> <hsn> <qty> <unit price> <taxable> <gst rate> <tax
  // amt> <line total> <title…>", with the title starting on the same visual
  // line and wrapping onto the next ones (often ending in a "Sizes: …" line).
  // Service rows (shipping etc.) drop the qty and unit price columns. The
  // optional third token before the HSN is an item code, present only on some
  // exports.
  const num2 = (s: string) => {
    const v = parseFloat(s.replace(/,/g, ""));
    return Number.isFinite(v) ? v : 0;
  };
  // Intra-state rows print a second Rate/Amt pair (CGST + SGST side by side)
  // before the line total — captured (groups 9/10) so the caller can split the
  // tax between CGST and SGST instead of booking it as IGST.
  const GOODS_ROW =
    /^(\d{1,3})[ \t]+(?:\S{1,24}[ \t]+)?(\d{4,8})[ \t]+([\d,]+(?:\.\d+)?)[ \t]+([\d,]+\.\d{2})[ \t]+(?:(\d{1,2}(?:\.\d+)?)%[ \t]+)?([\d,]+\.\d{2})[ \t]+(\d{1,2}(?:\.\d+)?)[ \t]+([\d,]+\.\d{2})(?:[ \t]+(\d{1,2}(?:\.\d+)?)[ \t]+([\d,]+\.\d{2}))?[ \t]+([\d,]+\.\d{2})[ \t]*(.*)$/;
  const SERVICE_ROW =
    /^(\d{1,3})[ \t]+(?:\S{1,24}[ \t]+)?(\d{4,8})[ \t]+([\d,]+\.\d{2})[ \t]+(\d{1,2}(?:\.\d+)?)[ \t]+([\d,]+\.\d{2})(?:[ \t]+(\d{1,2}(?:\.\d+)?)[ \t]+([\d,]+\.\d{2}))?[ \t]+([\d,]+\.\d{2})[ \t]*(.*)$/;
  // A title stops at the next item row, the table's Total row, or any page /
  // header fragment the extractor sprinkles between pages.
  const TITLE_STOP =
    /^(Total\b|Amount Chargeable|GST Summary|Continued|Page \d+ of \d+|--|Tax Invoice\b|S\.|No\.|Item Code|Price|Taxable|Value|IGST|Rate Amt|\( Incl GST\)|HSN|Qty|Unit|Delivery Note|Reference No|Buyer's Order|Dispatch|Terms of)/i;
  const ROW_START = /^\d{1,3}[ \t]+(?:\S{1,24}[ \t]+)?\d{4,8}[ \t]+[\d,]/;
  const raw = text.split(/\r?\n/);
  const items: ParsedItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    let m = raw[i].match(GOODS_ROW);
    let isService = false;
    if (!m) {
      m = raw[i].match(SERVICE_ROW);
      isService = true;
    }
    if (!m) continue;
    const titleParts = [m[m.length - 1].trim()];
    while (i + 1 < raw.length) {
      const nxt = raw[i + 1].trim();
      if (!nxt || TITLE_STOP.test(nxt) || ROW_START.test(nxt)) break;
      titleParts.push(nxt);
      i++;
      if (/^Sizes:/i.test(nxt)) break;
    }
    const title = titleParts
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (isService) {
      // Groups: 1 sno, 2 hsn, 3 taxable, 4 gst rate, 5 tax amt,
      // 6/7 second pair (intra only), 8 line total, 9 title.
      items.push({
        title,
        hsn: m[2],
        isService,
        intra: m[6] != null,
        qty: null,
        rate: num2(m[4]),
        taxableValue: num2(m[3]),
        // Intra-state rows print CGST and SGST side by side — the line's tax
        // is the sum of both amounts, not the first one alone.
        taxAmount: num2(m[5]) + num2(m[7] ?? "0"),
        lineTotal: num2(m[8]),
      });
    } else {
      // Groups: 1 sno, 2 hsn, 3 qty, 4 unit price, 5 disc % (optional),
      // 6 taxable, 7 gst rate, 8 tax amt, 9/10 second pair (intra only),
      // 11 line total, 12 title.
      items.push({
        title,
        hsn: m[2],
        isService,
        intra: m[9] != null,
        qty: num2(m[3]),
        rate: num2(m[7]),
        taxableValue: num2(m[6]),
        taxAmount: num2(m[8]) + num2(m[10] ?? "0"),
        lineTotal: num2(m[11]),
      });
    }
  }

  return {
    invoiceDate,
    customerName,
    gstin,
    stateCode,
    stateName,
    hsn,
    taxableValue,
    cgst,
    sgst,
    igst,
    grandTotal: grandTotal ?? (taxableValue != null && totalTax != null ? Math.round((taxableValue + totalTax) * 100) / 100 : null),
    totalQty,
    items,
    originalInvoiceNo,
    missing,
  };
}