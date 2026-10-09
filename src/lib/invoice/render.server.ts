// Builds the invoice HTML from the computed model and renders it to PDF.
// Server-only (drives Chromium via Puppeteer). Import only from Node runtime.
//
// The layout is a port of the CollectionPdfGeneratorTool's invoice_pdf.py: a
// Tally-style tax invoice with a party/meta header box, a goods table that
// carries its CGST/SGST (or IGST) rate/amount columns on every product line,
// a GST summary box that always shows all three regimes beside a running
// amounts box, and a declaration/signatory footer. All money math stays in
// calc.ts / manual.ts — this file only formats what those modules computed.
//
// Pagination mirrors invoice_pdf.py's _split_pages: the natural-flow document
// is first measured in the browser, then re-emitted as fixed-height .sheet
// divs (one per A4 page) whose goods bands close at the page floor behind a
// "Continued ..." row, with the boxed Total row and the totals block reserved
// onto the last page. Measuring and drawing share the same builders, so the
// two passes cannot disagree the way the two ReportLab paths once could.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";
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

// Plain Indian-grouped money, no symbol — the ₹ mark prints only on the grand
// total, as Tally does.
const num = (d: Decimal): string =>
  d.toNumber().toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const num0 = (d: Decimal): string =>
  d.toNumber().toLocaleString("en-IN", { maximumFractionDigits: 0 });

// IGST rate cells print one decimal ("5.0"), CGST halves two ("2.50"),
// following invoice_pdf.py's num(..., 1) / num(..., 2) calls.
const num1 = (d: Decimal): string =>
  d.toNumber().toLocaleString("en-IN", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

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
const displayHsn = (l: InvoiceLine): string => l.hsn || (l.unit === "" ? "9968" : "");

// --- Assets ----------------------------------------------------------------

// Inline an asset (absolute or project-relative path) as a base64 data URI.
// Data URIs avoid file:// sub-resource loads, which Chromium blocks when the
// page is rendered via setContent. Cached by path + mtime so a replaced file
// is picked up without a server restart.
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

// Product thumbnails come from Shopify's CDN, so they are fetched once
// server-side and inlined as data URIs: the two render passes must see
// identical content, and network flakiness must never blank a column
// mid-document. Failures degrade to an empty thumbnail cell.
const imgCache = new Map<string, string>();
async function inlineImage(url: string): Promise<string> {
  const hit = imgCache.get(url);
  if (hit) return hit;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const mime = res.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    const uri = `data:${mime};base64,${buf.toString("base64")}`;
    imgCache.set(url, uri);
    return uri;
  } catch {
    return "";
  }
}

function logoUri(): string {
  if (!seller.logoPath) return "";
  try {
    return assetDataUri(seller.logoPath);
  } catch {
    return "";
  }
}

// --- Party blocks ----------------------------------------------------------

function kv(label: string, value: string): string {
  return `<div class="kv"><span class="k">${esc(label)}</span><span class="v">: ${esc(value)}</span></div>`;
}

function sellerBlockHtml(withLogo: boolean): string {
  const a = seller.address;
  const lines = [
    a.line1,
    a.line2,
    [a.city, a.pincode].filter(Boolean).join(", "),
  ].filter(Boolean);
  return `<div class="blk">
    ${withLogo ? `<img class="logo" src="${logoUri()}" alt="" />` : ""}
    <p class="party-name${withLogo ? " demote" : ""}">${esc(seller.companyName || seller.legalName)}</p>
    ${lines.map((l) => `<p>${esc(l)}</p>`).join("")}
    ${seller.phone ? `<p>TEL NO.${esc(seller.phone)}</p>` : ""}
    <p>GSTIN/UIN: ${esc(seller.gstin)}</p>
    <p>State Name : ${esc(a.state)}, Code : ${esc(a.stateCode)}</p>
    ${seller.email ? `<p>E-Mail : ${esc(seller.email)}</p>` : ""}
  </div>`;
}

// Consignee / Buyer block. `gstin` is printed only when known — Tally omits the
// line entirely for unregistered (B2C) buyers.
function buyerBlockHtml(label: string, a: InvoiceAddress | null, gstin?: string): string {
  if (!a) {
    return `<div class="blk"><p class="blk-label">${esc(label)}</p><p class="party-name">&nbsp;</p></div>`;
  }
  const name = a.name || a.company || "";
  const lines = [a.address1, a.address2, [a.city, a.province, a.zip].filter(Boolean).join(", ")]
    .map((l) => (l || "").trim())
    .filter(Boolean);
  const code = GST_STATE_CODES[a.provinceCode || ""] || "";
  return `<div class="blk">
    <p class="blk-label">${esc(label)}</p>
    <p class="party-name">${esc(name)}</p>
    ${lines.map((l) => `<p>${esc(l)}</p>`).join("")}
    ${gstin ? kv("GSTIN/UIN", gstin) : ""}
    ${a.province ? kv("State Name", `${a.province}${code ? `, Code : ${code}` : ""}`) : ""}
  </div>`;
}

