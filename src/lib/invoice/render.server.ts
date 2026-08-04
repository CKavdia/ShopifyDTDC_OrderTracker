// Builds the invoice HTML from the computed model and renders it to PDF.
// Server-only (drives Chromium via Puppeteer). Import only from Node runtime.
//
// The layout reproduces the TallyPrime "Tax Invoice" print format: a single
// hairline-ruled box containing the party blocks, a document-meta grid, the
// items table with its ledger rows (GST, round off), the HSN/tax summary, and
// the declaration/signature footer. See ./template.ts for the measurements.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import puppeteer, { type Browser } from "puppeteer";
import Decimal from "decimal.js";
import { seller, GST_STATE_CODES } from "./config";
import { SHELL, CSS } from "./template";
import { rupeesInWords, type InvoiceLine, type InvoiceModel } from "./calc";
import type { InvoiceAddress } from "../shopify";

export interface InvoiceMeta {
  invoiceNo: string;
  invoiceDate: Date;
  // Set only by manually-typed invoices (see lib/invoice/manual.ts). Shopify
  // orders leave these undefined.
  buyerGstin?: string;
  reference?: string;
  notes?: string;
}

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// Plain Indian-grouped money, no symbol — Tally prints ₹ only on the grand total.
const num = (d: Decimal): string =>
  d.toNumber().toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// Tally shows a negative ledger amount as "(-)0.24" rather than "-0.24".
const signed = (d: Decimal): string =>
  d.isNegative() ? `(-)${num(d.abs())}` : num(d);

const rupee = (d: Decimal): string => `₹ ${num(d)}`;

const qtyText = (d: Decimal, unit: string): string => {
  const n = d.toNumber().toLocaleString("en-IN", { maximumFractionDigits: 3 });
  return unit ? `${n} ${unit}` : n;
};

// Tally's date style: 10-Oct-25.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function tallyDate(iso: string | Date | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  return `${dd}-${MONTHS[d.getMonth()]}-${String(d.getFullYear()).slice(2)}`;
}

// A service line (blank unit) with no HSN is the synthetic shipping/COD charge,
// which is supplied under SAC 9968 — the same code the GSTR-1 export assigns.
// Kept in the renderer so gstr1.server.ts can still detect it by a blank HSN.
const displayHsn = (l: InvoiceLine): string => l.hsn || (l.unit === "" ? "9968" : "");

// PAN is characters 3-12 of a GSTIN (08FELPM3724K1Z1 -> FELPM3724K).
function sellerPan(): string {
  if (seller.pan) return seller.pan;
  const g = (seller.gstin || "").toUpperCase();
  return g.length >= 12 ? g.slice(2, 12) : "";
}

// --- Party blocks ---------------------------------------------------------

function kv(label: string, value: string, basis = "78px"): string {
  return `<div class="kv"><span class="k" style="flex-basis:${basis}">${esc(label)}</span><span class="v">: ${esc(value)}</span></div>`;
}

function sellerBlock(): string {
  const a = seller.address;
  const lines = [
    a.line1,
    a.line2,
    [a.city, a.pincode].filter(Boolean).join(", "),
    seller.phone ? `TEL NO.${seller.phone}` : "",
    `GSTIN/UIN: ${seller.gstin}`,
    `State Name : ${a.state}, Code : ${a.stateCode}`,
    seller.email ? `E-Mail : ${seller.email}` : "",
  ].filter(Boolean);
  return `<div class="blk">
    <p class="party-name">${esc(seller.companyName || seller.legalName)}</p>
    ${lines.map((l) => `<p>${esc(l)}</p>`).join("")}
  </div>`;
}

// Consignee / Buyer block. `gstin` is printed only when known — Tally omits the
// line entirely for unregistered (B2C) buyers.
function partyBlock(label: string, a: InvoiceAddress | null, gstin?: string): string {
  if (!a) {
    return `<div class="blk"><p class="mini">${esc(label)}</p><p class="party-name">&nbsp;</p></div>`;
  }
  const name = a.name || a.company || "";
  const street = [a.address1, a.address2, a.city, a.province, a.zip]
    .filter(Boolean)
    .join(", ");
  const code = GST_STATE_CODES[a.provinceCode || ""] || "";
  return `<div class="blk">
    <p class="mini">${esc(label)}</p>
    <p class="party-name">${esc(name)}</p>
    ${street ? `<p>${esc(street)}</p>` : ""}
    ${gstin ? kv("GSTIN/UIN", gstin) : ""}
    ${a.province ? kv("State Name", `${a.province}${code ? `, Code : ${code}` : ""}`) : ""}
  </div>`;
}

