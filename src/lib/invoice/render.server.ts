// Builds the invoice HTML from the computed model and renders it to PDF.
// Server-only (drives Chromium via Puppeteer). Import only from Node runtime.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import puppeteer, { type Browser } from "puppeteer";
import Decimal from "decimal.js";
import { seller } from "./config";
import { SHELL, CSS } from "./template";
import type { InvoiceModel, InvoiceLine } from "./calc";
import type { InvoiceAddress, InvoiceOrder } from "../shopify";

export interface InvoiceMeta {
  invoiceNo: string;
  invoiceDate: Date;
}

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const inr = (d: Decimal): string =>
  "₹" +
  d.toNumber().toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

function fmtDate(iso: string | Date): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function addressBlock(a: InvoiceAddress | null): string {
  if (!a) return '<p class="muted">—</p>';
  const parts = [
    a.name,
    a.company,
    a.address1,
    a.address2,
    [a.city, a.province, a.zip].filter(Boolean).join(", "),
    a.country,
    a.phone ? "Ph: " + a.phone : "",
  ].filter(Boolean);
  return parts.map((p) => `<p>${esc(p)}</p>`).join("");
}

function sellerAddressLine(): string {
  const a = seller.address;
  return [a.line1, a.line2, [a.city, a.state, a.pincode].filter(Boolean).join(", "), a.country]
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join("");
}