// Comparable identity of an address, for deciding whether one party block can
// do both jobs. Compared by content: a delivery address typed out identically
// by hand must merge just like the "same as billing" case.
function partyKey(a: InvoiceAddress | null | undefined): string {
  if (!a) return "|";
  return [a.name, a.company, a.address1, a.address2, a.city, a.province, a.provinceCode, a.zip]
    .map((x) => (x || "").trim().toLowerCase())
    .join("|");
}

// --- Document meta grid ----------------------------------------------------

function metaGridHtml(model: InvoiceModel, meta: InvoiceMeta): string {
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
  const cell = (label: string, value: string) =>
    `<td><p class="lbl">${esc(label)}</p><p class="val">${esc(value) || "&nbsp;"}</p></td>`;
  return `<table class="meta"><tbody>
    ${rows
      .map(([l1, v1, l2, v2]) => `<tr>${cell(l1, v1)}${cell(l2, v2)}</tr>`)
      .join("")}
    <tr><td colspan="2"><p class="lbl">Terms of Delivery</p><p class="val">${esc(meta.notes || "") || "&nbsp;"}</p></td></tr>
  </tbody></table>`;
}

function frameHtml(model: InvoiceModel, meta: InvoiceMeta, withLogo: boolean): string {
  const o = model.order;
  const ship = o.shippingAddress || o.billingAddress;
  const bill = o.billingAddress || o.shippingAddress;
  // One address doing both jobs prints once — worth the height that decides
  // whether an invoice needs a second page. Distinct addresses stay separate
  // on purpose: Rule 46 wants the place of delivery shown in its own right.
  const parties =
    sellerBlockHtml(withLogo) +
    (partyKey(ship) === partyKey(bill)
      ? buyerBlockHtml("Buyer (Bill to) & Consignee (Ship to)", ship, meta.buyerGstin)
      : buyerBlockHtml("Consignee (Ship to)", ship, meta.buyerGstin) +
        buyerBlockHtml("Buyer (Bill to)", bill, meta.buyerGstin));
  return `<div class="head"><div class="doc-title">Tax Invoice</div><table class="frame"><tbody><tr><td class="col-parties">${parties}</td><td class="col-meta">${metaGridHtml(
    model,
    meta
  )}</td></tr></tbody></table></div>`;
}

// --- Goods table columns ---------------------------------------------------
// Widths carried over from invoice_pdf.py's _goods_table (in points of that
// module's 539.28pt content width), emitted as percentages. The Description
// column absorbs the remainder — the only column that can give up space
// gracefully, because it wraps.

interface GoodsCols {
  pct: string[];
  count: number;
  thumb: boolean;
  disc: boolean;
  intra: boolean;
  descIndex: number;
  qtyIndex: number;
  taxableIndex: number;
}

const SRC_CONTENT_PT = 539.28;
const pct = (pt: number): string => `${((pt / SRC_CONTENT_PT) * 100).toFixed(3)}%`;

function goodsCols(showImages: boolean, intra: boolean, disc: boolean): GoodsCols {
  const lead = showImages ? [26, 18] : [18];
  // HSN, Qty, Unit Price; with a discount the Disc and Net Rate columns ride
  // between Unit Price and Taxable Value, and every ruled column gives up a
  // measured few points to pay for them.
  const tail = disc
    ? [42, 26, 40, 36, 40, 44].concat(intra ? [22, 38, 22, 38] : [26, 44])
    : [44, 26, 40, 46].concat(intra ? [24, 40, 24, 40] : [28, 46]);
  tail.push(50); // Total ( Incl GST )
  const descPt = SRC_CONTENT_PT - lead.reduce((a, b) => a + b, 0) - tail.reduce((a, b) => a + b, 0);
  const pts = [...lead, descPt, ...tail];
  const descIndex = lead.length;
  return {
    pct: pts.map(pct),
    count: pts.length,
    thumb: showImages,
    disc,
    intra,
    descIndex,
    qtyIndex: descIndex + 2,
    taxableIndex: descIndex + 4 + (disc ? 2 : 0),
  };
}

