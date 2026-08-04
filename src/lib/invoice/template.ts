// Invoice HTML shell + CSS, inlined as strings so the server never depends on
// reading template files from disk at runtime.
//
// Layout is a faithful reproduction of the TallyPrime "Tax Invoice" print
// format: one hairline-ruled box, no colour, no logo, Arial throughout. The
// column proportions were measured off a reference Tally invoice, so change
// them only against a fresh visual comparison.
//
// The five stacked tables (frame / items / words / hsn / foot) read as a single
// box because each one drops its top border and merges with the bottom border
// of the table above it. Outer cell borders are left to collapse against each
// table's own border, so no cell needs a first/last-child override.

export const CSS = `
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0; color: #000; background: #fff;
  font-family: Arial, Helvetica, sans-serif;
  font-size: 10.5px; line-height: 1.28;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.page { position: relative; }
p { margin: 0; }
.b { font-weight: bold; }
.r { text-align: right; }
.c { text-align: center; }
.mini { font-size: 9.5px; }

.doc-title { text-align: center; font-weight: bold; font-size: 13px; padding: 0 0 3px; }
.doc-foot { text-align: center; font-size: 10.5px; padding-top: 5px; }

table { border-collapse: collapse; table-layout: fixed; width: 100%; }
td, th { padding: 1px 4px; vertical-align: top; font-weight: normal; }

.frame, .items, .words, .hsn, .foot { border: 1px solid #000; }
.items, .words, .hsn, .foot { border-top: none; }

/* --- Header: parties (left) + document meta grid (right) --- */
.frame > tbody > tr > td { padding: 0; vertical-align: top; }
.col-parties { width: 50%; border-right: 1px solid #000; }
.blk { padding: 2px 5px 3px; border-bottom: 1px solid #000; }
.blk:last-child { border-bottom: none; }
.party-name { font-weight: bold; }
.kv { display: flex; }
.kv .k { flex: 0 0 78px; }
.kv .v { flex: 1 1 auto; }

/* Nested table, so its edges must not double up against the frame's. */
.meta { height: 100%; }
.meta td { border-right: 1px solid #000; border-bottom: 1px solid #000; height: 32px; }
.meta td:last-child { border-right: none; }
.meta tr:last-child td { border-bottom: none; height: 100%; }
.meta .val { font-weight: bold; }

/* --- Items --- */
.items thead th { border-right: 1px solid #000; border-bottom: 1px solid #000;
  text-align: center; vertical-align: bottom; }
.items thead th.h-sl { text-align: left; vertical-align: top; line-height: 1.05; }
.items td { border-right: 1px solid #000; }
.items .desc { font-weight: bold; }
.items .desc .sub-note { font-weight: normal; }
.items .ledger { text-align: right; font-weight: bold; font-style: italic; }
.items .sub td { padding-top: 6px; }
.items .sub .amt { border-top: 1px solid #000; }
.items tbody tr:first-child td { padding-top: 6px; }
.items tfoot td { border-top: 1px solid #000; font-weight: bold; }
/* Tally prints the "Total" caption itself in regular weight. */
.items tfoot .total-label { font-weight: normal; }
.items tfoot .grand { font-size: 12px; }

.c-sl    { width: 3%; }
.c-desc  { width: 47%; }
.c-hsn   { width: 10%; }
.c-qty   { width: 10.5%; }
.c-rate  { width: 9.5%; }
.c-per   { width: 4.5%; }
.c-amt   { width: 15.5%; }

/* --- Amount in words --- */
.words .eoe { font-style: italic; text-align: right; }
.words-amt { font-size: 11.5px; }

/* --- HSN / tax summary --- */
.hsn th { border: 1px solid #000; border-top: none; text-align: center; }
.hsn td { border: 1px solid #000; text-align: right; }
.hsn td.code { text-align: left; }
.hsn tfoot td { font-weight: bold; }

.h-hsn   { width: 42%; }
.h-tax   { width: 9.5%; }
.h-rate  { width: 8%; }
.h-amt   { width: 10.5%; }
.h-rate2 { width: 7.5%; }
.h-amt2  { width: 11%; }
.h-tot   { width: 11.5%; }

/* --- Footer: tax in words, PAN, declaration, signature --- */
.foot .pad { padding: 2px 5px; }
.foot .rule td { border-bottom: 1px solid #000; }
.foot .decl { width: 50%; border-right: 1px solid #000; padding: 2px 5px 4px; }
.foot .sign { padding: 2px 5px 4px; text-align: right; }
.foot .sign-space { height: 46px; }
.kv .foot-k { flex-basis: 118px; }
.decl-title { text-decoration: underline; }
.signature-img { max-height: 42px; max-width: 150px; }

/* When an invoice runs past one page, these blocks move whole rather than
   tearing in half — a declaration split across the break reads as a defect. */
.frame, .words, .hsn, .foot { page-break-inside: avoid; break-inside: avoid; }
.items tr { page-break-inside: avoid; break-inside: avoid; }
.items thead { display: table-header-group; }

/* Page size only — deliberately no margin here. A margin declared in @page
   overrides the one Puppeteer passes to page.pdf(), so the paper margin is
   owned solely by render.server.ts and stays consistent on every page of a
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
  <div class="page">
    {{BODY}}
  </div>
</body>
</html>`;
