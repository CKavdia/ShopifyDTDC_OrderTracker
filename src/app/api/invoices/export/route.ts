import { NextRequest, NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { getPaidOrdersInRange } from "@/lib/shopify";
import { prepareInvoiceItem } from "@/lib/invoice/generate.server";
import {
  renderMergedInvoicesWithPages,
  type MergedInvoiceItem,
} from "@/lib/invoice/render.server";
import { data } from "@/lib/data";

// Puppeteer needs the Node.js runtime (not Edge).
export const runtime = "nodejs";

// Store timezone (India). Boundaries are interpreted in IST so a day covers the
// full local calendar day.
const TZ_OFFSET = "+05:30";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Download every invoice for paid orders created in [start, end] as one merged
// PDF, minting invoice numbers for any order not yet invoiced. Wholesale
// invoices recorded in the range join the same PDF, spliced into series order
// by invoice number (their PDFs come straight off the Notion row attachments).
// Orders are processed oldest-first and sequentially (respects the numbering
// mutex and Notion/Shopify rate limits), so a large range can take a while.
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const start = searchParams.get("start") || "";
    const end = searchParams.get("end") || "";

    if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
      return NextResponse.json(
        { error: "start and end must be YYYY-MM-DD dates." },
        { status: 400 }
      );
    }
    if (start > end) {
      return NextResponse.json(
        { error: "start date must be on or before end date." },
        { status: 400 }
      );
    }

    const startISO = `${start}T00:00:00${TZ_OFFSET}`;
    const endISO = `${end}T23:59:59${TZ_OFFSET}`;

    const orders = await getPaidOrdersInRange(startISO, endISO);

    // Render already-issued invoices with their real ledger date, not "now".
    const issued = await data.listInvoices();
    const dateByOrderId = new Map(
      issued.map((inv) => [inv.shopifyOrderId, inv.invoiceDate])
    );
    // Current display flag — controls whether COD fee lines are included.
    const hideCodFee = await data.getInvoiceHideCodFee();

    const items: MergedInvoiceItem[] = [];
    for (const order of orders) {
      const shopifyOrderId = String(order.id);
      const storedDate = dateByOrderId.get(shopifyOrderId);
      // Reused -> keep its original invoice date; new -> date it at the sale date.
      const invoiceDate = storedDate
        ? new Date(storedDate)
        : new Date(order.created_at);
      const { model, meta } = await prepareInvoiceItem(shopifyOrderId, {
        invoiceDate,
        hideCodFee,
      });
      items.push({ model, meta });
    }

    // Wholesale invoices in the range (Notion date strings are YYYY-MM-DD, so
    // plain string comparison matches the requested day boundaries).
    const wholesaleRows = issued
      .filter(
        (inv) =>
          inv.type === "wholesale" &&
          inv.invoiceDate >= start &&
          inv.invoiceDate <= end
      )
      .sort((a, b) => a.invoiceNo.localeCompare(b.invoiceNo));

    // Fetch each wholesale row's PDF — ours (re-issued with our UN/FY number)
    // when attached, the seller's original otherwise. One row failing never
    // fails the export; it lands in the skipped list instead.
    const skipped: string[] = [];
    const wholesalePdfs: Array<{ invoiceNo: string; bytes: Buffer }> = [];
    for (const inv of wholesaleRows) {
      const url = inv.pdfUrl || inv.origPdfUrl;
      if (!url) {
        skipped.push(`${inv.invoiceNo} — no PDF attached to the row`);
        continue;
      }
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`status ${res.status}`);
        wholesalePdfs.push({
          invoiceNo: inv.invoiceNo,
          bytes: Buffer.from(await res.arrayBuffer()),
        });
      } catch (err) {
        skipped.push(
          `${inv.invoiceNo} — PDF download failed (${
            err instanceof Error ? err.message : String(err)
          })`
        );
      }
    }

    if (items.length === 0 && wholesalePdfs.length === 0) {
      return NextResponse.json(
        { error: "No invoices found in this date range." },
        { status: 404 }
      );
    }

    // Render the retail side in one Puppeteer pass, then interleave both kinds
    // by invoice number so the merged PDF follows the ledger series.
    let retailPdf: Uint8Array | null = null;
    let pageCounts: number[] = [];
    if (items.length > 0) {
      const rendered = await renderMergedInvoicesWithPages(items);
      retailPdf = rendered.pdf;
      pageCounts = rendered.pageCounts;
    }
    const retailSrc = retailPdf
      ? await PDFDocument.load(retailPdf, { ignoreEncryption: true })
      : null;

    interface Chunk {
      invoiceNo: string;
      // Retail chunk: slice of the rendered retail PDF. Wholesale chunk: its
      // own downloaded PDF.
      startPage?: number;
      count?: number;
      bytes?: Buffer;
    }
    const chunks: Chunk[] = [];
    let page = 0;
    items.forEach((it, i) => {
      const count = pageCounts[i] ?? 1;
      chunks.push({ invoiceNo: it.meta.invoiceNo, startPage: page, count });
      page += count;
    });
    for (const w of wholesalePdfs) {
      chunks.push({ invoiceNo: w.invoiceNo, bytes: w.bytes });
    }
    chunks.sort((a, b) => a.invoiceNo.localeCompare(b.invoiceNo));

    const out = await PDFDocument.create();
    for (const chunk of chunks) {
      if (chunk.bytes) {
        const src = await PDFDocument.load(chunk.bytes, {
          ignoreEncryption: true,
        });
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      } else if (retailSrc) {
        const indices = Array.from(
          { length: chunk.count ?? 0 },
          (_, k) => (chunk.startPage ?? 0) + k
        );
        const pages = await out.copyPages(retailSrc, indices);
        pages.forEach((p) => out.addPage(p));
      }
    }
    const merged = await out.save();
    const filename = `invoices-${start}-to-${end}.pdf`;

    return new NextResponse(Buffer.from(merged), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        // Wholesale rows left out of the PDF, for the UI to surface.
        ...(skipped.length > 0
          ? {
              "X-Skipped-Invoices": encodeURIComponent(skipped.join("; ")),
            }
          : {}),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("Invoice range export failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invoice range export failed" },
      { status: 500 }
    );
  }
}