function theadHtml(cols: GoodsCols): string {
  const lead = cols.thumb ? [`<th rowspan="2" class="span2"></th>`] : [];
  const top = [
    ...lead,
    `<th rowspan="2" class="span2 lft">S.<br />No.</th>`,
    `<th rowspan="2" class="span2">Item Code</th>`,
    `<th rowspan="2" class="span2">HSN</th>`,
    `<th rowspan="2" class="span2">Qty</th>`,
    `<th rowspan="2" class="span2">Unit Price</th>`,
  ];
  if (cols.disc) {
    // The label carries a unit, so it is split across two lines — a mid-token
    // break would print "(Rs" over ")".
    top.push(`<th rowspan="2" class="span2">Disc<br />(Rs.)</th>`);
    top.push(`<th rowspan="2" class="span2">Net Rate</th>`);
  }
  top.push(`<th rowspan="2" class="span2">Taxable Value</th>`);
  if (cols.intra) {
    top.push(`<th colspan="2" class="grp">CGST</th>`);
    top.push(`<th colspan="2" class="grp">SGST</th>`);
  } else {
    top.push(`<th colspan="2" class="grp">IGST</th>`);
  }
  top.push(`<th rowspan="2" class="span2">Total<br />( Incl GST )</th>`);

  const pairs = cols.intra ? 2 : 1;
  const bottomCells: string[] = [];
  for (let i = 0; i < pairs; i++) {
    bottomCells.push(`<th>Rate</th>`, `<th>Amt</th>`);
  }
  return `<thead><tr>${top.join("")}</tr><tr>${bottomCells.join("")}</tr></thead>`;
}

// One product row. The variant title is an indented sub-line under the bold
// description, matching invoice_pdf.py's "Sizes: ..." treatment.
function lineRowHtml(
  cols: GoodsCols,
  l: InvoiceLine,
  sl: number,
  imgUri: string
): string {
  const charge = l.unit === "";
  const cells: string[] = [];
  if (cols.thumb) {
    cells.push(`<td>${imgUri ? `<img class="thumb" src="${imgUri}" alt="" />` : ""}</td>`);
  }
  cells.push(`<td class="ctr">${sl}</td>`);
  cells.push(
    `<td><p class="desc-name">${esc(l.title)}</p>${
      l.variantTitle ? `<p class="desc-sub">${esc(l.variantTitle)}</p>` : ""
    }</td>`
  );
  cells.push(`<td class="ctr">${esc(displayHsn(l))}</td>`);
  cells.push(`<td class="rgt b">${charge ? "" : num0(l.qty)}</td>`);
  // Unit Price is the undiscounted rate; Taxable Value is net.
  cells.push(`<td class="rgt">${charge ? "" : num(l.unitPricePreTax)}</td>`);
  if (cols.disc) {
    // The Disc column prints rupees per piece (discount ÷ qty); freight is
    // not discounted, so its cell stays empty.
    const per = !charge && l.qty.greaterThan(0) ? l.discount.dividedBy(l.qty) : null;
    cells.push(`<td class="rgt">${per && per.greaterThan(0) ? num(per) : ""}</td>`);
    const netRate = charge
      ? null
      : l.qty.isZero()
        ? l.taxableValue
        : l.taxableValue.dividedBy(l.qty);
    cells.push(`<td class="rgt b">${netRate ? num(netRate) : ""}</td>`);
  }
  cells.push(`<td class="rgt b">${num(l.taxableValue)}</td>`);
  // These per-line figures are what the GST summary is summed from, so the
  // columns tie to the totals by construction rather than by luck.
  if (cols.intra) {
    const half = num(l.rate.dividedBy(2));
    cells.push(
      `<td class="rgt">${half}</td><td class="rgt">${num(l.cgst)}</td>` +
        `<td class="rgt">${half}</td><td class="rgt">${num(l.sgst)}</td>`
    );
  } else {
    cells.push(`<td class="rgt">${num1(l.rate)}</td><td class="rgt">${num(l.igst)}</td>`);
  }
  cells.push(`<td class="rgt b">${num(l.lineTotal)}</td>`);
  return `<tr class="item-row">${cells.join("")}</tr>`;
}

function contRowHtml(cols: GoodsCols): string {
  return `<tr class="cont-row"><td colspan="${cols.taxableIndex}"></td><td colspan="${cols.count - cols.taxableIndex}">Continued ...</td></tr>`;
}

function fillerRowHtml(cols: GoodsCols, heightPx: number): string {
  if (heightPx <= 0) return "";
  return `<tr class="filler"><td style="height:${heightPx}px"></td>${"<td></td>".repeat(cols.count - 1)}</tr>`;
}