// --- Document meta grid ---------------------------------------------------

function metaCell(label: string, value: string): string {
  return `<td><p class="mini">${esc(label)}</p><p class="val">${esc(value) || "&nbsp;"}</p></td>`;
}

function metaGrid(model: InvoiceModel, meta: InvoiceMeta): string {
  const o = model.order;
  const paid = (o.displayFinancialStatus || "").toUpperCase() === "PAID";
  const ship = o.shippingAddress || o.billingAddress;
  const rows: Array<[string, string, string, string]> = [
    ["Invoice No.", meta.invoiceNo, "Dated", tallyDate(meta.invoiceDate)],
    ["Delivery Note", "", "Mode/Terms of Payment", paid ? "Paid" : ""],
    ["Reference No. & Date.", meta.reference || "", "Other References", ""],
    // A Shopify invoice carries the store order as the buyer's order reference.
    ["Buyer's Order No.", o.name || "", "Dated", o.name ? tallyDate(o.createdAt) : ""],
    ["Dispatch Doc No.", "", "Delivery Note Date", ""],
    ["Dispatched through", "", "Destination", ship?.city || ""],
  ];
  return `<table class="meta"><tbody>
    ${rows.map(([l1, v1, l2, v2]) => `<tr>${metaCell(l1, v1)}${metaCell(l2, v2)}</tr>`).join("")}
    <tr><td colspan="2"><p class="mini">Terms of Delivery</p><p class="val">${esc(meta.notes || "") || "&nbsp;"}</p></td></tr>
  </tbody></table>`;
}

// --- Items table ----------------------------------------------------------

// One ledger row under the items (GST per rate, discount, round off) — the
// description is right-aligned bold italic, exactly as Tally prints it.
function ledgerRow(label: string, rate: string, per: string, amount: string): string {
  return `<tr>
    <td></td>
    <td class="ledger">${esc(label)}</td>
    <td></td>
    <td></td>
    <td class="r">${esc(rate)}</td>
    <td class="c">${esc(per)}</td>
    <td class="r b">${esc(amount)}</td>
  </tr>`;
}

