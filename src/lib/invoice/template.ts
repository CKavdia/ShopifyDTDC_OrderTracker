// Invoice HTML shell + CSS, inlined as strings so the server never depends on
// reading template files from disk at runtime.
//
// Layout is a faithful port of the CollectionPdfGeneratorTool tax-invoice
// renderer (invoice_pdf.py): the Tally-style ruled document with a party/meta
// header box, a goods table whose tax columns ride on every product line
// (rather than ledger rows below), a GST summary box that always shows all
// three regimes, a running amounts box, and a declaration/signatory footer.
// Sizes are carried over verbatim (FS_TITLE 11, FS_NAME 9, FS_BODY 8,
// FS_HEAD 7.5, FS_LABEL 6.5) — change them only against a side-by-side
// comparison with the Python tool's output.
//
// Column proportions come from invoice_pdf.py's _goods_table / _summary_table,
// emitted as percentages of that module's CONTENT_W (539.28pt) by
// render.server.ts, so the two renderers share one set of numbers.
//
// Pagination is driven by render.server.ts, which measures the natural-flow
// document in the browser and re-emits it as fixed-height `.sheet` divs — one
// per A4 page — with a filler row closing each goods band at the page floor
// and a "Continued ..." row above it, exactly like the ReportLab original.

export const CSS = `
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0; color: #000; background: #fff;
  font-family: Arial, Helvetica, sans-serif;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
p { margin: 0; }
.b { font-weight: bold; }
.ctr { text-align: center; }
.rgt { text-align: right; }

/* One .sheet per printed page. Height equals the A4 content area after the
   pdf() margins (297mm - 2 x 10mm), width the content width (210 - 2 x 13mm).
   render.server.ts fills each sheet exactly; overflow hidden keeps a 1px
   rounding drift from spilling onto a blank page. */
.sheet {
  position: relative; width: 184mm; height: 277mm; overflow: hidden;
  font-size: 8pt; line-height: 1.25; color: #000;
}
.sheet + .sheet { page-break-before: always; }

.doc-title { text-align: center; font-weight: bold; font-size: 11pt; padding-bottom: 4pt; }

/* --- Page footers --------------------------------------------------------- */
.page-foot { position: absolute; right: 0; bottom: 0; font-size: 7pt; color: #444; }
.doc-foot { text-align: center; font-size: 7.5pt; color: #444; padding-top: 5pt; }

/* --- Ruled tables -----------------------------------------------------------
   border-collapse is load-bearing: with the default "separate" value, every
   row carries a 2px border-spacing gap that breaks the continuous verticals
   and drifts the pagination arithmetic by 2px per row. */
.frame, .items, .meta, .gst-table, .decl-box {
  border-collapse: collapse;
}

/* --- Header box: parties (left) + document meta grid (right) --------------- */
.frame { width: 100%; table-layout: fixed; border: 0.5pt solid #000; }
.frame > tbody > tr > td { padding: 0; vertical-align: top; }
.col-parties { width: 58.4%; border-right: 0.5pt solid #000; }
.col-meta { width: 41.6%; }
.blk { padding: 2.5pt 3pt; border-bottom: 0.5pt solid #000; }
.blk:last-child { border-bottom: none; }
.blk-label { font-size: 6.5pt; color: #444; }
.party-name { font-weight: bold; font-size: 9pt; }
/* When the wordmark sits above the seller name, drop the name to body weight —
   two bold renderings of the same words read as a mistake. */
.party-name.demote { font-weight: normal; font-size: 8pt; }
.logo { display: block; height: 17pt; width: auto; margin-bottom: 5pt; }
.kv { display: flex; }
.kv .k { flex: 0 0 66px; }
.kv .v { flex: 1 1 auto; min-width: 0; }

.meta { width: 100%; height: 100%; table-layout: fixed; }
.meta td {
  height: 25pt; padding: 3pt; vertical-align: top;
  border-right: 0.5pt solid #000; border-bottom: 0.5pt solid #000;
}
.meta td:last-child { border-right: none; }
.meta tbody tr:last-child td { border-bottom: none; height: auto; }
.meta .lbl { font-size: 6.5pt; color: #444; }
.meta .val { font-weight: bold; font-size: 8.5pt; }

/* --- Goods table ----------------------------------------------------------- */
.items { width: 100%; table-layout: fixed; border: 0.5pt solid #000; }
.items th, .items td { border-right: 0.5pt solid #000; padding: 3pt; vertical-align: top; }
/* Every header cell — the tall spanned ones included — closes with a rule, so
   a full horizontal line separates the column headers from the data rows. */
.items thead th {
  font-weight: bold; font-size: 7.5pt; text-align: center; vertical-align: bottom;
  border-bottom: 0.5pt solid #000; line-height: 1.15;
}
.items thead th.lft { text-align: left; }
/* The underline beneath the spanned CGST/SGST/IGST group labels only. */
.items thead th.grp { border-bottom: 0.5pt solid #000; }
.desc-name { font-weight: bold; }
.desc-sub { font-size: 7pt; color: #444; padding-left: 8pt; }
.thumb { display: block; height: 30pt; margin: 0 auto; object-fit: contain; }
.items tr.total-row td { border-top: 0.5pt solid #000; border-bottom: 0.5pt solid #000; font-weight: bold; }
.items tr.total-row td.grand { font-size: 8.5pt; }
.items tr.cont-row td { font-style: italic; text-align: right; height: 19px; vertical-align: middle; }
/* Filler rows carry no ink — only the verticals that keep the band ruled
   down to the page floor. */
.items tr.filler td { }

/* --- Totals block ---------------------------------------------------------- */
.words-head { display: flex; justify-content: space-between; padding: 2pt 3pt 0; }
.words-head .lbl { font-size: 6.5pt; color: #444; }
.words-head .eoe { font-size: 6.5pt; color: #444; font-style: italic; }
.words-amt { padding: 1pt 3pt 2pt; font-weight: bold; font-size: 9pt; }
.rule { border-bottom: 0.5pt solid #000; }

.sum-row { display: flex; align-items: flex-start; margin-top: 4pt; }
.gst-box { width: 63.79%; }
.gst-table { width: 100%; table-layout: fixed; border: 0.5pt solid #000; }
.gst-table th, .gst-table td {
  border-right: 0.5pt solid #000; border-bottom: 0.5pt solid #000;
  padding: 1.5pt 2pt; vertical-align: middle;
}
.gst-table tr > :last-child { border-right: none; }
.gst-table thead th { font-size: 6.5pt; text-align: center; font-weight: normal; }
.gst-table tbody td { font-size: 7.5pt; }
.gst-table .title { font-size: 8pt; font-weight: bold; text-align: left; height: 13pt; }
.gst-table .grp { text-align: center; }
.gst-table tfoot td { font-weight: bold; font-size: 7.5pt; }
.amt-box { flex: 1 1 auto; margin-left: 1.85%; border: 0.5pt solid #000; padding: 1pt 3pt; }
.amt-row { display: flex; justify-content: space-between; align-items: center; height: 15pt; }
.amt-row .lbl { padding-right: 4pt; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.amt-row .val { font-weight: bold; white-space: nowrap; }
.amt-row.strong { border-top: 0.5pt solid #000; font-size: 9pt; }
.amt-row.strong .lbl { font-weight: bold; }

.tax-words { display: flex; padding: 3pt 3pt 1pt; font-size: 6.5pt; color: #444; }
.tax-words b { color: #000; font-size: 8.5pt; font-weight: bold; }

.decl-box { width: 100%; table-layout: fixed; border: 0.5pt solid #000; }
.decl-box td { vertical-align: top; padding: 2.5pt 3pt; }
.decl-left { width: 55.63%; border-right: 0.5pt solid #000; }
.decl-title { font-size: 6.5pt; color: #444; }
.decl-text { font-size: 7.5pt; }
.sign-cell { text-align: right; }
.sign-inner { height: 52pt; display: flex; flex-direction: column; align-items: flex-end; }
.for-name { font-weight: bold; }
.sign-space { flex: 1 1 auto; display: flex; align-items: center; }
.signature-img { max-height: 42px; max-width: 150px; }
.sign-label { font-size: 7.5pt; color: #444; }

/* --- Continuation strip (pages 2+) ---------------------------------------- */
.cont-strip {
  height: 20px; display: flex; justify-content: space-between; align-items: baseline;
  border-bottom: 0.5pt solid #000;
}
.cont-strip .t { font-weight: bold; font-size: 9pt; }
.cont-strip .m { font-size: 8pt; color: #444; }

/* Page size only — deliberately no margin here. A margin declared in @page
   would override the one Puppeteer passes to page.pdf(), so the paper margin
   is owned solely by render.server.ts and stays consistent on every page of a
   merged export. */
@page { size: A4; }
`;

export const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>{{TITLE}}</title>
  <style>{{CSS}}</style>
</head>
<body>
  {{BODY}}
</body>
</html>`;