function itemsTableHtml(
  cols: GoodsCols,
  rowsHtml: string[],
  fillerPx: number,
  tailHtml: string
): string {
  return `<table class="items"><colgroup>${cols.pct
    .map((w) => `<col style="width:${w}" />`)
    .join("")}</colgroup>${theadHtml(cols)}<tbody>${rowsHtml.join(
    ""
  )}${fillerRowHtml(cols, fillerPx)}${tailHtml}</tbody></table>`;
}

function totalRowHtml(model: InvoiceModel, cols: GoodsCols): string {
  const t = model.totals;
  // Total pieces counts goods only; a service line carries a blank unit.
  const goodsQty = model.lines.reduce(
    (acc, l) => (l.unit === "" ? acc : acc.plus(l.qty)),
    new Decimal(0)
  );
  const cells: string[] = [];
  cells.push(`<td class="rgt" colspan="${cols.qtyIndex}">Total</td>`);
  cells.push(`<td class="rgt">${num0(goodsQty)}</td>`);
  cells.push(`<td></td>`); // Unit Price
  if (cols.disc) cells.push(`<td></td><td></td>`); // Disc, Net Rate
  cells.push(`<td class="rgt">${num(t.taxableValue)}</td>`);
  if (cols.intra) {
    cells.push(
      `<td></td><td class="rgt">${num(t.cgst)}</td><td></td><td class="rgt">${num(t.sgst)}</td>`
    );
  } else {
    cells.push(`<td></td><td class="rgt">${num(t.igst)}</td>`);
  }
  cells.push(`<td class="rgt grand">${num(t.taxableValue.plus(t.totalGst))}</td>`);
  return `<tr class="total-row">${cells.join("")}</tr>`;
}

// --- GST summary box -------------------------------------------------------
// Every tax type in one grid, zeros where not applicable, so the reader can
// see at a glance which regime applied rather than noticing which columns are
// missing. Widths from invoice_pdf.py's _summary_table.