function itemsTable(model: InvoiceModel): string {
  const { intraState, lines, totals: t } = model;
  const zero = new Decimal(0);

  const itemRows = lines
    .map((l, i) => {
      const sub = [l.variantTitle, l.sku ? `SKU: ${l.sku}` : ""]
        .filter(Boolean)
        .join(" · ");
      return `<tr>
        <td class="c">${i + 1}</td>
        <td class="desc">${esc(l.title)}${sub ? `<p class="mini sub-note">${esc(sub)}</p>` : ""}</td>
        <td>${esc(displayHsn(l))}</td>
        <td class="r b">${esc(qtyText(l.qty, l.unit))}</td>
        <td class="r">${num(l.unitPricePreTax)}</td>
        <td class="c">${esc(l.unit)}</td>
        <td class="r b">${num(l.grossPreTax)}</td>
      </tr>`;
    })
    .join("");

  const ledger: string[] = [];
  if (t.discount.greaterThan(0)) {
    ledger.push(ledgerRow("LESS : DISCOUNT", "", "", `(-)${num(t.discount)}`));
  }

  // One GST ledger row per distinct rate, ascending — a mixed-rate invoice gets
  // an OUTPUT-CGST-x% row for each, the way Tally splits them by ledger.
  const byRate = new Map<string, { rate: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal }>();
  for (const l of lines) {
    const key = l.rate.toString();
    const g = byRate.get(key) || { rate: l.rate, cgst: zero, sgst: zero, igst: zero };
    byRate.set(key, {
      rate: l.rate,
      cgst: g.cgst.plus(l.cgst),
      sgst: g.sgst.plus(l.sgst),
      igst: g.igst.plus(l.igst),
    });
  }
  const rateGroups = [...byRate.values()].sort((a, b) => a.rate.comparedTo(b.rate));
  for (const g of rateGroups) {
    const half = g.rate.dividedBy(2);
    if (intraState) {
      if (g.cgst.greaterThan(0))
        ledger.push(ledgerRow(`OUTPUT-CGST-${half}%`, num(half), "%", num(g.cgst)));
      if (g.sgst.greaterThan(0))
        ledger.push(ledgerRow(`OUTPUT-SGST-${half}%`, num(half), "%", num(g.sgst)));
    } else if (g.igst.greaterThan(0)) {
      ledger.push(ledgerRow(`OUTPUT-IGST-${g.rate}%`, num(g.rate), "%", num(g.igst)));
    }
  }
  if (!t.roundOff.isZero()) {
    ledger.push(ledgerRow("ROUND OFF", "", "", signed(t.roundOff)));
  }

  // Total pieces counts goods only; a service line carries a blank unit.
  const unitTotals = new Map<string, Decimal>();
  for (const l of lines) {
    if (!l.unit) continue;
    unitTotals.set(l.unit, (unitTotals.get(l.unit) || zero).plus(l.qty));
  }
  const totalQty = [...unitTotals.entries()]
    .map(([unit, q]) => qtyText(q, unit))
    .join(", ");

  // Tally holds the item area open so the Total row sits low on the page. On a
  // long invoice the rows already fill it, so the spacer shrinks away rather
  // than pushing the totals onto another sheet.
  const rowCount = lines.length + ledger.length + 1;
  const fillerPx = Math.max(0, 150 - Math.max(0, rowCount - 10) * 22);
  const filler =
    fillerPx > 0
      ? `<tr><td style="height:${fillerPx}px"></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`
      : "";

  return `<table class="items">
    <thead>
      <tr>
        <th class="c-sl h-sl">Sl<br />No.</th>
        <th class="c-desc">Description of Goods</th>
        <th class="c-hsn">HSN/SAC</th>
        <th class="c-qty">Quantity</th>
        <th class="c-rate">Rate</th>
        <th class="c-per">per</th>
        <th class="c-amt">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
      <tr class="sub">
        <td></td><td></td><td></td><td></td><td></td><td></td>
        <td class="r amt">${num(t.grossPreTax)}</td>
      </tr>
      ${ledger.join("")}
      ${filler}
    </tbody>
    <tfoot>
      <tr>
        <td></td>
        <td class="r total-label">Total</td>
        <td></td>
        <td class="r">${esc(totalQty)}</td>
        <td></td>
        <td></td>
        <td class="r grand">${rupee(t.grandTotal)}</td>
      </tr>
    </tfoot>
  </table>`;
}

// --- Amount in words ------------------------------------------------------

function wordsBlock(model: InvoiceModel): string {
  return `<table class="words"><tbody>
    <tr>
      <td>Amount Chargeable (in words)</td>
      <td class="eoe">E. &amp; O.E</td>
    </tr>
    <tr>
      <td colspan="2" class="b words-amt">${esc(model.amountInWords)}</td>
    </tr>
  </tbody></table>`;
}

// --- HSN / tax summary ----------------------------------------------------

interface HsnRow {
  hsn: string;
  rate: Decimal;
  taxable: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
}

