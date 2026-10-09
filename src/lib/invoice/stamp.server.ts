// Stamp our own invoice number over the original's in an uploaded wholesale
// PDF. Wholesale invoices are issued outside this tool; GST filing needs the
// number printed on the invoice to match the number in the filed series, so
// the seller-software number is whited out and our UN/FY number drawn in its
// place. Everything else on the page is untouched — the PDF stays byte-for-byte
// the seller's document except for that one line of text.
//
// Positions come from pdfjs text items (PDF user space, bottom-left origin —
// the same coordinates pdf-lib draws in), the overlay from pdf-lib's standard
// Helvetica Bold, which is visually close enough at the 7–9pt sizes involved.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import path from "path";
import { pathToFileURL } from "url";

// Next.js bundles pdfjs in a chunk where its dynamic worker import can't be
// resolved, so point it at the real file on disk before first use (same trick
// as parse.ts). Node needs the legacy build.
let pdfjsMod: typeof import("pdfjs-dist/legacy/build/pdf.mjs") | null = null;
async function getPdfjs() {
  if (!pdfjsMod) {
    pdfjsMod = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsMod.GlobalWorkerOptions.workerSrc = pathToFileURL(
      path.join(
        process.cwd(),
        "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"
      )
    ).href;
  }
  return pdfjsMod;
}

interface Hit {
  pageIndex: number;
  x: number;
  y: number; // baseline
  width: number;
  height: number; // font size in user space
}

export interface StampResult {
  bytes: Buffer;
  replaced: number;
}

export async function stampInvoiceNumber(
  pdf: Buffer,
  originalNo: string,
  newNo: string
): Promise<StampResult> {
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf) }).promise;

  const hits: Hit[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    // scale 1 keeps item coordinates in PDF user space.
    page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    for (const item of tc.items as Array<{
      str: string;
      transform: number[];
      width: number;
      height: number;
    }>) {
      const str = item.str.trim();
      if (!str || !str.includes(originalNo)) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      if (str === originalNo) {
        hits.push({ pageIndex: p - 1, x, y, width: item.width, height: item.height });
      } else {
        // Number embedded in a longer run — approximate the span
        // proportionally by character count.
        const idx = str.indexOf(originalNo);
        const start = (idx / str.length) * item.width;
        const width = (originalNo.length / str.length) * item.width;
        hits.push({ pageIndex: p - 1, x: x + start, y, width, height: item.height });
      }
    }
  }
  if (hits.length === 0) {
    throw new Error(
      "Could not locate the original invoice number in the PDF — nothing was stamped."
    );
  }

  const out = await PDFDocument.load(pdf, { ignoreEncryption: true });
  const font = await out.embedFont(StandardFonts.HelveticaBold);
  const pages = out.getPages();

  for (const hit of hits) {
    const page = pages[hit.pageIndex];
    if (!page) continue;
    // The new number is usually longer than the original (UN/FY/NNNNN vs a
    // software serial). Shrink only if it would run ~60pt past the original
    // span — enough slack to reach the next column, never into it.
    let size = hit.height;
    let width = font.widthOfTextAtSize(newNo, size);
    const maxW = hit.width + 60;
    if (width > maxW) {
      size = (size * maxW) / width;
      width = maxW;
    }
    page.drawRectangle({
      x: hit.x - 1,
      y: hit.y - size * 0.22,
      width: Math.min(hit.width, font.widthOfTextAtSize(originalNo, size)) + 2,
      height: size * 1.35,
      color: rgb(1, 1, 1),
    });
    page.drawText(newNo, {
      x: hit.x,
      y: hit.y,
      size,
      font,
      color: rgb(0, 0, 0),
    });
  }

  return { bytes: Buffer.from(await out.save()), replaced: hits.length };
}