function gstSummaryHtml(model: InvoiceModel): string {
  const zero = new Decimal(0);
  interface Row {
    hsn: string;
    taxable: Decimal;
    rate: Decimal;
    cgst: Decimal;
    sgst: Decimal;
    igst: Decimal;
  }
  const groups = new Map<string, Row>();
  for (const l of model.lines) {
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
  const rows = [...groups.values()].sort(
    (a, b) => a.hsn.localeCompare(b.hsn) || a.rate.comparedTo(b.rate)
  );
  const sum = (pick: (r: Row) => Decimal) =>
    rows.reduce((acc, r) => acc.plus(pick(r)), zero);

  const widths = [62, 88, 26, 40, 26, 40, 26, 40]; // Taxable Value absorbs the rounding to SUMMARY_W
  const wPct = (pt: number) => `${((pt / 344) * 100).toFixed(3)}%`;
  const half = (r: Row) => num(r.rate.dividedBy(2));

  const dataRows = rows
    .map((r) => {
      const cg = model.intraState
        ? [half(r), num(r.cgst)]
        : ["0%", "0.00"];
      const sg = model.intraState
        ? [half(r), num(r.sgst)]
        : ["0%", "0.00"];
      const ig = model.intraState
        ? ["0%", "0.00"]
        : [num1(r.rate), num(r.igst)];
      return `<tr><td>${esc(r.hsn)}</td><td class="rgt">${num(r.taxable)}</td>` +
        `<td class="rgt">${cg[0]}</td><td class="rgt">${cg[1]}</td>` +
        `<td class="rgt">${sg[0]}</td><td class="rgt">${sg[1]}</td>` +
        `<td class="rgt">${ig[0]}</td><td class="rgt">${ig[1]}</td></tr>`;
    })
    .join("");

  return `<div class="gst-box"><table class="gst-table"><colgroup>${widths
    .map((w) => `<col style="width:${wPct(w)}" />`)
    .join("")}</colgroup>
    <thead>
      <tr><th class="title" colspan="8">GST Summary</th></tr>
      <tr>
        <th rowspan="2">HSN/SAC</th>
        <th rowspan="2">Taxable<br />Value</th>
        <th colspan="2" class="grp">CGST</th>
        <th colspan="2" class="grp">SGST/UGST</th>
        <th colspan="2" class="grp">IGST</th>
      </tr>
      <tr><th>Rate</th><th>Amt</th><th>Rate</th><th>Amt</th><th>Rate</th><th>Amt</th></tr>
    </thead>
    <tbody>${dataRows}</tbody>
    <tfoot><tr>
      <td>Total</td>
      <td class="rgt">${num(sum((r) => r.taxable))}</td>
      <td></td><td class="rgt">${num(sum((r) => r.cgst))}</td>
      <td></td><td class="rgt">${num(sum((r) => r.sgst))}</td>
      <td></td><td class="rgt">${num(sum((r) => r.igst))}</td>
    </tr></tfoot>
  </table></div>`;
}

// --- Amounts box -----------------------------------------------------------
// A running statement, top to bottom: the pre-discount total, what the
// discount gives away, the taxable value that remains, tax, round off, and
// the grand total they all add up to.

function amountsBoxHtml(model: InvoiceModel): string {
  const t = model.totals;
  const rows: Array<[string, string, boolean]> = [];
  if (t.discount.greaterThan(0)) {
    rows.push(["Total Amount", num(t.grossPreTax), false]);
    rows.push(["Discount", `-${num(t.discount)}`, false]);
  }
  rows.push(["Taxable Amount", num(t.taxableValue), false]);
  rows.push(["Total Tax", num(t.totalGst), false]);
  if (!t.roundOff.isZero()) {
    rows.push(["Round Off", num(t.roundOff), false]);
  }
  rows.push(["Grand Total", `₹ ${num(t.grandTotal)}`, true]);
  return `<div class="amt-box">${rows
    .map(
      ([label, value, strong]) =>
        `<div class="amt-row${strong ? " strong" : ""}"><span class="lbl">${esc(
          label
        )}</span><span class="val">${esc(value)}</span></div>`
    )
    .join("")}</div>`;
}

// --- Totals block ----------------------------------------------------------

function totalsHtml(model: InvoiceModel): string {
  const t = model.totals;
  // Tally lower-cases "paise" here but not in the amount-chargeable line.
  const taxWords = rupeesInWords(t.totalGst).replace(/ Paise Only$/, " paise Only");
  const signature = seller.signaturePath
    ? `<img class="signature-img" src="${assetDataUri(seller.signaturePath)}" alt="" />`
    : "";
  // "This is a Computer Generated Invoice" is printed by the doc-foot below.
  const extraTerms = seller.terms.filter((x) => !/computer[- ]generated/i.test(x));
  return `<div class="totals">
    <div class="words-head"><span class="lbl">Amount Chargeable (in words)</span><span class="eoe">E. &amp; O.E</span></div>
    <div class="words-amt">${esc(model.amountInWords)}</div>
    <div class="rule"></div>
    <div class="sum-row">${gstSummaryHtml(model)}${amountsBoxHtml(model)}</div>
    <div class="tax-words"><span>Tax Amount (in words) :&nbsp;</span><b>${esc(taxWords)}</b></div>
    <div class="rule"></div>
    <table class="decl-box"><tbody><tr>
      <td class="decl-left">
        <p class="decl-title">Declaration</p>
        <p class="decl-text">${esc(seller.declaration)}</p>
        ${extraTerms.map((x) => `<p class="decl-text">${esc(x)}</p>`).join("")}
      </td>
      <td class="sign-cell">
        <div class="sign-inner">
          <div class="for-name">for ${esc(seller.companyName || seller.legalName)}</div>
          <div class="sign-space">${signature}</div>
          <div class="sign-label">Authorised Signatory</div>
        </div>
      </td>
    </tr></tbody></table>
    <div class="doc-foot">This is a Computer Generated Invoice</div>
  </div>`;
}

// --- Stage 1: natural-flow sheet (for measurement) -------------------------

interface Prepared {
  model: InvoiceModel;
  meta: InvoiceMeta;
  cols: GoodsCols;
  uris: Map<string, string>;
  withLogo: boolean;
}

function prepare(model: InvoiceModel, meta: InvoiceMeta, uris: Map<string, string>, withLogo: boolean): Prepared {
  const showImages = model.lines.some((l) => l.imageUrl && uris.get(l.imageUrl));
  const disc = model.lines.some((l) => l.unit !== "" && l.discount.greaterThan(0));
  return { model, meta, cols: goodsCols(showImages, model.intraState, disc), uris, withLogo };
}

function stage1SheetHtml(p: Prepared): string {
  const rowsHtml = p.model.lines.map((l, i) =>
    lineRowHtml(p.cols, l, i + 1, p.uris.get(l.imageUrl) || "")
  );
  return `<div class="sheet">${frameHtml(p.model, p.meta, p.withLogo)}${itemsTableHtml(
    p.cols,
    rowsHtml,
    0,
    totalRowHtml(p.model, p.cols)
  )}${totalsHtml(p.model)}<div class="page-foot"></div></div>`;
}

// --- Stage 2: paginated sheets ---------------------------------------------

// Geometry constants, in px. STRIP_H and CONT_H must match .cont-strip /
// .cont-row heights in template.ts; FOOTER_RESERVE leaves room under the band
// for the absolute-positioned page footer.
const STRIP_H = 20;
const CONT_H = 19;
const FOOTER_RESERVE = 20;
const SAFETY = 2; // keep a computed filler from overflowing onto a blank page

interface SheetMeasure {
  head: number;
  thead: number;
  rows: number[];
  totalRow: number;
  totals: number;
  height: number;
}

// How many product rows go on each page. The last page has to hold the totals
// block as well, which needs `reserve` px; earlier pages fill against the
// continuation floor. Direct port of invoice_pdf.py's _split_pages, including
// the hand-forward rule that keeps a nearly-empty final page from standing
// alone with one row.
function paginateSheet(m: SheetMeasure): number[] {
  const n = m.rows.length;
  if (n === 0) return [0];
  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
  const floor = m.height - FOOTER_RESERVE;
  const reserve = m.totals + m.totalRow;

  const pages: number[] = [];
  let i = 0;
  while (i < n) {
    // Rows start below the page head (or continuation strip) AND the goods
    // table's own two-level header, which reprints on every page.
    const top = (pages.length === 0 ? m.head : STRIP_H) + m.thead;

    // Everything that is left, plus the totals, on this page?
    if (top + sum(m.rows.slice(i)) + reserve <= floor) {
      pages.push(n - i);
      return pages;
    }

    // Otherwise fill downward against the continuation floor.
    let y = top;
    let count = 0;
    while (i + count < n && y + m.rows[i + count] <= floor - CONT_H) {
      y += m.rows[i + count];
      count += 1;
    }

    if (i + count >= n) {
      // This fill would swallow the final row while leaving no room for the
      // totals. Hand rows forward so the next page carries them together.
      while (count > 0 && top + sum(m.rows.slice(i, i + count)) + reserve > floor) {
        count -= 1;
      }
    }

    count = Math.max(count, 1); // always make progress
    pages.push(count);
    i += count;
  }

  // Rows all placed but the totals still did not fit: they take a page alone.
  pages.push(0);
  return pages;
}

function continuationStripHtml(meta: InvoiceMeta): string {
  const bits = [seller.companyName || seller.legalName, `Invoice No. ${meta.invoiceNo}`];
  if (meta.invoiceDate) bits.push(`dated ${tallyDate(meta.invoiceDate)}`);
  return `<div class="cont-strip"><span class="t">Tax Invoice</span><span class="m">${esc(
    bits.filter(Boolean).join("   |   ")
  )}</span></div>`;
}

function paginatedSheetsHtml(p: Prepared, m: SheetMeasure): string {
  const slices = paginateSheet(m);
  const floor = m.height - FOOTER_RESERVE;
  const headHtml = frameHtml(p.model, p.meta, p.withLogo);
  const stripHtml = continuationStripHtml(p.meta);
  const rowsHtml = p.model.lines.map((l, i) =>
    lineRowHtml(p.cols, l, i + 1, p.uris.get(l.imageUrl) || "")
  );
  const pageCount = slices.length;

  const pages: string[] = [];
  let idx = 0;
  for (let page = 0; page < pageCount; page++) {
    const count = slices[page];
    const last = page === pageCount - 1;
    const rowsSlice = rowsHtml.slice(idx, idx + count);
    const rowsH = m.rows.slice(idx, idx + count).reduce((a, b) => a + b, 0);
    idx += count;

    const topOffset = page === 0 ? m.head : STRIP_H;
    const used = topOffset + m.thead + rowsH;
    let filler: number;
    let tail: string;
    if (!last) {
      filler = Math.max(0, floor - used - CONT_H - SAFETY);
      tail = contRowHtml(p.cols);
    } else {
      filler = Math.max(0, floor - used - m.totalRow - m.totals - SAFETY);
      tail = totalRowHtml(p.model, p.cols);
    }
    pages.push(
      `<div class="sheet">${page === 0 ? headHtml : stripHtml}${itemsTableHtml(
        p.cols,
        rowsSlice,
        filler,
        tail
      )}${last ? totalsHtml(p.model) : ""}<div class="page-foot">Page ${
        page + 1
      } of ${pageCount}</div></div>`
    );
  }
  return pages.join("\n");
}

// --- Rendering pipeline ----------------------------------------------------

function shell(title: string, body: string): string {
  // Function replacers: a `$&`-style sequence inside a product name or the CSS
  // must not be interpreted as a replacement reference.
  return SHELL.replace("{{TITLE}}", () => esc(title))
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

// Errors thrown when the browser process is already dead (crashed, OOM-killed).
const BROWSER_DEAD_RE =
  /Protocol error|Target closed|browser has been closed|Connection closed|Session closed|detached/i;

// Run a render against a fresh page, retrying once on browser death. The
// cached browserPromise would otherwise hand back a dead browser forever
// after a crash/OOM kill, making every later PDF request fail with
// "Protocol error: Connection closed."
async function withBrowserPage<T>(render: (page: Page) => Promise<T>): Promise<T> {
  const run = async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      return await render(page);
    } finally {
      await page.close().catch(() => {});
    }
  };
  try {
    return await run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!BROWSER_DEAD_RE.test(msg)) throw err;
    // Kill the corpse and relaunch. A cached promise may still resolve later;
    // that browser is closed best-effort too.
    const stalePromise = browserPromise;
    browserPromise = null;
    stalePromise
      ?.then((b) => b.close())
      .catch(() => {});
    return await run();
  }
}