function hsnTable(model: InvoiceModel): string {
  const { intraState, lines } = model;
  const zero = new Decimal(0);

  const groups = new Map<string, HsnRow>();
  for (const l of lines) {
    const hsn = displayHsn(l);
    const key = `${hsn}||${l.rate}`;
    const g =
      groups.get(key) ||
      { hsn, rate: l.rate, taxable: zero, cgst: zero, sgst: zero, igst: zero };
    g.taxable = g.taxable.plus(l.taxableValue);
    g.cgst = g.cgst.plus(l.cgst);
    g.sgst = g.sgst.plus(l.sgst);
    g.igst = g.igst.plus(l.igst);
    groups.set(key, g);
  }
  const rows = [...groups.values()].sort((a, b) => a.hsn.localeCompare(b.hsn));

  const half = (r: Decimal) => `${num(r.dividedBy(2))}%`;
  const sum = (pick: (r: HsnRow) => Decimal) =>
    rows.reduce((acc, r) => acc.plus(pick(r)), zero);

  const totTaxable = sum((r) => r.taxable);
  const totCgst = sum((r) => r.cgst);
  const totSgst = sum((r) => r.sgst);
  const totIgst = sum((r) => r.igst);

  if (intraState) {
    return `<table class="hsn">
      <thead>
        <tr>
          <th class="h-hsn" rowspan="2">HSN/SAC</th>
          <th class="h-tax" rowspan="2">Taxable<br />Value</th>
          <th class="grp" colspan="2">CGST</th>
          <th class="grp" colspan="2">SGST/UTGST</th>
          <th class="h-tot" rowspan="2">Total<br />Tax Amount</th>
        </tr>
        <tr>
          <th class="h-rate">Rate</th>
          <th class="h-amt">Amount</th>
          <th class="h-rate2">Rate</th>
          <th class="h-amt2">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr>
          <td class="code">${esc(r.hsn)}</td>
          <td>${num(r.taxable)}</td>
          <td>${half(r.rate)}</td>
          <td>${num(r.cgst)}</td>
          <td>${half(r.rate)}</td>
          <td>${num(r.sgst)}</td>
          <td>${num(r.cgst.plus(r.sgst))}</td>
        </tr>`
          )
          .join("")}
      </tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td>${num(totTaxable)}</td>
          <td></td>
          <td>${num(totCgst)}</td>
          <td></td>
          <td>${num(totSgst)}</td>
          <td>${num(totCgst.plus(totSgst))}</td>
        </tr>
      </tfoot>
    </table>`;
  }

  return `<table class="hsn">
    <thead>
      <tr>
        <th class="h-hsn" rowspan="2">HSN/SAC</th>
        <th class="h-tax" rowspan="2">Taxable<br />Value</th>
        <th class="grp" colspan="2">IGST</th>
        <th class="h-tot" rowspan="2">Total<br />Tax Amount</th>
      </tr>
      <tr>
        <th class="h-rate">Rate</th>
        <th class="h-amt">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (r) => `<tr>
        <td class="code">${esc(r.hsn)}</td>
        <td>${num(r.taxable)}</td>
        <td>${num(r.rate)}%</td>
        <td>${num(r.igst)}</td>
        <td>${num(r.igst)}</td>
      </tr>`
        )
        .join("")}
    </tbody>
    <tfoot>
      <tr>
        <td>Total</td>
        <td>${num(totTaxable)}</td>
        <td></td>
        <td>${num(totIgst)}</td>
        <td>${num(totIgst)}</td>
      </tr>
    </tfoot>
  </table>`;
}

// --- Footer: tax in words, PAN, declaration, signature --------------------

function footBlock(model: InvoiceModel): string {
  const t = model.totals;
  const totalTax = t.cgst.plus(t.sgst).plus(t.igst);
  // Tally lower-cases "paise" here but not in the amount-chargeable line.
  const taxWords = rupeesInWords(totalTax).replace(/ Paise Only$/, " paise Only");

  const signature = seller.signaturePath
    ? `<img class="signature-img" src="${assetDataUri(seller.signaturePath)}" alt="" />`
    : "";

  // "This is a Computer Generated Invoice" is printed under the box instead.
  const extraTerms = seller.terms.filter((x) => !/computer[- ]generated/i.test(x));

  return `<table class="foot"><tbody>
    <tr>
      <td colspan="2" class="pad">
        ${kvBold("Tax Amount (in words)", esc(taxWords), true)}
      </td>
    </tr>
    <tr class="rule">
      <td colspan="2" class="pad">
        ${kvBold("Company's PAN", esc(sellerPan()), false)}
      </td>
    </tr>
    <tr>
      <td class="decl">
        <p class="decl-title">Declaration</p>
        <p>${esc(seller.declaration)}</p>
        ${extraTerms.map((x) => `<p>${esc(x)}</p>`).join("")}
      </td>
      <td class="sign">
        <p class="b">for ${esc(seller.companyName || seller.legalName)}</p>
        <div class="sign-space">${signature}</div>
        <p>Authorised Signatory</p>
      </td>
    </tr>
  </tbody></table>`;
}

// Label : bold value, with the colons of the two footer lines aligned.
function kvBold(label: string, escapedValue: string, large: boolean): string {
  return `<div class="kv"><span class="k foot-k">${esc(label)}</span><span class="v">: <span class="b${
    large ? " words-amt" : ""
  }">${escapedValue}</span></span></div>`;
}