function itemsTable(model: InvoiceModel): string {
  const { intraState, lines } = model;
  const taxHead = intraState
    ? `<th class="num">CGST</th><th class="num">SGST</th>`
    : `<th class="num">IGST</th>`;

  const rows = lines
    .map((l: InvoiceLine) => {
      const sub = [l.variantTitle, l.sku ? "SKU: " + l.sku : ""]
        .filter(Boolean)
        .map((s) => `<div class="prod-sub">${esc(s)}</div>`)
        .join("");
      const taxCells = intraState
        ? `<td class="num">${inr(l.cgst)}<div class="prod-sub">${l.halfRate}%</div></td>` +
          `<td class="num">${inr(l.sgst)}<div class="prod-sub">${l.halfRate}%</div></td>`
        : `<td class="num">${inr(l.igst)}<div class="prod-sub">${l.rate}%</div></td>`;
      return `
      <tr>
        <td><div class="prod-name">${esc(l.title)}</div>${sub}</td>
        <td class="ctr">${esc(l.hsn) || "—"}</td>
        <td class="ctr">${l.qty}</td>
        <td class="num">${inr(l.unitPricePreTax)}</td>
        <td class="num">${inr(l.discount)}</td>
        <td class="num">${inr(l.taxableValue)}</td>
        ${taxCells}
        <td class="num">${inr(l.lineTotal)}</td>
      </tr>`;
    })
    .join("");

  return `
  <table class="items">
    <thead>
      <tr>
        <th>Item</th>
        <th class="ctr">HSN</th>
        <th class="ctr">Qty</th>
        <th class="num">Unit Price<div class="prod-sub">(pre-tax)</div></th>
        <th class="num">Discount</th>
        <th class="num">Taxable Value</th>
        ${taxHead}
        <th class="num">Total</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function totalsTable(model: InvoiceModel): string {
  const { intraState, totals: t } = model;
  const taxRows = intraState
    ? `<tr><td class="label">CGST</td><td class="val">${inr(t.cgst)}</td></tr>
       <tr><td class="label">SGST</td><td class="val">${inr(t.sgst)}</td></tr>`
    : `<tr><td class="label">IGST</td><td class="val">${inr(t.igst)}</td></tr>`;
  const roundRow = !t.roundOff.isZero()
    ? `<tr><td class="label">Round Off</td><td class="val">${inr(t.roundOff)}</td></tr>`
    : "";
  return `
  <table class="totals">
    <tbody>
      <tr><td class="label">Subtotal (pre-tax)</td><td class="val">${inr(t.grossPreTax)}</td></tr>
      <tr><td class="label">Discount</td><td class="val">${inr(t.discount)}</td></tr>
      <tr class="rule"><td class="label">Taxable Value</td><td class="val">${inr(t.taxableValue)}</td></tr>
      ${taxRows}
      ${roundRow}
      <tr class="grand"><td class="label">Grand Total</td><td class="val">${inr(t.grandTotal)}</td></tr>
    </tbody>
  </table>`;
}

// Inline an asset (absolute or project-relative path) as a base64 data URI.
// Data URIs avoid file:// sub-resource loads, which Chromium blocks when the
// page is rendered via setContent (an about:blank origin). Cached by path +
// mtime so a merged PDF reads each asset once, yet a replaced logo file is
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
  const logo = seller.logoPath
    ? `<img class="logo-img" src="${assetDataUri(seller.logoPath)}" alt="logo" />`
    : `<div class="seller-name">${esc(seller.legalName)}</div>`;

  const signature = seller.signaturePath
    ? `<img class="signature-img" src="${assetDataUri(seller.signaturePath)}" alt="signature" />`
    : "";

  return `
  <div class="section-header">
    <div class="header-row">
      <div class="header-col">${logo}</div>
      <div class="header-col center">
        <div class="title-type">Tax Invoice</div>
        <div class="invoice-no-box">${esc(meta.invoiceNo)}</div>
      </div>
      <div class="header-col right">
        <div class="seller-name">${esc(seller.legalName)}</div>
        ${seller.companyName ? `<p>${esc(seller.companyName)}</p>` : ""}
        ${sellerAddressLine()}
        <p class="b">GSTIN: ${esc(seller.gstin)}</p>
        <p>State: ${esc(seller.address.state)} (${esc(seller.address.stateCode)})</p>
        ${seller.phone ? `<p>Ph: ${esc(seller.phone)}</p>` : ""}
        ${seller.email ? `<p>${esc(seller.email)}</p>` : ""}
      </div>
    </div>
  </div>

  <div class="parties">
    <div class="party-col">
      <div class="section-title">Bill To</div>
      ${addressBlock(o.billingAddress)}
    </div>
    <div class="party-col">
      <div class="section-title">Ship To</div>
      ${addressBlock(o.shippingAddress || o.billingAddress)}
    </div>
    <div class="party-col">
      <div class="section-title">Invoice Details</div>
      <p><span class="b">Invoice No:</span> ${esc(meta.invoiceNo)}</p>
      <p><span class="b">Invoice Date:</span> ${fmtDate(meta.invoiceDate)}</p>
      <p><span class="b">Order:</span> ${esc(o.name)}</p>
      <p><span class="b">Order Date:</span> ${fmtDate(o.createdAt)}</p>
      <p><span class="b">Place of Supply:</span> ${esc(model.placeOfSupply)}</p>
      <p><span class="b">Reverse Charge:</span> No</p>
    </div>
  </div>

  ${itemsTable(model)}

  <div class="footer-row">
    <div class="footer-left">
      <p class="declaration">${esc(seller.declaration)}</p>
      <ul class="terms">${seller.terms.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
    </div>
    <div class="footer-right">
      ${totalsTable(model)}
      <p class="words">${esc(model.amountInWords)}</p>
    </div>
  </div>

  <div class="signature">
    ${signature}
    <p class="signature-caption">For ${esc(seller.legalName)}</p>
    <p class="muted">Authorised Signatory</p>
  </div>`;
}

function watermark(order: InvoiceOrder): string {
  const status = (order.displayFinancialStatus || "").toUpperCase();
  if (status === "PAID") return '<div class="watermark">PAID</div>';
  if (status === "PENDING" || status === "UNPAID")
    return '<div class="watermark">UNPAID</div>';
  return "";
}

export function buildInvoiceHtml(model: InvoiceModel, meta: InvoiceMeta): string {
  return SHELL.replace("{{TITLE}}", esc(`${meta.invoiceNo} — ${seller.legalName}`))
    .replace("{{CSS}}", CSS)
    .replace("{{WATERMARK}}", watermark(model.order))
    .replace("{{BODY}}", buildBody(model, meta));
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
  const html = buildInvoiceHtml(model, meta);
  return renderHtmlToPdf(html);
}

export interface MergedInvoiceItem {
  model: InvoiceModel;
  meta: InvoiceMeta;
}

// One document containing every invoice, one per A4 page (page-break between).
export function buildMergedInvoicesHtml(items: MergedInvoiceItem[]): string {
  const pages = items
    .map(
      ({ model, meta }) =>
        `<div class="page invoice-page">${watermark(model.order)}${buildBody(model, meta)}</div>`
    )
    .join("\n");
  const title = `Invoices (${items.length}) — ${seller.legalName}`;
  const extraCss =
    ".invoice-page { page-break-after: always; } .invoice-page:last-child { page-break-after: auto; }";
  return SHELL.replace("{{TITLE}}", esc(title))
    .replace("{{CSS}}", CSS + extraCss)
    // The shell's single .page wrapper is replaced by our per-invoice pages.
    .replace('<div class="page">', "")
    .replace("{{WATERMARK}}", "")
    .replace("{{BODY}}", pages)
    .replace(/<\/div>\s*<\/body>/, "</body>");
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
      margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" },
    });
  } finally {
    await page.close();
  }
}