// Measure fallback when a stage-1 sheet is missing from the measurement pass.
const EMPTY_MEASURE: SheetMeasure = {
  head: 0, thead: 0, rows: [], totalRow: 0, totals: 0,
  height: 1046,
};

interface RenderedDocuments {
  pdf: Uint8Array;
  // Pages each invoice occupies in the merged PDF, in input order. Lets a
  // caller interleave the retail pages with other PDFs (e.g. wholesale
  // uploads) in series order via pdf-lib.
  pageCounts: number[];
}

async function renderDocuments(
  invoices: Array<{ model: InvoiceModel; meta: InvoiceMeta }>
): Promise<RenderedDocuments> {
  // Thumbnails first: both render passes must see identical content.
  const urls = new Set<string>();
  for (const { model } of invoices) {
    for (const l of model.lines) if (l.imageUrl) urls.add(l.imageUrl);
  }
  const uris = new Map<string, string>();
  for (const url of urls) {
    const uri = await inlineImage(url);
    if (uri) uris.set(url, uri);
  }
  const withLogo = !!logoUri();

  const prepared = invoices.map(({ model, meta }) =>
    prepare(model, meta, uris, withLogo)
  );

  return withBrowserPage(async (page) => {
    await page.setViewport({ width: 1100, height: 1600 });
    // Pass 1: natural flow, measured but not paginated.
    await page.setContent(
      shell("Invoices", prepared.map(stage1SheetHtml).join("\n")),
      { waitUntil: "networkidle0" }
    );
    const measures: SheetMeasure[] = await page.evaluate(`(() => {
      const h = (el) => (el ? el.getBoundingClientRect().height : 0);
      return Array.from(document.querySelectorAll(".sheet")).map((sheet) => ({
        head: h(sheet.querySelector(".head")),
        thead: h(sheet.querySelector(".items thead")),
        rows: Array.from(sheet.querySelectorAll(".items tr.item-row")).map(h),
        totalRow: h(sheet.querySelector(".items tr.total-row")),
        totals: h(sheet.querySelector(".totals")),
        height: sheet.getBoundingClientRect().height,
      }));
    })()`) as SheetMeasure[];

    // Pass 2: fixed-height sheets, one per printed page. paginatedSheetsHtml
    // re-runs the same pagination on the same measures, so the page counts
    // reported here match the printed "Page x of y" footers exactly.
    const pageCounts = prepared.map((p, i) =>
      paginateSheet(measures[i] || EMPTY_MEASURE).length
    );
    const stage2 = prepared
      .map((p, i) => paginatedSheetsHtml(p, measures[i] || EMPTY_MEASURE))
      .join("\n");
    await page.setContent(
      shell(
        invoices.length === 1
          ? `${invoices[0].meta.invoiceNo} — ${seller.legalName}`
          : `Invoices (${invoices.length}) — ${seller.legalName}`,
        stage2
      ),
      { waitUntil: "networkidle0" }
    );
    return await page.pdf({
      format: "A4",
      printBackground: true,
      // The single source of truth for the paper margin — template.ts must not
      // declare one in @page or it would win over this.
      margin: { top: "10mm", bottom: "10mm", left: "13mm", right: "13mm" },
    }).then((pdf) => ({ pdf, pageCounts }));
  });
}