// Inline an asset (absolute or project-relative path) as a base64 data URI.
// Data URIs avoid file:// sub-resource loads, which Chromium blocks when the
// page is rendered via setContent (an about:blank origin). Cached by path +
// mtime so a merged PDF reads each asset once, yet a replaced signature file is
// picked up without a server restart.
const assetCache = new Map<string, { mtimeMs: number; uri: string }>();
function assetDataUri(p: string): string {
  const abs = path.resolve(process.cwd(), p);
  const mtimeMs = statSync(abs).mtimeMs;
  const cached = assetCache.get(abs);
  if (cached && cached.mtimeMs === mtimeMs) return cached.uri;
  const ext = path.extname(abs).slice(1).toLowerCase();
  const mime =
    ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
  const uri = `data:${mime};base64,${readFileSync(abs).toString("base64")}`;
  assetCache.set(abs, { mtimeMs, uri });
  return uri;
}

function buildBody(model: InvoiceModel, meta: InvoiceMeta): string {
  const o = model.order;
  return `
  <div class="doc-title">Tax Invoice</div>
  <table class="frame"><tbody>
    <tr>
      <td class="col-parties">
        ${sellerBlock()}
        ${partyBlock("Consignee (Ship to)", o.shippingAddress || o.billingAddress, meta.buyerGstin)}
        ${partyBlock("Buyer (Bill to)", o.billingAddress || o.shippingAddress, meta.buyerGstin)}
      </td>
      <td class="col-meta">${metaGrid(model, meta)}</td>
    </tr>
  </tbody></table>
  ${itemsTable(model)}
  ${wordsBlock(model)}
  ${hsnTable(model)}
  ${footBlock(model)}
  <div class="doc-foot">This is a Computer Generated Invoice</div>`;
}

export function buildInvoiceHtml(model: InvoiceModel, meta: InvoiceMeta): string {
  const body = buildBody(model, meta);
  // Function replacers: a `$&`-style sequence inside a product name or the CSS
  // must not be interpreted as a replacement reference.
  return SHELL.replace("{{TITLE}}", () => esc(`${meta.invoiceNo} — ${seller.legalName}`))
    .replace("{{CSS}}", () => CSS)
    .replace("{{BODY}}", () => body);
}

// Reuse a single browser across requests (Puppeteer launch is slow).
let browserPromise: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browserPromise;
}

// Render the model to a PDF (Uint8Array). `meta` = { invoiceNo, invoiceDate }.
export async function renderInvoicePdf(
  model: InvoiceModel,
  meta: InvoiceMeta
): Promise<Uint8Array> {
  return renderHtmlToPdf(buildInvoiceHtml(model, meta));
}

export interface MergedInvoiceItem {
  model: InvoiceModel;
  meta: InvoiceMeta;
}

// One document containing every invoice, one per A4 page (page-break between).
export function buildMergedInvoicesHtml(items: MergedInvoiceItem[]): string {
  const pages = items
    .map(({ model, meta }) => `<div class="invoice-page">${buildBody(model, meta)}</div>`)
    .join("\n");
  const title = `Invoices (${items.length}) — ${seller.legalName}`;
  const extraCss =
    ".invoice-page { page-break-after: always; } .invoice-page:last-child { page-break-after: auto; }";
  return SHELL.replace("{{TITLE}}", () => esc(title))
    .replace("{{CSS}}", () => CSS + extraCss)
    .replace("{{BODY}}", () => pages);
}

// Render many invoices into a single merged PDF (one Puppeteer pass).
export async function renderMergedInvoicesPdf(
  items: MergedInvoiceItem[]
): Promise<Uint8Array> {
  return renderHtmlToPdf(buildMergedInvoicesHtml(items));
}

async function renderHtmlToPdf(html: string): Promise<Uint8Array> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0" });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      // The single source of truth for the paper margin — template.ts must not
      // declare one in @page or it would win over this.
      margin: { top: "10mm", bottom: "10mm", left: "13mm", right: "13mm" },
    });
  } finally {
    await page.close();
  }
}