// Render the model to a PDF (Uint8Array). `meta` = { invoiceNo, invoiceDate }.
export async function renderInvoicePdf(
  model: InvoiceModel,
  meta: InvoiceMeta
): Promise<Uint8Array> {
  return (await renderDocuments([{ model, meta }])).pdf;
}

export interface MergedInvoiceItem {
  model: InvoiceModel;
  meta: InvoiceMeta;
}

// Render many invoices into a single merged PDF (one Puppeteer pass), each
// invoice paginated and page-numbered independently.
export async function renderMergedInvoicesPdf(
  items: MergedInvoiceItem[]
): Promise<Uint8Array> {
  return (await renderDocuments(items)).pdf;
}

// Same as renderMergedInvoicesPdf, but also reports how many pages each
// invoice contributed, so the caller can splice other PDFs in between.
export async function renderMergedInvoicesWithPages(
  items: MergedInvoiceItem[]
): Promise<RenderedDocuments> {
  return renderDocuments(items);
}

// --- Return bookkeeping notes ---------------------------------------------

export interface BkNoteItem {
  orderName: string;
  orderDate: string;
  invoiceNo: string;
  customerName: string;
  // Kept goods + fee lines, pre-formatted ("Mastaani … ₹2,499.00").
  itemLines: Array<{ label: string; amount: string }>;
  paidAmount: string; // cash collected (Shopify current total)
  invoiceTotal: string; // reissued invoice grand total
  totalGst: string;
  creditOwed: string; // paid − invoice total (store credit payable)
  refunded: boolean; // Shopify recorded a refund transaction
}

// One page per note, natural A4 flow — simple document, no invoice-style
// pagination. Printed for the accountant so every closed return carries its
// voucher: Dr cash / Cr invoice / Cr store credit payable.
export async function renderNotesPdf(
  periodLabel: string,
  notes: BkNoteItem[]
): Promise<Uint8Array> {
  const sections = notes
    .map((n) => {
      const refundNote = n.refunded
        ? "Shopify recorded a refund — reconcile the cash refund before booking store credit."
        : "No refund transaction recorded in Shopify (store credit issued outside Shopify). Confirm the credit issued matches the figure above and adjust it in Shopify if it doesn't.";
      return `
      <section class="note">
        <h2>Order ${esc(n.orderName)} — ${esc(n.invoiceNo)}</h2>
        <table class="meta">
          <tr><th>Order date</th><td>${esc(n.orderDate)}</td></tr>
          <tr><th>Customer</th><td>${esc(n.customerName)}</td></tr>
        </table>
        <table class="lines">
          <thead><tr><th>Kept on invoice (net)</th><th class="amt">Amount</th></tr></thead>
          <tbody>
            ${n.itemLines
              .map(
                (l) =>
                  `<tr><td>${esc(l.label)}</td><td class="amt">${esc(l.amount)}</td></tr>`
              )
              .join("")}
            <tr class="sum"><td>Reissued invoice total (GST incl. ${esc(n.totalGst)})</td><td class="amt">${esc(n.invoiceTotal)}</td></tr>
            <tr><td>Cash collected</td><td class="amt">${esc(n.paidAmount)}</td></tr>
            <tr class="sum"><td>Store credit payable (customer advance)</td><td class="amt">${esc(n.creditOwed)}</td></tr>
          </tbody>
        </table>
        <p class="entry">Journal entry — Dr Cash/Bank ${esc(n.paidAmount)}; Cr Sales + GST + fees (per invoice ${esc(n.invoiceNo)}) ${esc(n.invoiceTotal)}; Cr Store Credit Payable ${esc(n.creditOwed)}.</p>
        <p class="hint">${esc(refundNote)}</p>
      </section>`;
    })
    .join("\n");

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Return bookkeeping notes</title>
  <style>
    body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 11px; margin: 0; }
    h1 { font-size: 16px; margin: 0 0 2px; }
    .period { color: #444; margin: 0 0 14px; }
    section.note { page-break-inside: avoid; border: 1px solid #999; border-radius: 4px; padding: 10px 12px; margin-bottom: 14px; }
    h2 { font-size: 12.5px; margin: 0 0 8px; }
    table { width: 100%; border-collapse: collapse; }
    .meta, .meta td, .meta th { border: none; }
    .meta th { text-align: left; font-weight: normal; color: #555; width: 90px; padding: 1px 0; }
    .meta td { padding: 1px 0; }
    table.lines { margin-top: 8px; }
    table.lines th { text-align: left; border-bottom: 1px solid #333; padding: 3px 4px; font-size: 10.5px; }
    table.lines td { border-bottom: 1px solid #ddd; padding: 3px 4px; }
    .amt { text-align: right; white-space: nowrap; }
    tr.sum td { border-top: 1px solid #333; font-weight: bold; border-bottom: none; }
    p.entry { margin: 8px 0 2px; }
    p.hint { margin: 2px 0 0; color: #8a6d3b; }
  </style></head><body>
  <h1>Return bookkeeping notes — ${esc(seller.legalName)}</h1>
  <p class="period">${esc(periodLabel)}</p>
  ${sections}
  </body></html>`;

  return withBrowserPage(async (page) => {
    await page.setContent(html, { waitUntil: "networkidle0" });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", bottom: "12mm", left: "13mm", right: "13mm" },
    });
  });
}
